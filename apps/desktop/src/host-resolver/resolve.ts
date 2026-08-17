/**
 * Fallback module resolution for a Host whose installation is an asar archive.
 *
 * The Loader anchors bare plugin specifiers at the profile directory, and the
 * CLI normally makes them resolvable there by symlinking every in-box package
 * into `$DSH_HOME/profiles/node_modules`. A packaged desktop cannot: paths
 * inside an asar archive exist only to Electron's patched `fs`, not to the
 * operating system, so a symlink pointing there never resolves. This hook is
 * the replacement — a bare specifier that default resolution cannot find is
 * retried anchored at the archived installation, whose `node_modules` the
 * patched `fs` serves.
 *
 * Registered through `module.registerHooks`, which intercepts both ESM
 * `import` and CommonJS `require`, so one hook covers every resolution the
 * Host performs.
 */

/** The subset of a `registerHooks` resolve context this hook reads and rewrites. */
export interface ResolveContext {
  /** URL of the module the specifier appears in. */
  parentURL?: string | undefined
}

/**
 * Whether a specifier needs package resolution: not relative, not absolute,
 * and not already a URL (which also excludes `node:` builtins and Windows
 * drive paths, both of which parse as URLs).
 * @param specifier - the raw import or require specifier.
 * @returns `true` for a bare package specifier.
 */
export function isBareSpecifier(specifier: string): boolean {
  return !specifier.startsWith('.') && !specifier.startsWith('/') && !URL.canParse(specifier)
}

/** Whether a thrown resolution failure means "not found" on either module system. */
function isNotFound(error: unknown): boolean {
  const code = (error as { code?: unknown }).code
  return code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND'
}

/** A settled resolution the chain accepts for both module systems. */
export interface ShortCircuitResolution {
  /** Marks the chain as finished at this hook. */
  shortCircuit: true
  /** `file:` URL of the resolved module. */
  url: string
}

/**
 * Build the resolve hook, generic over the chain's result so it satisfies
 * `registerHooks` without restating Node's own hook types.
 *
 * The fallback resolves through `resolveFromAnchor` rather than by retrying
 * `nextResolve` with a rewritten `parentURL`: the default resolver honors the
 * rewrite for `import` but not for `require`, and a `createRequire` pinned at
 * the archive walks its `node_modules` for both.
 * @param resolveFromAnchor - resolve one bare specifier from the archived
 * installation, returning the absolute file path (`require.resolve` at the
 * archive's own package.json).
 * @param toFileUrl - convert that path to a `file:` URL.
 * @returns a `registerHooks`-shaped resolve function.
 */
export function createFallbackResolve(
  resolveFromAnchor: (specifier: string) => string,
  toFileUrl: (path: string) => string,
) {
  return <Result>(
    specifier: string,
    context: ResolveContext,
    nextResolve: (specifier: string, context: ResolveContext) => Result,
  ): Result | ShortCircuitResolution => {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (!isBareSpecifier(specifier) || !isNotFound(error)) throw error
      let resolved: string
      try {
        resolved = resolveFromAnchor(specifier)
      } catch {
        // Not in the archive either: the original failure names the module
        // and the place it was first looked for, which is the useful report.
        throw error
      }
      return { shortCircuit: true, url: toFileUrl(resolved) }
    }
  }
}
