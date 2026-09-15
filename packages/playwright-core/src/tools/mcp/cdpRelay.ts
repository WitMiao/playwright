/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * WebSocket server that bridges Playwright MCP and Chrome Extension.
 *
 * Endpoints:
 * - /cdp/guid - Full CDP interface for Playwright MCP
 * - /extension/guid - Extension connection
 * - /invites - Discovery endpoint (HTTP GET, polled): the extension's
 *   background service worker scans a fixed port range on 127.0.0.1 for
 *   pending connection invites, so no URL has to be passed on the Chrome
 *   command line (that would open a foreground tab and steal focus from the
 *   user).
 *
 * The protocol version advertised to the extension can be overridden with the
 * PWTEST_EXTENSION_PROTOCOL env variable, and the connection timeout with
 * PWTEST_EXTENSION_CONNECT_TIMEOUT (both used in tests).
 */

import { spawn } from 'child_process';
import os from 'os';
import path from 'path';

import debug from 'debug';
import ws from 'ws';
import { ManualPromise } from '@isomorphic/manualPromise';
import { monotonicTime } from '@isomorphic/time';
import { raceAgainstDeadline } from '@isomorphic/timeoutRunner';
import { WSServer } from '@utils/wsServer';
import { registry } from '../../server/registry/index';

import { playwrightExtensionId } from '../utils/extension';
import { logUnhandledError } from './log';
import { ExtensionProtocolV2 } from './cdpRelayV2';
import * as protocol from './protocol';

import type websocket from 'ws';
import type http from 'http';
import type { ExtensionCommandV2, ExtensionEventsV2 } from './protocol';
import type { CDPMessage } from './browserModel';
import type { WebSocket } from 'ws';


const debugLogger = debug('pw:mcp:relay');

async function listenOnFreePort(wsServer: WSServer, portBase: number, portCount: number): Promise<string> {
  let lastError: Error | undefined;
  for (let port = portBase; port < portBase + portCount; port++) {
    try {
      return await wsServer.listen(port, '127.0.0.1', '');
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`No free port for the extension relay in range ${portBase}..${portBase + portCount - 1}: ${lastError?.message}`);
}

// Whether a browser with this executable name is already running. Used to
// avoid spawning the browser a second time: launching it while it runs would
// open a new window and steal focus.
async function isBrowserProcessRunning(processName: string): Promise<boolean> {
  try {
    if (os.platform() === 'win32') {
      const output = await execFileOutput('tasklist', ['/NH', '/FO', 'CSV', '/FI', `IMAGENAME eq ${processName}`]);
      return output.toLowerCase().includes(processName.toLowerCase());
    }
    // pgrep -f matches the full command line: stable Chrome on macOS ships as
    // ".../Google Chrome.app/Contents/MacOS/Google Chrome", so a plain -x name
    // match would miss it.
    await execFileOutput('pgrep', ['-f', processName]);
    return true;
  } catch {
    return false;
  }
}

function execFileOutput(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    child.stdout?.on('data', data => output += data.toString());
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0)
        resolve(output);
      else
        reject(new Error(`"${file}" exited with code ${code}`));
    });
  });
}

const extensionConnectionTimeout = +(process.env.PWTEST_EXTENSION_CONNECT_TIMEOUT ?? 90_000);

// The extension's background service worker discovers the relay by scanning
// this fixed port range on 127.0.0.1 (see
// packages/extension/src/relayDiscovery.ts — keep the two in sync). The range
// is deliberately not configurable: the extension cannot read process env, so
// both sides must agree on it in code.
const extensionInvitePortBase = 7317;
const extensionInvitePortCount = 32;
const extensionInvitesPathname = '/invites';

type CDPCommand = {
  id: number;
  sessionId?: string;
  method: string;
  params?: any;
};

type CDPResponse = CDPMessage;

export class CDPRelayServer {
  private _wsServer: WSServer;
  private _wsHost!: string;
  private _browserChannel: string;
  private _taskId: string;
  private _connectionId: string;
  private _executablePath?: string;
  private _customUserDataDir?: string;
  private _profileDirectory?: string;
  private _cdpPath: string;
  private _extensionPath: string;
  private _cdpConnection: WebSocket | null = null;
  private _extensionConnection: ExtensionConnection | null = null;
  private _protocolVersion: number;
  private _token?: string;
  private _clientName = 'Playwright MCP';
  private _handler: ExtensionProtocolV2;
  private _extensionConnectionPromise = new ManualPromise<void>();

