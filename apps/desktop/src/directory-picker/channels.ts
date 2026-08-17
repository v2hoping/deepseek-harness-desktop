/** IPC channel names for the shell's own directory chooser. */

/** The renderer-to-main channels this feature owns. */
export const DIRECTORY_CHANNELS = {
  /** Open the platform directory chooser and resolve the selection. */
  pick: 'dsh:directories:pick',
} as const
