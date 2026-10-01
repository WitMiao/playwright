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

import { getOrCreateAuthToken } from './authToken';
import { RelayConnection, debugLog } from './relayConnection';
import { PendingConnections } from './pendingConnection';
import { ConnectedTabGroup, isNonDebuggableUrl } from './connectedTabGroup';
import { startRelayDiscovery, RelayInvite } from './relayDiscovery';
import { swlog } from './swDebugLog';
import { cleanupStalePlaywrightGroups } from './taskResources';

// Keep in sync with protocol.VERSION in
// packages/playwright-core/src/tools/mcp/protocol.ts. The connect page
// declares the same value (SUPPORTED_PROTOCOL_VERSION there).
const SUPPORTED_PROTOCOL_VERSION = 2;

type PageMessage = {
  type: 'connectionRequested';
  mcpRelayUrl: string;
  connectionId?: string;
  taskId?: string;
} | {
  type: 'getTabs';
} | {
  type: 'connectToTab';
  // Picked in the connect page; absent on the token-bypass path where no tab
  // selection happens.
  tab?: chrome.tabs.Tab;
  clientName?: string;
} | {
  type: 'getConnectionStatus';
} | {
  type: 'rejectConnection';
} | {
  type: 'disconnect';
  connectionId?: string;
} | {
  type: 'keepalive';
};

// Auth token cache + hang guard: a stuck chrome.storage read must never stall
// invite handling. On a timeout the invite falls back to the approval page,
// whose page context re-reads the token itself.
let cachedAuthToken: string | undefined;

async function readAuthTokenWithTimeout(): Promise<string | undefined> {
  if (cachedAuthToken !== undefined)
    return cachedAuthToken;
  const token = await Promise.race([
    getOrCreateAuthToken().then(token => {
      cachedAuthToken = token;
      return token;
    }),
    new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 3000)),
  ]);
  return token;
}

class PlaywrightExtension {
  private _activeConnections = new Map<string, {
    group: ConnectedTabGroup;
    clientName?: string;
    taskId: string;
  }>();
  // A connect dialog can submit a tab snapshot that another dialog also saw.
  // Reserve explicit selections before opening their relay connection, then
  // transfer ownership to the active ConnectedTabGroup without an await gap.
  private _reservedTabIds = new Set<number>();
  private _pendingConnections = new PendingConnections();
  // Invites already acted upon. The relay hands the same invite to every
  // discovery probe until it is claimed, so repeated scans must not start a
  // task twice.
  private _handledConnectionIds = new Set<string>();
  // Service worker restarts lose all connection state, so any existing
  // Playwright groups are stale. Connections wait on this before reconciling.
  private _cleanupPromise: Promise<void>;

  constructor() {
    chrome.runtime.onMessage.addListener(this._onMessage.bind(this));
    chrome.action.onClicked.addListener(this._onActionClicked.bind(this));
    this._cleanupPromise = cleanupStalePlaywrightGroups();
    startRelayDiscovery(invite => this._handleInvite(invite).catch(error => debugLog('Failed to handle relay invite:', error?.message)));
  }

  // Promise-based message handling is not supported in Chrome: https://issues.chromium.org/issues/40753031
  private _onMessage(message: PageMessage, sender: chrome.runtime.MessageSender, sendResponse: (response: any) => void) {
    switch (message.type) {
      case 'connectionRequested': {
        const selectorTabId = sender.tab!.id!;
        this._releaseConnectPage(selectorTabId).then(() => {
          this._pendingConnections.create(String(selectorTabId), {
            mcpRelayUrl: message.mcpRelayUrl,
            connectionId: message.connectionId || crypto.randomUUID(),
            taskId: message.taskId || 'Playwright',
          });
          sendResponse({ success: true });
        });
        return true;
      }
      case 'getTabs':
        this._getTabs(sender.tab?.id).then(
            tabs => sendResponse({ success: true, tabs, currentTabId: sender.tab?.id }),
            (error: any) => sendResponse({ success: false, error: error.message }));
        return true;
      case 'connectToTab': {
        this._connectTask({
          pendingKey: String(sender.tab!.id!),
          selectorTabId: sender.tab!.id!,
          selectorWindowId: sender.tab!.windowId,
          tab: message.tab,
          clientName: message.clientName,
        }).then(
            () => sendResponse({ success: true }),
            (error: any) => sendResponse({ success: false, error: error.message }));
        return true; // Return true to indicate that the response will be sent asynchronously
      }
      case 'getConnectionStatus':
        sendResponse({
          connections: [...this._activeConnections].map(([connectionId, connection]) => ({
            connectionId,
            clientName: connection.clientName,
            taskId: connection.taskId,
            connectedTabIds: connection.group.connectedTabIds(),
          })),
        });
        return false;
      case 'rejectConnection':
        this._pendingConnections.reject(String(sender.tab!.id!), 'Playwright Extension rejected the authentication token.').then(
            () => sendResponse({ success: true }),
            (error: any) => sendResponse({ success: false, error: error.message }));
        return true;
      case 'disconnect':
        try {
          this._disconnect(message.connectionId, 'User disconnected');
          sendResponse({ success: true });
        } catch (error: any) {
          sendResponse({ success: false, error: error.message });
        }
        return true;
      case 'keepalive':
        // Connect page pings us every ~20s so receiving this message resets
        // the MV3 service worker idle timer and keeps the relay WebSocket alive.
        return false;
    }
  }

