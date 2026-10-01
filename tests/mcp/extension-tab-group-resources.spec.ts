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
import { ConnectedTabGroup } from '../../packages/extension/src/connectedTabGroup';
import { cleanupStalePlaywrightGroups, groupTitleForTask } from '../../packages/extension/src/taskResources';

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

class MockRelayConnection {
  attachedTabs = new Set<number>();
  claimedTabs = new Set<number>();
  targetWindowIds: number[] = [];
  onclose?: () => void;
  ontabattached?: (tabId: number) => void;
  ontabdetached?: (tabId: number) => void;
  onownedtabcreated?: (tabId: number) => void;

  setTargetWindow(windowId: number): void {
    this.targetWindowIds.push(windowId);
  }

  attachTab(tab: chrome.tabs.Tab): void {
    this.claimedTabs.add(tab.id!);
    this.attachedTabs.add(tab.id!);
    this.ontabattached?.(tab.id!);
  }

  detachTab(tabId: number): void {
    this.claimedTabs.delete(tabId);
    this.attachedTabs.delete(tabId);
    this.ontabdetached?.(tabId);
  }

  didInitialize(): void {
  }

  close(): void {
    this.claimedTabs.clear();
    this.attachedTabs.clear();
    this.onclose?.();
  }
}

test('updates the relay target window when the task group moves', async () => {
  const harness = installConnectedGroupChromeMock();
  try {
    const relay = new MockRelayConnection();
    new ConnectedTabGroup(relay as any, tab(7, 1), 'connection', 'task', false);
    await flushTasks();

    harness.tabsById.set(7, tab(7, 2, 42));
    harness.tabsOnAttached.emit(7, { newWindowId: 2, newPosition: 0 });
    await flushTasks();
    expect(relay.targetWindowIds).toEqual([1, 2]);
  } finally {
    harness.restore();
  }
});

test('persists task-owned tabs when grouping fails', async () => {
  const harness = installConnectedGroupChromeMock(9);
  try {
    const relay = new MockRelayConnection();
    new ConnectedTabGroup(relay as any, tab(7, 1), 'connection', 'task', false);
    await flushTasks();

    relay.onownedtabcreated?.(9);
    relay.claimedTabs.add(9);
    relay.attachedTabs.add(9);
    relay.ontabattached?.(9);
    await flushTasks();

    expect(harness.storedResources.at(-1)?.ownedTabIds).toContain(9);
  } finally {
    harness.restore();
  }
});

test('serializes creation of the first task group', async () => {
  let releaseFirstGroup!: () => void;
  let firstGroupStarted!: () => void;
  const firstGroupBarrier = new Promise<void>(resolve => releaseFirstGroup = resolve);
  const firstGroupStartedPromise = new Promise<void>(resolve => firstGroupStarted = resolve);
  let blockedFirstGroup = false;
  const harness = installConnectedGroupChromeMock(undefined, async ({ groupId }) => {
    if (groupId !== undefined || blockedFirstGroup)
      return;
    blockedFirstGroup = true;
    firstGroupStarted();
    await firstGroupBarrier;
  });
  try {
    const relay = new MockRelayConnection();
    new ConnectedTabGroup(relay as any, tab(7, 1), 'connection', 'task', false);
    await firstGroupStartedPromise;

    harness.tabsById.set(8, tab(8, 1));
    relay.claimedTabs.add(8);
    relay.attachedTabs.add(8);
    relay.ontabattached?.(8);
    await flushTasks();

    expect(harness.groupCalls.filter(call => call.groupId === undefined)).toHaveLength(1);
    releaseFirstGroup();
    await flushTasks();
    expect(harness.groupCalls).toEqual([
      { tabIds: [7] },
      { groupId: 42, tabIds: [8] },
    ]);
  } finally {
    releaseFirstGroup();
    harness.restore();
  }
});

