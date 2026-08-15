/**
 * Host loader entry for the browser implementation exported from `./client`.
 *
 * The account feature lives entirely in the renderer and the Electron main
 * process: sign-in needs the platform's own session and a top-level window,
 * neither of which the Host owns. This half exists so the Loader can mount the
 * package and `dsh-client-modules` can serve its browser bundle.
 *
 * Nothing about the obtained key is persisted here. The page shows the key it
 * just produced for the rest of the session and forgets it on exit; the key
 * itself lives only in the credential layer, where the credential subsystem
 * owns it.
 */

/** Plugin name the Loader records for this row. */
export const name = 'desktop-account'

/**
 * Mount the package without contributing Host behavior. Registering nothing
 * here is what keeps `dsh web` unchanged when the bundle is installed.
 */
export function apply(): void {
  // Intentionally empty: the browser half owns the Settings section, and the
  // Electron main process owns the account window and key capture.
}
