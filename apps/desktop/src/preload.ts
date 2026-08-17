/**
 * The renderer's complete view of the desktop shell: the account methods and
 * the directory chooser, and nothing else. No raw IPC channel, no Node API,
 * and no filesystem access crosses this bridge.
 *
 * Emitted as CommonJS: a sandboxed preload script cannot be an ES module.
 */

import { contextBridge, ipcRenderer } from 'electron'
import type { AccountBridge, AccountPage } from '@deepseek-ai/dsh-desktop-account/bridge'
import type { DirectoryBridge } from './directory-picker/ipc.ts'
import { ACCOUNT_CHANNELS } from './account/channels.ts'
import { DIRECTORY_CHANNELS } from './directory-picker/channels.ts'

const account: AccountBridge = {
  openPage: (page: AccountPage) => ipcRenderer.invoke(ACCOUNT_CHANNELS.openPage, page),
  provisionKey: () => ipcRenderer.invoke(ACCOUNT_CHANNELS.provisionKey),
}

const directories: DirectoryBridge = {
  pick: () => ipcRenderer.invoke(DIRECTORY_CHANNELS.pick) as Promise<string | null>,
}

contextBridge.exposeInMainWorld('dshDesktop', { account, directories })
