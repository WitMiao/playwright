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

export const PLAYWRIGHT_GROUP_TITLE_PREFIX = 'Playwright · ';

const STORAGE_KEY_PREFIX = 'playwright.taskResources.';

export type StoredTaskResources = {
  version: 1;
  connectionId: string;
  groupId: number;
  groupTitle: string;
  tabIds: number[];
  ownedTabIds: number[];
};

export function groupTitleForTask(taskId: string, connectionId: string): string {
  const taskLabel = taskId.trim().replace(/\s+/g, ' ').slice(0, 48) || 'task';
  const connectionLabel = connectionId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 8) || 'local';
  return `${PLAYWRIGHT_GROUP_TITLE_PREFIX}${taskLabel} · ${connectionLabel}`;
}

// Chrome tab IDs are scoped to a browser session, so recovery metadata must be too.
export async function storeTaskResources(resources: StoredTaskResources): Promise<void> {
  await chrome.storage.session.set({ [storageKey(resources.connectionId)]: resources });
}

export async function removeTaskResources(connectionId: string): Promise<void> {
  await chrome.storage.session.remove(storageKey(connectionId));
}

// A service-worker restart drops every relay WebSocket. Reconcile only resources
// recorded before the restart. Stored task-owned tabs are closed even if they
// live outside the group; borrowed tabs are touched only when the exact group
// title still matches.
export async function cleanupStalePlaywrightGroups(): Promise<void> {
  try {
    const storage = await chrome.storage.session.get(null);
    const records = Object.entries(storage)
        .filter(([key]) => key.startsWith(STORAGE_KEY_PREFIX))
        .map(([, value]) => value as StoredTaskResources);
    for (const record of records) {
      try {
        await cleanupRecord(record);
      } finally {
        await removeTaskResources(record.connectionId);
      }
    }
  } catch (error: any) {
    debugLog('Error cleaning recorded task resources:', error);
  }
}

async function cleanupRecord(record: StoredTaskResources): Promise<void> {
  let currentGroupTabIds: number[] = [];
  try {
    const group = await chrome.tabGroups.get(record.groupId);
    if (group.title === record.groupTitle) {
      const tabs = await chrome.tabs.query({ groupId: record.groupId });
      currentGroupTabIds = tabs.flatMap(tab => tab.id ?? []);
    }
  } catch {
    // The task group can disappear while task-owned tabs in other windows remain.
  }

  const ownedTabIds = await existingTabIds(record.ownedTabIds);
  const borrowedTabIds = currentGroupTabIds.filter(tabId => !record.ownedTabIds.includes(tabId));
  await clearBadges([...new Set([...currentGroupTabIds, ...ownedTabIds])]);
  if (ownedTabIds.length)
    await chrome.tabs.remove(ownedTabIds).catch(error => debugLog('Error closing stale task tabs:', error));
  await ungroupTabs(borrowedTabIds);
}

async function existingTabIds(tabIds: number[]): Promise<number[]> {
  const tabs = await Promise.all(tabIds.map(tabId => chrome.tabs.get(tabId).catch(() => undefined)));
  return tabs.flatMap(tab => tab?.id ?? []);
}

async function clearBadges(tabIds: number[]): Promise<void> {
  await Promise.all(tabIds.map(tabId => Promise.all([
    chrome.action.setBadgeText({ tabId, text: '' }),
    chrome.action.setTitle({ tabId, title: '' }),
  ]).catch(() => {})));
}

async function ungroupTabs(tabIds: number[]): Promise<void> {
  if (!tabIds.length)
    return;
  const [firstTabId, ...otherTabIds] = tabIds;
  await chrome.tabs.ungroup(otherTabIds.length ? [firstTabId, ...otherTabIds] : firstTabId)
      .catch(error => debugLog('Error ungrouping stale task tabs:', error));
}

function storageKey(connectionId: string): string {
  return STORAGE_KEY_PREFIX + connectionId;
}