  constructor(browserChannel: string, executablePath?: string, customUserDataDir?: string, profileDirectory?: string, taskId = 'Playwright MCP') {
    this._browserChannel = browserChannel;
    this._taskId = taskId;
    this._executablePath = executablePath;
    this._customUserDataDir = customUserDataDir;
    this._profileDirectory = profileDirectory;
    this._protocolVersion = parseInt(process.env.PWTEST_EXTENSION_PROTOCOL ?? protocol.VERSION.toString(), 10);
    this._token = process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;

    const sendCommand = (method: string, params: any): Promise<any> => {
      if (!this._extensionConnection)
        throw new Error('Extension not connected');
      return this._extensionConnection.send(method as keyof ExtensionCommandV2, params);
    };
    this._handler = new ExtensionProtocolV2(sendCommand);

    this._connectionId = crypto.randomUUID();
    this._cdpPath = `/cdp/${this._connectionId}`;
    this._extensionPath = `/extension/${this._connectionId}`;

    void this._extensionConnectionPromise.catch(logUnhandledError);
    this._wsServer = new WSServer({
      onRequest: (request, response) => {
        if (new URL('http://localhost' + (request.url || '')).pathname === extensionInvitesPathname) {
          this._handleInviteRequest(request, response);
          return;
        }
        response.statusCode = 404;
        response.end();
      },
      onHeaders: () => {},
      onUpgrade: () => undefined,
      isAllowedPathname: pathname => pathname === this._cdpPath || pathname === this._extensionPath || pathname === extensionInvitesPathname,
      onConnection: (request, url, ws) => {
        debugLogger(`New connection to ${url.pathname}`);
        if (url.pathname === this._cdpPath)
          this._handlePlaywrightConnection(ws);
        else if (url.pathname === extensionInvitesPathname)
          this._handleInviteConnection(request, ws);
        else
          this._handleExtensionConnection(ws);
        return undefined;
      },
    });
  }

  async start(): Promise<void> {
    // Bind to the explicit loopback address so the extension's discovery scan
    // (127.0.0.1) always matches the advertised endpoint, regardless of how
    // the resolver treats 'localhost' (#40605).
    this._wsHost = await listenOnFreePort(this._wsServer, extensionInvitePortBase, extensionInvitePortCount);
  }

  cdpEndpoint() {
    return `${this._wsHost}${this._cdpPath}`;
  }

  extensionEndpoint() {
    return `${this._wsHost}${this._extensionPath}`;
  }

  async establishExtensionConnection(clientName: string) {
    debugLogger('Establishing extension connection');
    this._clientName = clientName;
    await this._launchBrowserIfNeeded();
    debugLogger('Waiting for the extension to discover the relay');
    // Without a token the user has to approve the connection in the browser, which can take arbitrarily long.
    const deadline = this._token ? monotonicTime() + extensionConnectionTimeout : 0;
    const { timedOut } = await raceAgainstDeadline(async () => {
      await this._extensionConnectionPromise;
      await this._handler.ready();
    }, deadline);
    if (timedOut) {
      const profile = this._profileDirectory ? ` "${this._profileDirectory}"` : '';
      throw new Error(`Playwright extension did not connect within ${extensionConnectionTimeout / 1000}s. Make sure the browser is running with the extension installed in the Chrome profile${profile} and PLAYWRIGHT_MCP_EXTENSION_TOKEN matches its token.`);
    }
    debugLogger('Extension connection established');
  }

  // Launches the browser when it is not running yet. The extension discovers
  // the relay through the /invites endpoint, so no URL is passed on the
  // command line — a command-line URL would open a foreground tab and steal
  // focus from whatever the user is doing.
  private async _launchBrowserIfNeeded() {
    const channel = registry.isChromiumAlias(this._browserChannel) ? 'chromium' : this._browserChannel;
    let executablePath = this._executablePath;
    if (!executablePath) {
      const executableInfo = registry.findExecutable(channel);
      if (!executableInfo)
        throw new Error(`Unsupported channel: "${this._browserChannel}"`);
      executablePath = executableInfo.executablePath();
      if (!executablePath)
        throw new Error(`"${this._browserChannel}" executable not found. Make sure it is installed at a standard location.`);
    }

    if (await isBrowserProcessRunning(path.basename(executablePath))) {
      debugLogger('Browser is already running, relying on extension discovery');
      return;
    }

    const args: string[] = [];
    // The default profile dir is not passed explicitly, the browser resolves it on its own.
    if (this._customUserDataDir)
      args.push(`--user-data-dir=${this._customUserDataDir}`);
    if (this._profileDirectory)
      args.push(`--profile-directory=${this._profileDirectory}`);
    if (os.platform() === 'linux' && channel === 'chromium')
      args.push('--no-sandbox');
    const testExecutableArg = process.env.PWTEST_EXTENSION_EXECUTABLE_ARG;
    if (testExecutableArg)
      args.unshift(testExecutableArg);
    spawn(executablePath, args, {
      windowsHide: true,
      detached: true,
      shell: false,
      stdio: 'ignore',
    });
  }

