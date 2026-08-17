/**
 * The shell's own directory chooser, offered to the renderer.
 *
 * The Host can pick a directory too, but only by spawning a child process that
 * loads a native binding and drives the Win32 dialog itself. That child is the
 * application executable run as Node — starting it costs a cold Electron
 * launch, and on Windows an on-access virus scan of everything it touches, for
 * a dialog the shell can open with one call it already has.
 *
 * The chooser is modal to the window that asked, so a pick cannot be orphaned
 * behind it.
 */

import { BrowserWindow, dialog, ipcMain } from 'electron'
import { DIRECTORY_CHANNELS } from './channels.ts'

/** The renderer-facing surface exposed as `window.dshDesktop.directories`. */
export interface DirectoryBridge {
  /**
   * Open the platform directory chooser.
   * @returns the selected absolute path, or `null` when the user cancels.
   */
  pick(): Promise<string | null>
}

/**
 * Install the directory IPC handler once, before the first renderer loads.
 */
export function registerDirectoryIpc(): void {
  ipcMain.handle(DIRECTORY_CHANNELS.pick, async (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = { properties: ['openDirectory', 'createDirectory'] }
    const result = parent === null
      ? await dialog.showOpenDialog(options)
      : await dialog.showOpenDialog(parent, options)
    if (result.canceled) return null
    return result.filePaths[0] ?? null
  })
}
