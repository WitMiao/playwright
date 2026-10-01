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

import { extensionId, test, expect, readExtensionToken } from './extension-fixtures';

import type { BrowserContext } from 'playwright';

// The background service worker tracks the active tab through the same
// evaluate helper the other specs use.
async function activeTabInfo(browserContext: BrowserContext): Promise<{ url: string | undefined, active: boolean }[]> {
  const [sw] = browserContext.serviceWorkers();
  return await sw!.evaluate(async () => {
    const chrome = (globalThis as any).chrome;
    const tabs = await chrome.tabs.query({ active: true });
    return tabs.map((tab: any) => ({ url: tab.url, active: tab.active }));
  });
}

test('a token client connects silently without touching the user\'s tabs', async ({ browserWithExtension, startClient, server }) => {
  const browserContext = await browserWithExtension.launch();
  const userPage = await browserContext.newPage();
  await userPage.goto(server.HELLO_WORLD);

  const token = await readExtensionToken(browserContext);
  const connectPages: string[] = [];
  browserContext.on('page', page => {
    if (page.url().startsWith(`chrome-extension://${extensionId}/connect.html`))
      connectPages.push(page.url());
  });

  const { client } = await startClient({
    args: ['--extension'],
    env: {
      PLAYWRIGHT_MCP_EXTENSION_TOKEN: token,
      PWTEST_EXTENSION_USER_DATA_DIR: browserWithExtension.userDataDir,
    },
  });

  // The agent works in its own background task tab.
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.HELLO_WORLD } });

  // The user's tab is still the active one; the task tab is grouped but inactive.
  await expect.poll(async () => {
    const [sw] = browserContext.serviceWorkers();
    return await sw!.evaluate(async () => {
      const chrome = (globalThis as any).chrome;
      const [userTab] = await chrome.tabs.query({ active: true });
      const tabs = await chrome.tabs.query({});
      const taskTabs = tabs.filter((tab: any) => tab.groupId !== chrome.tabs.TAB_ID_NONE);
      if (!taskTabs.length)
        return null;
      const group = await chrome.tabGroups.get(taskTabs[0].groupId);
      return {
        activeUrl: userTab?.url,
        taskTabActive: taskTabs.some((tab: any) => tab.active),
        groupColor: group?.color,
      };
    });
  }).toEqual({
    activeUrl: server.HELLO_WORLD,
    taskTabActive: false,
    groupColor: 'green',
  });

  // No connect page ever appeared.
  await expect.poll(async () => connectPages.length).toBe(0);
});

test('the approval page opens in the background when no token is provided', async ({ browserWithExtension, startClient, server }) => {
  const browserContext = await browserWithExtension.launch();
  const userPage = await browserContext.newPage();
  await userPage.goto(server.HELLO_WORLD);

  const connectPagePromise = browserContext.waitForEvent('page', page =>
    page.url().startsWith(`chrome-extension://${extensionId}/connect.html`));
  const { client } = await startClient({
    args: ['--extension'],
    env: {
      PWTEST_EXTENSION_USER_DATA_DIR: browserWithExtension.userDataDir,
    },
  });

  // The extension browser is created lazily on the first tool call; the
  // approval page appears once the service worker picks up the invite.
  const navigatePromise = client.callTool({ name: 'browser_navigate', arguments: { url: server.HELLO_WORLD } });
  const connectPage = await connectPagePromise;

  // The dialog must not have stolen focus: the user's tab is still the active
  // one and the connect page tab sits in the background.
  await expect.poll(async () => {
    const [sw] = browserContext.serviceWorkers();
    return await sw!.evaluate(async () => {
      const chrome = (globalThis as any).chrome;
      const [userTab] = await chrome.tabs.query({ active: true });
      const tabs = await chrome.tabs.query({});
      const connectTab = tabs.find((tab: any) => (tab.url || '').startsWith(`chrome-extension://${chrome.runtime.id}/connect.html`));
      return { activeUrl: userTab?.url, connectTabActive: connectTab?.active ?? null };
    });
  }).toEqual({
    activeUrl: server.HELLO_WORLD,
    connectTabActive: false,
  });

  // Approving in the background completes the connection without switching tabs.
  await connectPage.getByRole('button', { name: 'Allow in background' }).click();
  expect(await navigatePromise).toHaveResponse({
    snapshot: expect.stringContaining(`Hello, world!`),
  });
  expect((await activeTabInfo(browserContext)).map(info => info.url)).toContain(server.HELLO_WORLD);
});

test('a second client connects while the first one is still connected', async ({ browserWithExtension, startClient, server }) => {
  test.setTimeout(90_000);
  const browserContext = await browserWithExtension.launch();
  const token = await readExtensionToken(browserContext);
  const env = {
    PLAYWRIGHT_MCP_EXTENSION_TOKEN: token,
    PWTEST_EXTENSION_USER_DATA_DIR: browserWithExtension.userDataDir,
  };

  const first = await startClient({ args: ['--extension'], env });
  await first.client.callTool({ name: 'browser_navigate', arguments: { url: server.HELLO_WORLD } });

  // The second relay binds the next free invite port; the discovery chain
  // must pick it up without a service worker restart.
  const second = await startClient({ args: ['--extension'], env });
  await second.client.callTool({ name: 'browser_navigate', arguments: { url: server.HELLO_WORLD } });

  const [sw] = browserContext.serviceWorkers();
  await expect.poll(async () => {
    return await sw!.evaluate(async () => {
      const chrome = (globalThis as any).chrome;
      const groups = await chrome.tabGroups.query({});
      return groups.filter(group => group.color === 'green').length;
    });
  }).toBe(2);
  console.log('=== FIRST CLIENT STDERR ===\n' + await first.stderr());
  console.log('=== SECOND CLIENT STDERR ===\n' + await second.stderr());
});