test('waits for pending task group cleanup before releasing its claim', async () => {
  let releaseFirstGroup!: () => void;
  let firstGroupStarted!: () => void;
  const firstGroupBarrier = new Promise<void>(resolve => releaseFirstGroup = resolve);
  const firstGroupStartedPromise = new Promise<void>(resolve => firstGroupStarted = resolve);
  const harness = installConnectedGroupChromeMock(undefined, async ({ groupId }) => {
    if (groupId !== undefined)
      return;
    firstGroupStarted();
    await firstGroupBarrier;
  });
  try {
    const relay = new MockRelayConnection();
    const connectedTabGroup = new ConnectedTabGroup(relay as any, tab(7, 1), 'connection', 'task', false);
    let closed = false;
    connectedTabGroup.onclose = () => closed = true;
    await firstGroupStartedPromise;

    relay.close();
    await flushTasks();
    expect.soft(closed).toBe(false);
    expect.soft(connectedTabGroup.claimedTabIds()).toContain(7);

    releaseFirstGroup();
    await flushTasks();
    expect(closed).toBe(true);
    expect(harness.ungroupedTabIds).toContain(7);
  } finally {
    releaseFirstGroup();
    await flushTasks();
    harness.restore();
  }
});

test('rejects a tab claimed by another task when it enters the group', async () => {
  const harness = installConnectedGroupChromeMock();
  try {
    const relay = new MockRelayConnection();
    new (ConnectedTabGroup as any)(relay, tab(7, 1), 'connection', 'task', false, () => true);
    await flushTasks();

    const claimedByAnotherTask = tab(9, 1, 42);
    harness.tabsById.set(9, claimedByAnotherTask);
    harness.tabsOnUpdated.emit(9, { groupId: 42 }, claimedByAnotherTask);
    await flushTasks();

    expect(relay.attachedTabs).not.toContain(9);
    expect(harness.ungroupedTabIds).toContain(9);
  } finally {
    harness.restore();
  }
});

test('keeps borrowed claims stable across ordered group change listeners', async () => {
  const harness = installConnectedGroupChromeMock(undefined, undefined, [42, 43]);
  try {
    const relayA = new MockRelayConnection();
    const groupA = new ConnectedTabGroup(relayA as any, tab(7, 1), 'connection-a', 'task-a', false);
    await flushTasks();

    const initialTabB = tab(8, 1);
    harness.tabsById.set(8, tab(8, 1, 43));
    const relayB = new MockRelayConnection();
    new ConnectedTabGroup(
        relayB as any,
        initialTabB,
        'connection-b',
        'task-b',
        false,
        tabId => groupA.claimedTabIds().includes(tabId));
    await flushTasks();

    const movedTab = tab(7, 1, 43);
    harness.tabsById.set(7, movedTab);
    harness.tabsOnUpdated.emit(7, { groupId: 43 }, movedTab);
    await flushTasks();

    expect(relayA.attachedTabs).not.toContain(7);
    expect(relayB.attachedTabs).not.toContain(7);
    expect(harness.ungroupedTabIds).toContain(7);
  } finally {
    harness.restore();
  }
});

test('rejects a borrowed transfer when the destination listener runs first', async () => {
  const harness = installConnectedGroupChromeMock(undefined, undefined, [43, 42]);
  try {
    const groups: { a?: ConnectedTabGroup } = {};
    const relayB = new MockRelayConnection();
    const groupB = new ConnectedTabGroup(
        relayB as any,
        tab(8, 1),
        'connection-b',
        'task-b',
        false,
        tabId => groups.a?.claimedTabIds().includes(tabId) ?? false);
    await flushTasks();

    const relayA = new MockRelayConnection();
    groups.a = new ConnectedTabGroup(
        relayA as any,
        tab(7, 1),
        'connection-a',
        'task-a',
        false,
        tabId => groupB.claimedTabIds().includes(tabId));
    await flushTasks();

    const movedTab = tab(7, 1, 43);
    harness.tabsById.set(7, movedTab);
    harness.tabsOnUpdated.emit(7, { groupId: 43 }, movedTab);
    await flushTasks();

    expect(relayA.attachedTabs).not.toContain(7);
    expect(relayB.attachedTabs).not.toContain(7);
    expect(harness.ungroupedTabIds).toContain(7);
  } finally {
    harness.restore();
  }
});

test('does not ungroup a borrowed tab reassigned during cleanup', async () => {
  const harness = installConnectedGroupChromeMock();
  try {
    const relay = new MockRelayConnection();
    new ConnectedTabGroup(relay as any, tab(7, 1), 'connection', 'task', false);
    await flushTasks();

    relay.close();
    harness.tabsById.set(7, tab(7, 1, 43));
    await flushTasks();

    expect(harness.ungroupedTabIds).toEqual([]);
  } finally {
    harness.restore();
  }
});

