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

import { RelayConnection, debugLog } from './relayConnection';

const kConnectionRejectedCloseCode = 4001;

export type PendingConnection = {
  connection: RelayConnection;
  connectionId: string;
  taskId: string;
};

type PendingConnectionRequest = Omit<PendingConnection, 'connection'> & {
  mcpRelayUrl: string;
};

// Relay URLs recorded before a connection is opened, keyed either by the
// connect page tab id (page flow) or the invite connection id (silent
// discovery flow). The relay WebSocket opens lazily in `take` once the user
// clicks Allow or the invite is accepted.
export class PendingConnections {
  private _map = new Map<string, PendingConnectionRequest>();

  constructor() {
    // Page-flow requests die with their connect page tab. Keys from the
    // invite flow are UUIDs, so they never collide with tab ids.
    chrome.tabs.onRemoved.addListener(tabId => this._map.delete(String(tabId)));
  }

  create(key: string, request: PendingConnectionRequest): void {
    this._map.set(key, request);
  }

  async reject(key: string, reason: string): Promise<void> {
    const request = this._map.get(key);
    if (!request)
      return;
    this._map.delete(key);
    await rejectRelayConnection(request.mcpRelayUrl, reason);
  }

  async take(key: string): Promise<PendingConnection | undefined> {
    const request = this._map.get(key);
    if (!request)
      return undefined;
    this._map.delete(key);
    return {
      connection: await openRelayConnection(request.mcpRelayUrl),
      connectionId: request.connectionId,
      taskId: request.taskId,
    };
  }
}

async function rejectRelayConnection(mcpRelayUrl: string, reason: string): Promise<void> {
  const socket = new WebSocket(mcpRelayUrl);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('Connection timeout')), 5000);
      socket.onopen = () => socket.close(kConnectionRejectedCloseCode, reason);
      socket.onerror = () => reject(new Error('WebSocket error'));
      socket.onclose = () => resolve();
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function openRelayConnection(mcpRelayUrl: string): Promise<RelayConnection> {
  try {
    const socket = new WebSocket(mcpRelayUrl);
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error('WebSocket error'));
      setTimeout(() => reject(new Error('Connection timeout')), 5000);
    });
    return new RelayConnection(socket);
  } catch (error: any) {
    const message = `Failed to connect to MCP relay: ${error.message}`;
    debugLog(message);
    throw new Error(message);
  }
}