  stop(): void {
    this._closeConnections('Server stopped');
    void this._wsServer.close().catch(logUnhandledError);
  }

  private _closeConnections(reason: string) {
    this._closeCDPConnection(reason);
    this._closeExtensionConnection(reason);
  }

  private _handlePlaywrightConnection(ws: WebSocket): void {
    if (!this._extensionConnection) {
      debugLogger('Rejecting Playwright connection: extension not connected');
      ws.close(1000, 'Extension not connected');
      return;
    }
    if (this._cdpConnection) {
      debugLogger('Rejecting second Playwright connection');
      ws.close(1000, 'Another CDP client already connected');
      return;
    }
    this._cdpConnection = ws;
    this._handler.connectOverCDP(msg => this._sendToCDPClient(msg));
    ws.on('message', async data => {
      try {
        await this._handlePlaywrightMessage(JSON.parse(data.toString()));
      } catch (error: any) {
        debugLogger(`Error while handling Playwright message\n${data.toString()}\n`, error);
      }
    });
    ws.on('close', () => {
      this._closeExtensionConnection('Playwright client disconnected');
      debugLogger('Playwright WebSocket closed');
    });
    ws.on('error', error => {
      debugLogger('Playwright WebSocket error:', error);
    });
    debugLogger('Playwright MCP connected');
  }

  private _closeExtensionConnection(reason: string) {
    this._extensionConnection?.close(reason);
    if (!this._extensionConnectionPromise.isDone())
      this._extensionConnectionPromise.reject(new Error(reason));
  }

  private _closeCDPConnection(reason: string) {
    if (this._cdpConnection?.readyState === ws.OPEN)
      this._cdpConnection.close(1000, reason);
  }

  private _handleExtensionConnection(ws: WebSocket): void {
    if (this._extensionConnection) {
      ws.close(1000, 'Another extension connection already established');
      return;
    }
    this._extensionConnection = new ExtensionConnection(ws);
    this._extensionConnection.onclose = reason => {
      debugLogger('Extension WebSocket closed:', reason);
      this._handler.onExtensionDisconnect(reason);
      this._closeCDPConnection(`Extension disconnected: ${reason}`);
    };
    this._extensionConnection.onmessage = (method, params) => this._handler.handleExtensionEvent(method, params);
    this._extensionConnectionPromise.resolve();
  }

  // Discovery over HTTP: the extension's background service worker polls GET
  // /invites while scanning the fixed port range. A plain GET is used instead
  // of a WebSocket probe because a refused fetch() merely rejects the promise,
  // while every refused WebSocket is reported by the network stack as a
  // console error — 32 closed ports per sweep would flood the extension's
  // error page on an idle machine. The invite stays available until the
  // extension claims it by connecting to /extension/<connectionId> (a token
  // rejection claims it too), so repeated polls and several browser profiles
  // can safely re-read it. The invite carries the token and the extension
  // verifies it against its own stored token — exactly like the connect page
  // did — so a mismatched token still produces the fast, actionable
  // "rejected the authentication token" error instead of a silent timeout.
  private _handleInviteRequest(request: http.IncomingMessage, response: http.ServerResponse): void {
    const origin = request.headers.origin;
    // Browsers attach the chrome-extension:// origin; a missing Origin (e.g.
    // curl) is accepted — loopback-only exposure is the same surface the
    // WebSocket handshake had — but a known foreign origin is rejected.
    if (origin && origin !== `chrome-extension://${playwrightExtensionId}`) {
      response.statusCode = 403;
      response.end();
      return;
    }
    if (this._extensionConnection) {
      response.statusCode = 409;
      response.end();
      return;
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(this._invite()));
  }

  private _invite(): protocol.ExtensionInvite {
    const invite: protocol.ExtensionInvite = {
      type: 'invite',
      extensionUrl: `${this._wsHost}${this._extensionPath}`,
      taskId: this._taskId,
      connectionId: this._connectionId,
      client: { name: this._clientName },
      protocolVersion: this._protocolVersion,
    };
    if (this._token)
      invite.token = this._token;
    return invite;
  }

  // Legacy WebSocket variant of the discovery endpoint, kept so an older
  // extension still pairs with a newer playwright-core. The current extension
  // polls GET /invites instead — see _handleInviteRequest.
  private _handleInviteConnection(request: http.IncomingMessage, ws: WebSocket): void {
    if (request.headers.origin !== `chrome-extension://${playwrightExtensionId}`) {
      ws.close(1000, 'Unexpected origin');
      return;
    }
    if (this._extensionConnection) {
      ws.close(1000, 'Invite already claimed');
      return;
    }
    ws.send(JSON.stringify(this._invite()));
  }