test('ungroups a borrowed tab that remains in the task group during cleanup', async () => {
  const harness = installConnectedGroupChromeMock();
  try {
    const relay = new MockRelayConnection();
    new ConnectedTabGroup(relay as any, tab(7, 1), 'connection', 'task', false);
    await flushTasks();

    relay.close();
    await flushTasks();

    expect(harness.ungroupedTabIds).toEqual([7]);
  } finally {
    harness.restore();
  }
});

test('preserves user-created tabs in the task group', async () => {
  const harness = installConnectedGroupChromeMock();
  try {
    const relay = new MockRelayConnection();
    new ConnectedTabGroup(relay as any, tab(7, 1), 'connection', 'task', false);
    await flushTasks();

    harness.tabsById.set(8, tab(8, 1, 42));
    harness.tabsOnCreated.emit(tab(8, 1, 42));
    harness.tabsById.set(9, tab(9, 1, 42));
    relay.onownedtabcreated?.(9);
    harness.tabsOnCreated.emit(tab(9, 1, 42));
    await flushTasks();

    relay.close();
    await flushTasks();

    expect(harness.removedTabIds).toContain(9);
    expect(harness.removedTabIds).not.toContain(8);
    expect(harness.ungroupedTabIds).toEqual(expect.arrayContaining([7, 8]));
  } finally {
    harness.restore();
  }
});

test('keeps a detached owned tab reserved without reporting it as connected', async () => {
  const harness = installConnectedGroupChromeMock();
  try {
    const relay = new MockRelayConnection();
    const connectedTabGroup = new ConnectedTabGroup(relay as any, tab(7, 1), 'connection', 'task', false);
    await flushTasks();

    harness.tabsById.set(9, tab(9, 1, 42));
    relay.onownedtabcreated?.(9);
    harness.tabsOnCreated.emit(tab(9, 1, 42));
    await flushTasks();

    const movedTab = tab(9, 2, -1);
    harness.tabsById.set(9, movedTab);
    harness.tabsOnUpdated.emit(9, { groupId: -1 }, movedTab);
    await flushTasks();

    expect(harness.storedResources.at(-1)?.ownedTabIds).toContain(9);
    expect(connectedTabGroup.connectedTabIds()).not.toContain(9);
    expect(connectedTabGroup.claimedTabIds()).toContain(9);
    relay.close();
    await flushTasks();
    expect(harness.removedTabIds).toContain(9);
  } finally {
    harness.restore();
  }
});

