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
import { waitForConnectionToDisappear } from '../../packages/extension/src/ui/statusPolling';

test('waits for disconnect cleanup before refreshing status', async () => {
  const statuses = [['connection'], ['connection'], []];
  let statusCalls = 0;
  let delayCalls = 0;

  await waitForConnectionToDisappear(
      'connection',
      async () => statuses[statusCalls++] ?? [],
      async () => { ++delayCalls; });

  expect(statusCalls).toBe(3);
  expect(delayCalls).toBe(2);
});
