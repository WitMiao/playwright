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

// Auth token storage shared by the background service worker and the
// extension pages. The token must live in chrome.storage (not localStorage)
// so the service worker can verify relay invites without a page being open.

export const AUTH_TOKEN_STORAGE_KEY = 'auth-token';

export function generateAuthToken(): string {
  // Generate a cryptographically secure random token
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  // Convert to base64 and make it URL-safe
  return btoa(String.fromCharCode.apply(null, Array.from(array)))
      .replace(/[+/=]/g, match => {
        switch (match) {
          case '+': return '-';
          case '/': return '_';
          case '=': return '';
          default: return match;
        }
      });
}

export async function getOrCreateAuthToken(): Promise<string> {
  const stored = await chrome.storage.local.get(AUTH_TOKEN_STORAGE_KEY);
  const token = stored?.[AUTH_TOKEN_STORAGE_KEY];
  if (typeof token === 'string' && token)
    return token;
  // One-time migration from the legacy localStorage copy. Only extension
  // pages have localStorage; the service worker skips straight to generating.
  const legacy = globalThis.localStorage?.getItem(AUTH_TOKEN_STORAGE_KEY);
  const next = (typeof legacy === 'string' && legacy) ? legacy : generateAuthToken();
  await chrome.storage.local.set({ [AUTH_TOKEN_STORAGE_KEY]: next });
  return next;
}