test('stale recovery closes task-owned tabs outside the group', async () => {
  const originalChrome = globalThis.chrome;
  const removedTabIds: number[] = [];
  const groupTitle = groupTitleForTask('task', 'connection');
  globalThis.chrome = {
    action: {
      setBadgeText: async () => {},
      setTitle: async () => {},
    },
    storage: {
      session: {
        get: async () => ({
          'playwright.taskResources.connection': {
            version: 1,
            connectionId: 'connection',
            groupId: 42,
            groupTitle,
            tabIds: [7],
            ownedTabIds: [9],
          },
        }),
        remove: async () => {},
      },
    },
    tabGroups: {
      get: async () => ({ id: 42, title: groupTitle }),
      query: async () => [],
    },
    tabs: {
      get: async (tabId: number) => tab(tabId, tabId === 9 ? 2 : 1),
      query: async ({ groupId }: { groupId?: number }) => groupId === 42 ? [tab(7, 1, 42)] : [],
      remove: async (tabIds: number | number[]) => removedTabIds.push(...(Array.isArray(tabIds) ? tabIds : [tabIds])),
      ungroup: async () => {},
    },
  } as any;
  try {
    await cleanupStalePlaywrightGroups();
    expect(removedTabIds).toContain(9);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('stale recovery ignores task resources from a previous browser session', async () => {
  const originalChrome = globalThis.chrome;
  const removedTabIds: number[] = [];
  globalThis.chrome = {
    action: {
      setBadgeText: async () => {},
      setTitle: async () => {},
    },
    storage: {
      local: {
        get: async () => ({
          'playwright.taskResources.previous-session': {
            version: 1,
            connectionId: 'previous-session',
            groupId: 42,
            groupTitle: groupTitleForTask('task', 'previous-session'),
            tabIds: [],
            ownedTabIds: [9],
          },
        }),
        remove: async () => {},
      },
      session: {
        get: async () => ({}),
        remove: async () => {},
      },
    },
    tabGroups: {
      get: async () => { throw new Error('Group not found'); },
      query: async () => [],
    },
    tabs: {
      get: async (tabId: number) => tab(tabId, 1),
      query: async () => [],
      remove: async (tabIds: number | number[]) => removedTabIds.push(...(Array.isArray(tabIds) ? tabIds : [tabIds])),
      ungroup: async () => {},
    },
  } as any;
  try {
    await cleanupStalePlaywrightGroups();
    expect(removedTabIds).toEqual([]);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('stale recovery leaves unrecorded user tab groups unchanged', async () => {
  const originalChrome = globalThis.chrome;
  const ungroupedTabIds: number[] = [];
  globalThis.chrome = {
    storage: {
      session: {
        get: async () => ({}),
      },
    },
    tabGroups: {
      query: async () => [{ id: 42, title: 'Playwright · Docs' }],
    },
    tabs: {
      query: async () => [tab(7, 1, 42)],
      ungroup: async (tabIds: number | number[]) => ungroupedTabIds.push(...(Array.isArray(tabIds) ? tabIds : [tabIds])),
    },
  } as any;
  try {
    await cleanupStalePlaywrightGroups();
    expect(ungroupedTabIds).toEqual([]);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

function installConnectedGroupChromeMock(groupingFailureTabId?: number, beforeGroup?: (details: { groupId?: number, tabIds: number[] }) => Promise<void>, newGroupIds: number[] = [42]) {
  const originalChrome = globalThis.chrome;
  const tabsOnAttached = new MockEvent();
  const tabsOnCreated = new MockEvent();
  const tabsOnRemoved = new MockEvent();
  const tabsOnUpdated = new MockEvent();
  const storedResources: any[] = [];
  const removedTabIds: number[] = [];
  const ungroupedTabIds: number[] = [];
  const groupCalls: { groupId?: number, tabIds: number[] }[] = [];
  let newGroupIndex = 0;
  const tabsById = new Map<number, chrome.tabs.Tab>([[7, tab(7, 1, 42)]]);
  globalThis.chrome = {
    action: {
      setBadgeBackgroundColor: async () => {},
      setBadgeText: async () => {},
      setTitle: async () => {},
    },
    storage: {
      session: {
        remove: async () => {},
        set: async (record: Record<string, any>) => storedResources.push(Object.values(record)[0]),
      },
    },
    tabGroups: {
      update: async () => ({}),
    },
    tabs: {
      group: async ({ groupId, tabIds }: { groupId?: number, tabIds: number | number[] }) => {
        const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
        const call = { groupId, tabIds: ids };
        groupCalls.push(call);
        await beforeGroup?.(call);
        if (groupingFailureTabId !== undefined && ids.includes(groupingFailureTabId))
          throw new Error('Tabs can only be moved to groups in the same window');
        return groupId ?? newGroupIds[newGroupIndex++] ?? 42;
      },
      get: async (tabId: number) => tabsById.get(tabId)!,
      onAttached: tabsOnAttached,
      onCreated: tabsOnCreated,
      onRemoved: tabsOnRemoved,
      onUpdated: tabsOnUpdated,
      remove: async (tabIds: number | number[]) => removedTabIds.push(...(Array.isArray(tabIds) ? tabIds : [tabIds])),
      ungroup: async (tabIds: number | number[]) => ungroupedTabIds.push(...(Array.isArray(tabIds) ? tabIds : [tabIds])),
    },
  } as any;
  return {
    storedResources,
    groupCalls,
    tabsById,
    tabsOnAttached,
    tabsOnCreated,
    tabsOnUpdated,
    removedTabIds,
    ungroupedTabIds,
    restore: () => globalThis.chrome = originalChrome,
  };
}

function tab(id: number, windowId: number, groupId = chrome.tabs.TAB_ID_NONE): chrome.tabs.Tab {
  return { id, windowId, groupId, index: 0, active: false, pinned: false, highlighted: false, incognito: false, selected: false, discarded: false, autoDiscardable: true };
}

async function flushTasks(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}