  private async _handlePlaywrightMessage(message: CDPCommand): Promise<void> {
    debugLogger('← Playwright:', `${message.method} (id=${message.id})`);
    const { id, sessionId, method, params } = message;
    try {
      const result = await this._handleCDPCommand(method, params, sessionId);
      this._sendToCDPClient({ id, sessionId, result });
    } catch (e) {
      debugLogger('Error in the extension:', e);
      this._sendToCDPClient({
        id,
        sessionId,
        error: { message: (e as Error).message }
      });
    }
  }

  private async _handleCDPCommand(method: string, params: any, sessionId: string | undefined): Promise<any> {
    switch (method) {
      case 'Browser.getVersion': {
        return {
          protocolVersion: '1.3',
          product: 'Chrome/Extension-Bridge',
          userAgent: 'CDP-Bridge-Server/1.0.0',
        };
      }
      case 'Browser.setDownloadBehavior': {
        return { };
      }
    }
    const handled = await this._handler.handleCDPCommand(method, params, sessionId);
    if (handled)
      return handled.result;
    return await this._handler.forwardToExtension(method, params, sessionId);
  }

  private _sendToCDPClient(message: CDPResponse): void {
    debugLogger('→ Playwright:', `${message.method ?? `response(id=${message.id})`}`);
    this._cdpConnection?.send(JSON.stringify(message));
  }
}

type ExtensionResponse = {
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: string;
};

class ExtensionConnection {
  private readonly _ws: WebSocket;
  private readonly _callbacks = new Map<number, { resolve: (o: any) => void, reject: (e: Error) => void, error: Error }>();
  private _lastId = 0;

  onmessage?: <M extends keyof ExtensionEventsV2>(method: M, params: ExtensionEventsV2[M]['params']) => void;
  onclose?: (reason: string) => void;

  constructor(ws: WebSocket) {
    this._ws = ws;
    this._ws.on('message', this._onMessage.bind(this));
    this._ws.on('close', this._onClose.bind(this));
    this._ws.on('error', this._onError.bind(this));
  }

  async send<M extends keyof ExtensionCommandV2>(method: M, params: ExtensionCommandV2[M]['params']): Promise<any> {
    if (this._ws.readyState !== ws.OPEN)
      throw new Error(`Unexpected WebSocket state: ${this._ws.readyState}`);
    const id = ++this._lastId;
    this._ws.send(JSON.stringify({ id, method, params }));
    const error = new Error(`Protocol error: ${method}`);
    return new Promise((resolve, reject) => {
      this._callbacks.set(id, { resolve, reject, error });
    });
  }

  close(message: string) {
    debugLogger('closing extension connection:', message);
    if (this._ws.readyState === ws.OPEN)
      this._ws.close(1000, message);
  }

  private _onMessage(event: websocket.RawData) {
    const eventData = event.toString();
    let parsedJson;
    try {
      parsedJson = JSON.parse(eventData);
    } catch (e: any) {
      debugLogger(`<closing ws> Closing websocket due to malformed JSON. eventData=${eventData} e=${e?.message}`);
      this._ws.close();
      return;
    }
    try {
      this._handleParsedMessage(parsedJson);
    } catch (e: any) {
      debugLogger(`<closing ws> Closing websocket due to failed onmessage callback. eventData=${eventData} e=${e?.message}`);
      this._ws.close();
    }
  }

  private _handleParsedMessage(object: ExtensionResponse) {
    if (object.id && this._callbacks.has(object.id)) {
      const callback = this._callbacks.get(object.id)!;
      this._callbacks.delete(object.id);
      if (object.error) {
        const error = callback.error;
        error.message = object.error;
        callback.reject(error);
      } else {
        callback.resolve(object.result);
      }
    } else if (object.id) {
      debugLogger('← Extension: unexpected response', object);
    } else {
      this.onmessage?.(object.method! as keyof ExtensionEventsV2, object.params);
    }
  }

  private _onClose(code: number, reason: Buffer) {
    const message = reason.toString();
    debugLogger(`<ws closed> code=${code} reason=${message}`);
    this._dispose();
    this.onclose?.(message);
  }

  private _onError(event: websocket.ErrorEvent) {
    debugLogger(`<ws error> message=${event.message} type=${event.type} target=${event.target}`);
    this._dispose();
  }

  private _dispose() {
    for (const callback of this._callbacks.values())
      callback.reject(new Error('WebSocket closed'));
    this._callbacks.clear();
  }
}
