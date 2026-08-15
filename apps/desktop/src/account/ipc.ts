/** The account channels the preload bridge forwards from the renderer. */

import { ipcMain, net } from 'electron'
import type { AccountPage } from '@deepseek-ai/dsh-desktop-account/bridge'
import { openAccountPage, provisionKey } from './account-window.ts'
import { probeBalance } from './balance.ts'
import { ACCOUNT_CHANNELS } from './channels.ts'
import { PLATFORM_PAGES } from './platform-pages.ts'

function isAccountPage(value: unknown): value is AccountPage {
  return typeof value === 'string' && Object.hasOwn(PLATFORM_PAGES, value)
}

/**
 * Install the account IPC handlers once, before the first renderer loads.
 * Arguments cross a process boundary, so each one is validated here.
 */
export function registerAccountIpc(): void {
  ipcMain.handle(ACCOUNT_CHANNELS.checkKey, async (_event, secret: unknown) => {
    if (typeof secret !== 'string' || secret === '') {
      return { ok: false, reason: 'invalid-key', message: 'no API key was supplied' }
    }
    return probeBalance(secret, (input, init) => net.fetch(input, init))
  })

  ipcMain.handle(ACCOUNT_CHANNELS.openPage, (_event, page: unknown) => {
    if (!isAccountPage(page)) throw new Error(`unknown account page: ${String(page)}`)
    openAccountPage(page)
  })

  ipcMain.handle(ACCOUNT_CHANNELS.provisionKey, async () => provisionKey())
}
