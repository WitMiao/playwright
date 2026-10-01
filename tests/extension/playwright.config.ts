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

import { defineConfig } from '@playwright/test';

import type { TestOptions } from '../mcp/fixtures';

export default defineConfig<TestOptions>({
  testDir: './',
  // Discovery is asynchronous now: the service worker finds the relay by
  // scanning a fixed port range, which adds a variable grace period to every
  // connection, and heavier tests chain several connections.
  timeout: 90_000,
  // The discovery port range is machine-global, so concurrently running test
  // browsers would claim each other's invites.
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [
    ['list'],
    ['../config/parquetReporter.ts'],
  ] : 'list',
  projects: [
    { name: 'chromium', use: { mcpBrowser: 'chromium' } },
  ],
});
