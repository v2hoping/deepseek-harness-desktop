import { defineConfig } from 'tsdown'

/**
 * Two artifacts with different module formats. The main entry stays ESM, while
 * the preload must be CommonJS: Electron cannot load an ES module into a
 * sandboxed preload. Electron itself stays external in both.
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
    outputOptions: { entryFileNames: 'preload.cjs' },
    dts: false,
    clean: false,
    deps: { neverBundle: ['electron'] },
  },
  {
    // The packaged Host's --import resolver: one self-contained file shipped
    // beside host.asar, loaded by the spawned Host before any module of its own.
    entry: ['lib/types/host-resolver/register.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    outputOptions: { entryFileNames: 'host-resolver.mjs' },
    dts: false,
    clean: false,
  },
])