  // A relay invite discovered by startRelayDiscovery. Token-matched invites
  // are accepted silently — no connect page, no tab activation, nothing the
  // user can feel. Anything else (first-time consent, unknown or mismatched
  // token, protocol mismatch) opens the connect page in the background and
  // lets the existing page flow drive the decision.
  private async _handleInvite(invite: RelayInvite): Promise<void> {
    swlog(`handleInvite ${invite.connectionId} token=${invite.token !== undefined}`);
    if (this._handledConnectionIds.has(invite.connectionId) || this._activeConnections.has(invite.connectionId))
      return;
    this._handledConnectionIds.add(invite.connectionId);
    if (invite.protocolVersion !== SUPPORTED_PROTOCOL_VERSION || invite.token === undefined || invite.token !== await readAuthTokenWithTimeout()) {
      swlog(`invite ${invite.connectionId} -> approval page`);
      await this._openApprovalPage(invite);
      return;
    }
    swlog(`invite ${invite.connectionId} -> silent accept`);
    debugLog(`Accepting relay invite for "${invite.client?.name ?? 'unknown'}" (task ${invite.taskId})`);
    this._pendingConnections.create(invite.connectionId, {
      mcpRelayUrl: invite.extensionUrl,
      connectionId: invite.connectionId,
      taskId: invite.taskId || 'Playwright',
    });
    try {
      await this._connectTask({ pendingKey: invite.connectionId, clientName: invite.client?.name });
    } catch (error: any) {
      debugLog('Failed to accept relay invite:', error.message);
    }
  }

  // Opens the connect page for invites that cannot be accepted silently.
  // It opens in the background: the user decides when to look at it, and the
  // page flow (connectionRequested / connectToTab / rejectConnection) takes
  // over from there.
  private async _openApprovalPage(invite: RelayInvite): Promise<void> {
    const url = new URL(chrome.runtime.getURL('connect.html'));
    url.searchParams.set('mcpRelayUrl', invite.extensionUrl);
    url.searchParams.set('taskId', invite.taskId);
    url.searchParams.set('connectionId', invite.connectionId);
    url.searchParams.set('client', JSON.stringify(invite.client ?? {}));
    url.searchParams.set('protocolVersion', String(invite.protocolVersion));
    if (invite.token !== undefined)
      url.searchParams.set('token', invite.token);
    const windowId = await this._chooseTargetWindow();
    if (windowId !== undefined)
      await chrome.tabs.create({ url: url.toString(), active: false, windowId });
    else
      await chrome.windows.create({ url: url.toString(), focused: false });
  }

