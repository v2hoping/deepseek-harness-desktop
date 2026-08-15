import { defineConfig } from 'tsdown'

/**
 * Two artifacts with different module systems.
 *
 * The main process is the ESM entry named by package.json `main`; its
 * reachable modules bundle with it. The preload script must be CommonJS —
 * a sandboxed preload is loaded as CJS regardless of the package `type` — so
 * it emits `.cjs`, which is also what `main.ts` points `webPreferences.preload`
 * at. Electron's own modules stay external in both: the runtime provides them.
 *
 * Declarations come from `tsc -b` (dts: false), matching every package.
 */
export default defineConfig([
  {
    entry: ['lib/types/main.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: { neverBundle: ['electron'] },
  },
  {
    entry: ['lib/types/preload.js'],
    outDir: 'lib',
    format: ['cjs'],
    platform: 'node',
    target: 'es2024',
    outExtensions: () => ({ js: '.cjs' }),
    dts: false,
    clean: false,
    deps: { neverBundle: ['electron'] },
  },
])
