/**
 * Bare plugin-specifier resolution for the Electron main process.
 *
 * The Loader resolves a row's package name through Node's internal
 * `ModuleLoader`, which it obtains from the `node-addon-require-builtin`
 * native helper (`vendor/loader/src/internal.ts`). That helper reaches Node's
 * realm through the V8 symbol `GetAlignedPointerFromEmbedderData`, which
 * Electron's V8 embedding does not expose — the addon loads but its
 * `requireBuiltin` refuses, so `loader.internal` stays `undefined`. The
 * Loader then falls back to a plain `import(name)`, which resolves from
 * `vendor/loader/lib/index.js` instead of the profile directory, and every
 * `@deepseek-ai/*` row fails with "Cannot find package".
 *
 * This is a structural difference between Node and Electron, not an ABI
 * mismatch: rebuilding the addon cannot fix it.
 *
 * The stand-in below restores the one behaviour the plugin path needs —
 * resolving a specifier against the profile's own directory, where
 * `healProfilesModuleFallback` has linked this installation's dependency
 * closure. It deliberately implements only `import`, the single member
 * `EntryTree.import` calls; HMR uses `resolve`, `resolveSync`, and
 * `loadCache`, and the desktop surface mounts no HMR row, so those stay
 * absent rather than being faked into something that would misbehave.
 */

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'

/**
 * Resolve one specifier the way the Loader's internal path would, then import
 * it. Relative specifiers keep resolving beside the configuration file;
 * everything else resolves through Node's package algorithm anchored at the
 * parent, which is the profile directory holding the linked closure.
 * @param specifier - the row's plugin specifier.
 * @param parentURL - the Loader's base URL (the profile directory).
 * @returns the imported module namespace.
 */
async function importFrom(specifier: string, parentURL: string): Promise<unknown> {
  if (specifier.startsWith('.')) return import(new URL(specifier, parentURL).href)
  const resolved = createRequire(parentURL).resolve(specifier)
  return import(pathToFileURL(resolved).href)
}

/**
 * Install the stand-in when Electron denied the Loader its internal module
 * loader. A no-op wherever the real one is available, so the same assembly
 * keeps Node's behaviour when it runs outside Electron.
 * @param ctx - the context carrying an initialized Loader service.
 */
export function installBareSpecifierResolution(ctx: Context): void {
  const loader = ctx.get('loader')
  if (loader === undefined || loader.internal !== undefined) return
  // Only `import` is reachable from the plugin path; the remaining
  // ModuleLoader members belong to HMR, which this surface does not mount.
  // The assertion is the narrowing that TypeScript cannot express for a
  // deliberately partial implementation of an external interface.
  loader.internal = { version: 'v2', import: importFrom } as unknown as NonNullable<typeof loader.internal>
}