  private async _connectTask(params: {
    pendingKey: string;
    // Picked in the connect page ("Allow & select"); absent on background
    // paths where a fresh task tab is created instead.
    tab?: chrome.tabs.Tab;
    clientName?: string;
    // Present on the connect page flow, where the page tab is closed once the
    // connection is established.
    selectorTabId?: number;
    selectorWindowId?: number;
  }): Promise<void> {
    let reservedTabId: number | undefined;
    let acceptedConnection: RelayConnection | undefined;
    try {
      await this._cleanupPromise;
      let selectedTab = params.tab;
      if (selectedTab?.id !== undefined) {
        const conflictMessage = 'Tab is already connected to another Playwright client.';
        if (this._claimedTabIds().has(selectedTab.id)) {
          await this._pendingConnections.reject(params.pendingKey, conflictMessage).catch(error => {
            debugLog('Failed to reject duplicate tab connection:', error);
          });
          throw new Error(conflictMessage);
        }
        reservedTabId = selectedTab.id;
        this._reservedTabIds.add(selectedTab.id);
        selectedTab = await chrome.tabs.get(selectedTab.id);
      }

      const pending = await this._pendingConnections.take(params.pendingKey);
      if (!pending)
        throw new Error('Pending client connection closed');
      acceptedConnection = pending.connection;
      if (this._activeConnections.has(pending.connectionId))
        throw new Error('Connection id is already active');
      if (!selectedTab) {
        const windowId = params.selectorWindowId ?? await this._chooseTargetWindow();
        if (windowId !== undefined) {
          selectedTab = await chrome.tabs.create({
            url: 'about:blank',
            active: false,
            index: 0,
            windowId,
          });
        } else {
          // No browser window at all: create a background one so the task tab
          // has somewhere to live without stealing focus.
          const win = await chrome.windows.create({ url: 'about:blank', focused: false });
          selectedTab = win?.tabs?.[0];
        }
      }
      if (selectedTab?.id === undefined)
        throw new Error('Failed to create a background task tab');

      const group: ConnectedTabGroup = new ConnectedTabGroup(
          pending.connection,
          selectedTab,
          pending.connectionId,
          pending.taskId,
          !params.tab,
          tabId => this._isTabClaimedByOtherTask(tabId, group));
      group.onclose = () => {
        if (this._activeConnections.get(pending.connectionId)?.group === group)
          this._activeConnections.delete(pending.connectionId);
      };
      this._activeConnections.set(pending.connectionId, { group, clientName: params.clientName, taskId: pending.taskId });
      acceptedConnection = undefined;
      if (reservedTabId !== undefined) {
        this._reservedTabIds.delete(reservedTabId);
        reservedTabId = undefined;
      }

      // Activating a target is reserved for the user's explicit
      // "Allow & select" click. Background/token authorization never enters
      // this branch and never changes the active tab.
      if (params.tab) {
        await Promise.all([
          chrome.tabs.update(selectedTab.id, { active: true }),
          chrome.windows.update(selectedTab.windowId, { focused: true }),
        ]).catch(() => {});
      }
      if (params.selectorTabId !== undefined && selectedTab.id !== params.selectorTabId)
        await chrome.tabs.remove(params.selectorTabId).catch(() => {});
    } catch (error: any) {
      acceptedConnection?.close(error.message);
      if (reservedTabId !== undefined)
        this._reservedTabIds.delete(reservedTabId);
      await this._pendingConnections.reject(params.pendingKey, error.message).catch(rejectionError => {
        debugLog('Failed to reject pending connection:', rejectionError);
      });
      debugLog(`Failed to connect task tab:`, error.message);
      throw error;
    }
  }

  // The user's current normal window, so agent tabs and the approval page
  // land where the user is without activating anything.
  private async _chooseTargetWindow(): Promise<number | undefined> {
    const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
    const withId = windows.filter(win => win.id !== undefined);
    return withId.find(win => win.focused)?.id ?? withId[0]?.id;
  }

  // Chrome can inherit the active tab group when opening the connect page.
  // It is never part of another task, so detach and ungroup it before showing
  // the selector while leaving task-owned tabs protected.
  private async _releaseConnectPage(tabId: number): Promise<void> {
    for (const connection of this._activeConnections.values())
      connection.group.releaseTab(tabId);
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (tab && tab.groupId !== chrome.tabs.TAB_ID_NONE)
      await chrome.tabs.ungroup(tabId).catch(() => {});
  }

  private async _getTabs(selectorTabId: number | undefined): Promise<chrome.tabs.Tab[]> {
    const tabs = await chrome.tabs.query({});
    const claimedTabIds = this._claimedTabIds();
    return tabs.filter(tab => tab.id === selectorTabId || (!isNonDebuggableUrl(tab.url) && (tab.id === undefined || !claimedTabIds.has(tab.id))));
  }

  private _claimedTabIds(): Set<number> {
    return new Set([
      ...this._reservedTabIds,
      ...[...this._activeConnections.values()].flatMap(connection => connection.group.claimedTabIds()),
    ]);
  }

  private _isTabClaimedByOtherTask(tabId: number, currentGroup: ConnectedTabGroup): boolean {
    if (this._reservedTabIds.has(tabId))
      return true;
    return [...this._activeConnections.values()].some(connection =>
      connection.group !== currentGroup && connection.group.claimedTabIds().includes(tabId));
  }

  private async _onActionClicked(): Promise<void> {
    await chrome.tabs.create({
      url: chrome.runtime.getURL('status.html'),
      active: true
    });
  }
  // Closes one connection, or every connection for backwards-compatible
  // callers that omit a connection id. Each ConnectedTabGroup owns its own
  // resource cleanup.
  private _disconnect(connectionId: string | undefined, reason: string) {
    if (connectionId) {
      this._activeConnections.get(connectionId)?.group.close(reason);
      return;
    }
    for (const connection of this._activeConnections.values())
      connection.group.close(reason);
  }
}

new PlaywrightExtension();
