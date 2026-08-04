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

import { test, expect } from '@playwright/test';
import { RelayConnection } from '../../packages/extension/src/relayConnection';

class MockEvent {
  private _listeners = new Set<(...args: any[]) => void>();

  addListener(listener: (...args: any[]) => void): void {
    this._listeners.add(listener);
  }

  removeListener(listener: (...args: any[]) => void): void {
    this._listeners.delete(listener);
  }

  emit(...args: any[]): void {
    for (const listener of this._listeners)
      listener(...args);
  }
}

class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onclose: ((event: { reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  sentMessages: any[] = [];
  closeCode?: number;
  closeReason = '';

  constructor(_url: string) {
    MockWebSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }

  send(message: string): void {
    this.sentMessages.push(JSON.parse(message));
  }

  close(code?: number, reason = ''): void {
    if (this.readyState === MockWebSocket.CLOSED)
      return;
    this.readyState = MockWebSocket.CLOSED;
    this.closeCode = code;
    this.closeReason = reason;
    queueMicrotask(() => this.onclose?.({ reason }));
  }
}

test('relay-created tab is claimed before its response is sent', async () => {
  const originalChrome = globalThis.chrome;
  const originalWebSocket = globalThis.WebSocket;
  const debuggerOnEvent = new MockEvent();
  const debuggerOnDetach = new MockEvent();
  const tabsOnCreated = new MockEvent();
  const tabsOnRemoved = new MockEvent();
  globalThis.chrome = {
    debugger: {
      onDetach: debuggerOnDetach,
      onEvent: debuggerOnEvent,
    },
    tabs: {
      create: async () => ({ id: 9, windowId: 1, url: 'about:blank' }),
      onCreated: tabsOnCreated,
      onRemoved: tabsOnRemoved,
    },
  } as any;
  globalThis.WebSocket = MockWebSocket as any;
  const webSocket = new MockWebSocket('ws://relay');
  const relay = new RelayConnection(webSocket as any);
  try {
    webSocket.onmessage?.({ data: JSON.stringify({
      id: 1,
      method: 'chrome.tabs.create',
      params: [{ url: 'about:blank' }],
    }) } as MessageEvent);
    await expect.poll(() => webSocket.sentMessages).toContainEqual({
      id: 1,
      result: expect.objectContaining({ id: 9 }),
    });
    expect(relay.claimedTabs).toContain(9);
  } finally {
    relay.close('test complete');
    globalThis.chrome = originalChrome;
    globalThis.WebSocket = originalWebSocket;
  }
});

test('does not mark opener-created tabs as task-owned', async () => {
  const originalChrome = globalThis.chrome;
  const originalWebSocket = globalThis.WebSocket;
  const debuggerOnEvent = new MockEvent();
  const debuggerOnDetach = new MockEvent();
  const tabsOnCreated = new MockEvent();
  const tabsOnRemoved = new MockEvent();
  globalThis.chrome = {
    debugger: {
      attach: async () => {},
      detach: async () => {},
      onDetach: debuggerOnDetach,
      onEvent: debuggerOnEvent,
    },
    tabs: {
      onCreated: tabsOnCreated,
      onRemoved: tabsOnRemoved,
    },
  } as any;
  globalThis.WebSocket = MockWebSocket as any;
  const webSocket = new MockWebSocket('ws://relay');
  const relay = new RelayConnection(webSocket as any);
  const ownedTabIds: number[] = [];
  relay.onownedtabcreated = tabId => ownedTabIds.push(tabId);
  try {
    webSocket.onmessage?.({ data: JSON.stringify({
      id: 1,
      method: 'chrome.debugger.attach',
      params: [{ tabId: 7 }, '1.3'],
    }) } as MessageEvent);
    await expect.poll(() => relay.claimedTabs).toContain(7);

    tabsOnCreated.emit({ id: 8, openerTabId: 7, windowId: 1, url: 'about:blank' });

    expect(relay.claimedTabs).toContain(8);
    expect(ownedTabIds).toEqual([]);
  } finally {
    relay.close('test complete');
    globalThis.chrome = originalChrome;
    globalThis.WebSocket = originalWebSocket;
  }
});

test('concurrent dialogs cannot claim reserved or closing tabs', async () => {
  MockWebSocket.instances = [];
  let onMessage: ((message: any, sender: any, sendResponse: (response: any) => void) => boolean) | undefined;
  let queriedTabs: any[] = [];
  let tabCreationError: Error | undefined;
  let blockResourceUpdate = false;
  let notifyResourceUpdateStarted!: () => void;
  let releaseResourceUpdate!: () => void;
  const resourceUpdateStarted = new Promise<void>(resolve => notifyResourceUpdateStarted = resolve);
  const resourceUpdateRelease = new Promise<void>(resolve => releaseResourceUpdate = resolve);
  let blockGroupUpdate = false;
  let notifyGroupUpdateStarted!: () => void;
  let releaseGroupUpdate!: () => void;
  const groupUpdateStarted = new Promise<void>(resolve => notifyGroupUpdateStarted = resolve);
  const groupUpdateRelease = new Promise<void>(resolve => releaseGroupUpdate = resolve);
  const removedTabIds: number[] = [];
  const ungroupedTabIds: number[] = [];
  const focusedWindowIds: number[] = [];
  const tabsOnCreated = new MockEvent();
  const tabsOnAttached = new MockEvent();
  const tabsOnRemoved = new MockEvent();
  const tabsOnUpdated = new MockEvent();
  const debuggerOnEvent = new MockEvent();
  const debuggerOnDetach = new MockEvent();

  const chromeMock = {
    action: {
      onClicked: new MockEvent(),
      setBadgeBackgroundColor: async () => {},
      setBadgeText: async () => {},
      setTitle: async () => {},
    },
    debugger: {
      attach: async () => {},
      detach: async () => {},
      onDetach: debuggerOnDetach,
      onEvent: debuggerOnEvent,
      sendCommand: async () => ({}),
    },
    runtime: {
      onMessage: {
        addListener: (listener: typeof onMessage) => onMessage = listener,
      },
    },
    storage: {
      session: {
        get: async () => ({}),
        remove: async () => {},
        set: async () => {
          if (!blockResourceUpdate)
            return;
          notifyResourceUpdateStarted();
          await resourceUpdateRelease;
        },
      },
    },
    tabGroups: {
      get: async () => ({}),
      query: async () => [],
      update: async () => ({}),
    },
    tabs: {
      TAB_ID_NONE: -1,
      create: async () => {
        if (tabCreationError)
          throw tabCreationError;
        return { id: 999, windowId: 1, url: 'about:blank' };
      },
      group: async () => {
        if (blockGroupUpdate) {
          notifyGroupUpdateStarted();
          await groupUpdateRelease;
        }
        return 1;
      },
      onAttached: tabsOnAttached,
      onCreated: tabsOnCreated,
      onRemoved: tabsOnRemoved,
      onUpdated: tabsOnUpdated,
      get: async (tabId: number) => {
        if (tabId === 404)
          throw new Error('No tab with id: 404');
        return { id: tabId, windowId: 2, groupId: tabId === 8 ? 1 : undefined, url: 'https://example.test/', title: 'Shared tab' };
      },
      query: async () => queriedTabs,
      remove: async (tabIds: number | number[]) => removedTabIds.push(...(Array.isArray(tabIds) ? tabIds : [tabIds])),
      ungroup: async (tabIds: number | number[]) => ungroupedTabIds.push(...(Array.isArray(tabIds) ? tabIds : [tabIds])),
      update: async (tabId: number) => ({ id: tabId }),
    },
    windows: {
      update: async (windowId: number) => {
        focusedWindowIds.push(windowId);
        return {};
      },
    },
  };

  const originalChrome = globalThis.chrome;
  const originalWebSocket = globalThis.WebSocket;
  globalThis.chrome = chromeMock as any;
  globalThis.WebSocket = MockWebSocket as any;
  try {
    await import('../../packages/extension/src/background');
    expect(onMessage).toBeDefined();

    const dispatch = (message: any, selectorTabId: number) => new Promise<any>(resolve => {
      onMessage!(message, { tab: { id: selectorTabId, windowId: 1 } }, resolve);
    });
    await dispatch({
      type: 'connectionRequested',
      mcpRelayUrl: 'ws://relay/first',
      connectionId: 'first',
      taskId: 'first-task',
    }, 101);
    await dispatch({
      type: 'connectionRequested',
      mcpRelayUrl: 'ws://relay/second',
      connectionId: 'second',
      taskId: 'second-task',
    }, 102);

    const staleTab = { id: 7, windowId: 1, url: 'https://example.test/', title: 'Shared tab' };
    const responses = await Promise.all([
      dispatch({ type: 'connectToTab', tab: staleTab, clientName: 'first-client' }, 101),
      dispatch({ type: 'connectToTab', tab: staleTab, clientName: 'second-client' }, 102),
    ]);

    expect(responses.filter(response => response.success)).toHaveLength(1);
    expect(responses.filter(response => response.error === 'Tab is already connected to another Playwright client.')).toHaveLength(1);
    expect(focusedWindowIds).toEqual([2]);

    await dispatch({
      type: 'connectionRequested',
      mcpRelayUrl: 'ws://relay/missing',
      connectionId: 'missing',
      taskId: 'missing-task',
    }, 106);
    const webSocketCount = MockWebSocket.instances.length;
    expect(await dispatch({
      type: 'connectToTab',
      tab: { id: 404, windowId: 1, url: 'https://example.test/missing', title: 'Missing tab' },
      clientName: 'missing-client',
    }, 106)).toEqual({ success: false, error: 'No tab with id: 404' });
    expect(MockWebSocket.instances).toHaveLength(webSocketCount + 1);
    expect(MockWebSocket.instances.at(-1)).toMatchObject({
      closeCode: 4001,
      closeReason: 'No tab with id: 404',
    });

    await dispatch({
      type: 'connectionRequested',
      mcpRelayUrl: 'ws://relay/create-failure',
      connectionId: 'create-failure',
      taskId: 'create-failure-task',
    }, 108);
    tabCreationError = new Error('Selector window was closed');
    expect(await dispatch({ type: 'connectToTab', clientName: 'create-failure-client' }, 108))
        .toEqual({ success: false, error: 'Selector window was closed' });
    expect(MockWebSocket.instances.at(-1)).toMatchObject({
      closeCode: 1000,
      closeReason: 'Selector window was closed',
    });
    tabCreationError = undefined;

    queriedTabs = [staleTab];
    expect(await dispatch({ type: 'getTabs' }, 103)).toEqual({ success: true, tabs: [], currentTabId: 103 });

    blockGroupUpdate = true;
    const groupingTab = { id: 8, windowId: 1, url: 'https://example.test/grouping', title: 'Grouping tab' };
    await dispatch({
      type: 'connectionRequested',
      mcpRelayUrl: 'ws://relay/grouping',
      connectionId: 'grouping',
      taskId: 'grouping-task',
    }, 107);
    expect(await dispatch({ type: 'connectToTab', tab: groupingTab, clientName: 'grouping-client' }, 107)).toEqual({ success: true });
    const groupingWebSocket = MockWebSocket.instances.at(-1)!;
    groupingWebSocket.onmessage?.({ data: JSON.stringify({
      id: 1,
      method: 'chrome.debugger.attach',
      params: [{ tabId: 8 }, '1.3'],
    }) } as MessageEvent);
    await groupUpdateStarted;

    expect(await dispatch({ type: 'disconnect', connectionId: 'grouping' }, 105)).toEqual({ success: true });
    await new Promise(resolve => setTimeout(resolve, 0));
    queriedTabs = [groupingTab];
    expect(await dispatch({ type: 'getTabs' }, 105)).toEqual({ success: true, tabs: [], currentTabId: 105 });
    expect((await dispatch({ type: 'getConnectionStatus' }, 105)).connections)
        .toContainEqual(expect.objectContaining({ connectionId: 'grouping' }));

    releaseGroupUpdate();
    await expect.poll(() => ungroupedTabIds).toContain(8);
    await expect.poll(async () => (await dispatch({ type: 'getConnectionStatus' }, 105)).connections)
        .not.toContainEqual(expect.objectContaining({ connectionId: 'grouping' }));

    blockResourceUpdate = true;
    await dispatch({
      type: 'connectionRequested',
      mcpRelayUrl: 'ws://relay/owned',
      connectionId: 'owned',
      taskId: 'owned-task',
    }, 104);
    expect(await dispatch({ type: 'connectToTab', clientName: 'owned-client' }, 104)).toEqual({ success: true });
    const ownedWebSocket = MockWebSocket.instances.at(-1)!;
    ownedWebSocket.onmessage?.({ data: JSON.stringify({
      id: 1,
      method: 'chrome.debugger.attach',
      params: [{ tabId: 999 }, '1.3'],
    }) } as MessageEvent);
    await resourceUpdateStarted;

    expect(await dispatch({ type: 'disconnect', connectionId: 'owned' }, 105)).toEqual({ success: true });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect((await dispatch({ type: 'getConnectionStatus' }, 105)).connections).toContainEqual({
      connectionId: 'owned',
      clientName: 'owned-client',
      taskId: 'owned-task',
      connectedTabIds: [],
    });
    queriedTabs = [{ id: 999, windowId: 1, url: 'about:blank', title: 'Owned tab' }];
    expect(await dispatch({ type: 'getTabs' }, 105)).toEqual({ success: true, tabs: [], currentTabId: 105 });

    releaseResourceUpdate();
    await expect.poll(() => removedTabIds).toContain(999);
    await expect.poll(async () => (await dispatch({ type: 'getConnectionStatus' }, 105)).connections)
        .not.toContainEqual(expect.objectContaining({ connectionId: 'owned' }));
  } finally {
    releaseGroupUpdate();
    releaseResourceUpdate();
    globalThis.chrome = originalChrome;
    globalThis.WebSocket = originalWebSocket;
  }
});
