/**
 * `--import` entry for the packaged Host: installs the archive fallback
 * resolver before any application module loads.
 *
 * Ships as one self-contained file beside `host.asar` — a real file, not an
 * archive member, so nothing has to be resolvable before the resolver itself
 * exists. The anchor is its own location: the archived installation sits in
 * the same resources directory.
 */

import { createRequire, registerHooks } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createFallbackResolve } from './resolve.ts'

const anchorPath = fileURLToPath(new URL('./host.asar/package.json', import.meta.url))
const anchorRequire = createRequire(anchorPath)

registerHooks({
  resolve: createFallbackResolve(
    specifier => anchorRequire.resolve(specifier),
    path => pathToFileURL(path).href,
  ),
})
