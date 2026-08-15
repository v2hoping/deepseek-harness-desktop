/**
 * The renderer's complete view of the desktop shell: the account methods, and
 * nothing else. No raw IPC channel, no Node API, and no filesystem access
 * crosses this bridge.
 *
 * Emitted as CommonJS: a sandboxed preload script cannot be an ES module.
 */

import { contextBridge, ipcRenderer } from 'electron'
import type { AccountBridge, AccountPage } from '@deepseek-ai/dsh-desktop-account/bridge'
import { ACCOUNT_CHANNELS } from './account/channels.ts'

const account: AccountBridge = {
  checkKey: secret => ipcRenderer.invoke(ACCOUNT_CHANNELS.checkKey, secret),
  openPage: (page: AccountPage) => ipcRenderer.invoke(ACCOUNT_CHANNELS.openPage, page),
  provisionKey: () => ipcRenderer.invoke(ACCOUNT_CHANNELS.provisionKey),
}

contextBridge.exposeInMainWorld('dshDesktop', { account })
