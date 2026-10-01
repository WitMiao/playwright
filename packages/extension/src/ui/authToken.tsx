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

import React, { useCallback, useEffect, useState } from 'react';
import { AUTH_TOKEN_STORAGE_KEY, generateAuthToken, getOrCreateAuthToken } from '../authToken';
import { CopyToClipboard } from './copyToClipboard';
import * as icons from './icons';
import './authToken.css';

export { generateAuthToken, getOrCreateAuthToken };

export const AuthTokenSection: React.FC<{}> = ({}) => {
  const [authToken, setAuthToken] = useState<string>('');

  useEffect(() => {
    void getOrCreateAuthToken().then(setAuthToken);
  }, []);

  const onRegenerateToken = useCallback(() => {
    const newToken = generateAuthToken();
    void chrome.storage.local.set({ [AUTH_TOKEN_STORAGE_KEY]: newToken });
    setAuthToken(newToken);
  }, []);

  // The token loads asynchronously from chrome.storage; render nothing until
  // it is ready so readers (and tests) never observe an empty token.
  if (!authToken)
    return null;

  return (
    <div className='auth-token-section'>
      <div className='auth-token-description'>
        Set this environment variable to bypass the connection dialog:
      </div>
      <div className='auth-token-container'>
        <code className='auth-token-code'>{authTokenCode(authToken)}</code>
        <button className='auth-token-refresh' title='Generate new token' aria-label='Generate new token'onClick={onRegenerateToken}>{icons.refresh()}</button>
        <CopyToClipboard value={authTokenCode(authToken)} />
      </div>
    </div>
  );
};

function authTokenCode(authToken: string) {
  return `PLAYWRIGHT_MCP_EXTENSION_TOKEN=${authToken}`;
}
