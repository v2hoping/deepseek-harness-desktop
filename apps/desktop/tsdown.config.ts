import { defineConfig } from 'tsdown'

/**
 * The desktop shell ships one entry: the Electron main-process module named by
 * package.json `main`. The root tsdown builds only `lib/types/index.js`, so
 * this override points at `lib/types/main.js` instead; its reachable modules
 * bundle with it. Declarations come from `tsc -b` (dts: false), matching every
 * package. Electron's own modules stay external — they are resolved by the
 * Electron runtime, not bundled.
 */
export default defineConfig({
  entry: ['lib/types/main.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  deps: { neverBundle: ['electron'] },
})
