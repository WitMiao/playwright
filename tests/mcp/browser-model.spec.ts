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

import { BrowserModel } from '../../packages/playwright-core/src/tools/mcp/browserModel';

test('creates new tabs in the background', async () => {
  const calls: { method: string, params: any }[] = [];
  const model = new BrowserModel(async (method, params) => {
    calls.push({ method, params });
    if (method === 'chrome.tabs.create')
      return { id: 17, index: 0, windowId: 1, active: false, pinned: false, url: params[0].url };
    if (method === 'chrome.debugger.sendCommand')
      return { targetInfo: { targetId: 'target-17', type: 'page', url: 'about:blank' } };
  });

  await model.createTarget('about:blank');

  expect(calls[0]).toEqual({
    method: 'chrome.tabs.create',
    params: [{ url: 'about:blank', active: false }],
  });
});
