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

import { debugLog } from './relayConnection';
import { swlog } from './swDebugLog';

// The service worker discovers Playwright clients by scanning this fixed port
// range on 127.0.0.1 for the relay's /invites endpoint (see
// extensionInvitePortBase in packages/playwright-core/src/tools/mcp/cdpRelay.ts
// — the extension cannot read process env, so the range is fixed in code on
// both sides).
export const EXTENSION_INVITE_PORT_BASE = 7317;
export const EXTENSION_INVITE_PORT_COUNT = 32;

const DISCOVERY_ALARM_NAME = 'playwright-relay-discovery';
const SCAN_BUDGET_MS = 3_000;
// While the discovery is "active", rescans run on a plain setTimeout loop
// every ACTIVE_SCAN_MS. Each scan calls chrome.alarms.create, which resets
// the MV3 service worker idle timer (30s), so the worker stays alive and the
// timer chain keeps ticking — Chrome may clamp chrome.alarms to 30s minimum
// intervals, but it does not clamp timers while the worker is alive.
const ACTIVE_SCAN_MS = 2_000;
// How long after each service worker start (or each found invite) the fast
// scan loop keeps running. Afterwards discovery falls back to an alarm that
// wakes the worker at most once every ~25s.
const ACTIVE_WINDOW_MS = 10 * 60_000;
const IDLE_ALARM_MS = 25_000;

// Mirror of protocol.ExtensionInvite in
// packages/playwright-core/src/tools/mcp/protocol.ts — keep in sync.
export type RelayInvite = {
  type: 'invite';
  extensionUrl: string;
  taskId: string;
  connectionId: string;
  client?: { name?: string; version?: string };
  protocolVersion: number;
  token?: string;
};

let scanning = false;
let scanTimer: ReturnType<typeof setTimeout> | undefined;
// The fast scan window opens when the service worker loads and reopens on
// every found invite.
let activeUntil = Date.now() + ACTIVE_WINDOW_MS;

// Idempotent: safe to call on every service worker start. Each start reopens
// the active window, so bursts of activity (and the tests) pick up invites fast.
export function startRelayDiscovery(onInvite: (invite: RelayInvite) => void): void {
  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === DISCOVERY_ALARM_NAME)
      void scan(onInvite);
  });
  void scan(onInvite);
}

async function scan(onInvite: (invite: RelayInvite) => void): Promise<void> {
  if (scanning)
    return;
  scanning = true;
  let invites: RelayInvite[] = [];
  try {
    invites = await discoverInvites();
  } catch (error: any) {
    debugLog('Relay discovery scan failed:', error?.message);
  } finally {
    scanning = false;
  }
  for (const invite of invites)
    onInvite(invite);
  scheduleNextScan(onInvite, invites.length > 0);
}

// Keeps the discovery chain alive — a client may start a relay at any time.
// While inside the active window the next scan is scheduled with a timer
// (fast, and it doubles as the worker keepalive); outside it, a low-frequency
// alarm takes over so an idle browser still discovers new clients.
function scheduleNextScan(onInvite: (invite: RelayInvite) => void, foundInvite: boolean): void {
  if (foundInvite)
    activeUntil = Date.now() + ACTIVE_WINDOW_MS;
  chrome.alarms.create(DISCOVERY_ALARM_NAME, { when: Date.now() + IDLE_ALARM_MS });
  if (Date.now() < activeUntil) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => void scan(onInvite), ACTIVE_SCAN_MS);
  }
}

async function discoverInvites(): Promise<RelayInvite[]> {
  const probes: Promise<RelayInvite | undefined>[] = [];
  for (let i = 0; i < EXTENSION_INVITE_PORT_COUNT; i++)
    probes.push(probePort(EXTENSION_INVITE_PORT_BASE + i));
  const invites = await Promise.all(probes);
  return invites.filter((invite): invite is RelayInvite => invite !== undefined);
}

async function probePort(port: number): Promise<RelayInvite | undefined> {
  let socket: WebSocket | undefined;
  try {
    const result = await Promise.race([
      requestInvite(port, s => socket = s),
      new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), SCAN_BUDGET_MS)),
    ]);
    return result;
  } catch {
    return undefined;
  } finally {
    // A probe that timed out may still have a live socket — close it so slow
    // scans don't leak connections.
    try {
      socket?.close();
    } catch {
      // Already closed.
    }
  }
}

function requestInvite(port: number, onSocket: (socket: WebSocket) => void): Promise<RelayInvite | undefined> {
  return new Promise(resolve => {
    let settled = false;
    const done = (invite: RelayInvite | undefined) => {
      if (settled)
        return;
      settled = true;
      try {
        socket.close();
      } catch {
        // Already closed.
      }
      resolve(invite);
    };
    const socket = new WebSocket(`ws://127.0.0.1:${port}/invites`);
    onSocket(socket);
    socket.onmessage = event => {
      swlog(`invite frame ${port}`);
      try {
        const invite = JSON.parse(String(event.data)) as RelayInvite;
        if (invite?.type !== 'invite' || !isLoopbackWsUrl(invite.extensionUrl)) {
          swlog(`invite rejected ${port}: type=${invite?.type} url=${invite?.extensionUrl}`);
          return done(undefined);
        }
        swlog(`invite accepted ${port}: ${invite.connectionId}`);
        done(invite);
      } catch (error: any) {
        swlog(`invite parse error ${port}: ${error?.message}`);
        done(undefined);
      }
    };
    // Both a 4001 token rejection and a plain close mean: nothing to fetch
    // on this port.
    socket.onclose = () => done(undefined);
    socket.onerror = () => done(undefined);
  });
}

function isLoopbackWsUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname;
    return host === '127.0.0.1' || host === '[::1]';
  } catch {
    return false;
  }
}
