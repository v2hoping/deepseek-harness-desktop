/**
 * IPC channel names shared by the main process and the preload bridge. Kept
 * free of Electron imports so the preload bundle carries no main-process code.
 */

/** The account channels the preload bridge forwards from the renderer. */
export const ACCOUNT_CHANNELS = {
  /** Probe one API key against the public balance endpoint. */
  checkKey: 'dsh-account:check-key',
  /** Open one official page in the platform-session window. */
  openPage: 'dsh-account:open-page',
  /** Open the API keys page and settle with the key the user creates. */
  provisionKey: 'dsh-account:provision-key',
} as const
