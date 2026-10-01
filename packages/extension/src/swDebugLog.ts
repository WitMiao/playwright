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

// Small ring buffer of service-worker debug logs, readable from tests via
// `serviceWorker.evaluate(() => (globalThis as any).__pwSwLog)`.
const swLog: string[] = [];

export function swlog(message: string): void {
  swLog.push(`${Date.now() % 100000} ${message}`);
  if (swLog.length > 300)
    swLog.shift();
  (globalThis as any).__pwSwLog = swLog;
}
