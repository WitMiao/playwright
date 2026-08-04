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

import fs from 'fs';
import http from 'http';
import ws from 'ws';

import { test, expect } from './cli-fixtures';

import { PendingConnections } from '../../packages/extension/src/pendingConnection';
import { CDPRelayServer } from '../../packages/playwright-core/src/tools/mcp/cdpRelay';

test('extension token rejection aborts the pending relay connection', async () => {
  const originalChrome = (globalThis as any).chrome;
  const originalWebSocket = (globalThis as any).WebSocket;
  (globalThis as any).chrome = {
    tabs: {
      onRemoved: { addListener: () => {} },
    },
  };
  (globalThis as any).WebSocket = ws;

  const httpServer = http.createServer();
  await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  const relay = new CDPRelayServer(httpServer, 'chromium', process.execPath);
  const connectionPromise = relay.establishExtensionConnection('invalid-token-test');
  const connectionResult = connectionPromise.catch(e => e);
  const startTime = Date.now();

  try {
    const pendingConnections = new PendingConnections();
    pendingConnections.create(17, {
      mcpRelayUrl: relay.extensionEndpoint(),
      connectionId: 'invalid-token-connection',
      taskId: 'invalid-token-task',
    });

    const invalidToken = 'must-not-appear-in-errors';
    await pendingConnections.reject(17, 'Playwright Extension rejected the authentication token.');

    const error = await connectionResult;
    expect(error.message).toContain('Playwright Extension rejected the authentication token.');
    expect(error.message).not.toContain(invalidToken);
    expect(Date.now() - startTime).toBeLessThan(5000);
  } finally {
    relay.stop();
    await new Promise<void>(resolve => httpServer.close(() => resolve()));
    (globalThis as any).chrome = originalChrome;
    (globalThis as any).WebSocket = originalWebSocket;
  }
});

test('CLI attach fails fast when the extension rejects authentication', async ({ cli }, testInfo) => {
  const fakeExtension = testInfo.outputPath('reject-extension.js');
  await fs.promises.writeFile(fakeExtension, `
const WebSocket = require('ws');
const socket = new WebSocket(new URL(process.argv.at(-1)).searchParams.get('mcpRelayUrl'));
socket.onopen = () => socket.close(4001, 'Playwright Extension rejected the authentication token.');
socket.onclose = () => process.exit(0);
socket.onerror = () => process.exit(1);
setTimeout(() => process.exit(2), 5000);
`);

  const invalidToken = 'invalid-token-must-not-appear-in-errors';
  const startTime = Date.now();
  const result = await cli('-s=invalid-token', 'attach', '--extension=chromium', {
    env: {
      PLAYWRIGHT_MCP_EXECUTABLE_PATH: process.execPath,
      PLAYWRIGHT_MCP_EXTENSION_TOKEN: invalidToken,
      PWTEST_EXTENSION_EXECUTABLE_ARG: fakeExtension,
    },
  });
  const output = `${result.output}\n${result.error}`;

  expect(result.exitCode).toBe(1);
  expect(output).toContain('Playwright Extension rejected the authentication token.');
  expect(output).not.toContain(invalidToken);
  expect(Date.now() - startTime).toBeLessThan(5000);
});
