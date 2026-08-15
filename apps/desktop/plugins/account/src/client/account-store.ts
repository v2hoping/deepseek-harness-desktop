/**
 * Account page controller: read how the DeepSeek provider is credentialed, and
 * drive the two paths that put a working key there.
 *
 * Both paths validate before they store. `credentials.describe` never returns
 * values, so an already-stored key cannot be re-checked from here — what this
 * controller guarantees is that a key it writes was accepted by the public
 * balance endpoint first.
 */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { AccountBridge, AccountPage, BalanceSummary } from '../bridge.ts'

/** The provider route this page configures. */
const DEEPSEEK_ROUTE = 'deepseek-official'

/** What the page renders. */
export interface AccountPageState {
  /** Load state of the provider/credential read. */
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** Credential reference the DeepSeek profile names, when it names one. */
  credentialRef?: string | undefined
  /** Whether some layer already supplies a key. */
  configured: boolean
  /** Winning layer when configured (`env`, `file`, …). */
  source?: string | undefined
  /** Whether this reference can be written from here. */
  writable: boolean
  /** Whether the provider route is registered and requestable. */
  active: boolean
  /** Balance from the most recent successful validation this session. */
  balance?: BalanceSummary | undefined
  /** In-flight operation, so the page can disable its actions. */
  busy: 'none' | 'provisioning' | 'saving'
  /** Last failure, shown until the next attempt. */
  error?: string | undefined
  /** Last success, shown until the next attempt. */
  notice?: string | undefined
}

const INITIAL: AccountPageState = {
  status: 'idle',
  configured: false,
  writable: false,
  active: false,
  busy: 'none',
}

/** Read a nested value without pulling in the schema-form helpers. */
function valueAtPath(root: unknown, path: readonly string[]): unknown {
  let current = root
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

/** The credential reference a resolved provider profile names. */
function credentialRefOf(profile: unknown): string | undefined {
  if (typeof profile !== 'object' || profile === null) return undefined
  const ref = (profile as { apiKeyEnv?: unknown }).apiKeyEnv
  return typeof ref === 'string' && ref.length > 0 ? ref : undefined
}

/** One provider row as `llm.providers` reports it. */
interface ProviderRow {
  /** Provider route key (`deepseek-official`, …). */
  provider: string
  /** Settings namespace configuring this provider. */
  settingsNs: string
  /** Path from that namespace's root to the provider profile. */
  settingsPath: string[]
  /** Whether the route is registered and requestable. */
  active: boolean
}

/** One settings namespace as `settings.describe` reports it. */
interface NamespaceRow {
  /** Namespace key. */
  ns: string
  /** Resolved namespace value. */
  value: unknown
}

/** One credential's state as `credentials.describe` reports it — never its value. */
interface CredentialRow {
  /** Whether some layer supplies a non-empty value. */
  configured: boolean
  /** Winning layer when configured. */
  source?: string
  /** Whether `credentials.set` can affect this reference. */
  writable: boolean
}

/** One RPC outcome: a business value or its error. */
type RpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { message: string } }

/** The envelope every unary RPC answers with. */
interface RpcEnvelope<T> {
  /** Business outcome of the call. */
  result: RpcResult<T>
}

/** The wire face this controller needs, narrowed to the three domains it calls. */
export interface AccountApi {
  /** Provider directory. */
  readonly llm: {
    /**
     * List configurable providers.
     * @param request - empty request body.
     * @returns the provider rows.
     */
    providers(request: Record<string, never>): Promise<RpcEnvelope<{ providers: readonly ProviderRow[] }>>
  }
  /** Settings namespaces. */
  readonly settings: {
    /**
     * Describe every settings namespace.
     * @param request - empty request body.
     * @returns the namespace rows.
     */
    describe(request: Record<string, never>): Promise<RpcEnvelope<{ namespaces: readonly NamespaceRow[] }>>
  }
  /** Credential references. */
  readonly credentials: {
    /**
     * Describe the named references.
     * @param request - the references to describe.
     * @returns each reference's state, never its value.
     */
    describe(request: { refs: string[] }): Promise<RpcEnvelope<{ credentials: Record<string, CredentialRow> }>>
    /**
     * Store one credential value.
     * @param request - the reference and the value to store.
     * @returns the stored reference's new state.
     */
    set(request: { ref: string; value: string }): Promise<RpcEnvelope<unknown>>
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Controller for the account settings page. */
export class AccountStore {
  /** The snapshot the section renders from. */
  readonly store: SnapshotStore<AccountPageState> = createSnapshotStore<AccountPageState>(INITIAL)

  /** Latest load wins; an older response never overwrites a newer one. */
  private generation = 0

  /**
   * @param api - the wire face (llm/settings/credentials domains).
   * @param bridge - the Electron account bridge.
   */
  constructor(private readonly api: AccountApi, private readonly bridge: AccountBridge) {}

  /** Read the DeepSeek provider's credential state into the snapshot. */
  async load(): Promise<void> {
    const generation = ++this.generation
    this.store.update((s) => { s.status = 'loading'; s.error = undefined })
    try {
      const [providers, settings] = await Promise.all([
        this.api.llm.providers({}),
        this.api.settings.describe({}),
      ])
      if (!providers.result.ok) throw new Error(providers.result.error.message)
      if (!settings.result.ok) throw new Error(settings.result.error.message)

      const entry = providers.result.value.providers.find(p => p.provider === DEEPSEEK_ROUTE)
      const namespace = entry === undefined
        ? undefined
        : settings.result.value.namespaces.find(n => n.ns === entry.settingsNs)
      const ref = entry === undefined || namespace === undefined
        ? undefined
        : credentialRefOf(valueAtPath(namespace.value, entry.settingsPath))

      let credential: CredentialRow | undefined
      if (ref !== undefined) {
        const described = await this.api.credentials.describe({ refs: [ref] })
        if (described.result.ok) credential = described.result.value.credentials[ref]
      }
      if (generation !== this.generation) return
      this.store.update((s) => {
        s.status = 'ready'
        s.error = undefined
        s.credentialRef = ref
        s.configured = credential?.configured ?? false
        s.source = credential?.source
        s.writable = credential?.writable ?? false
        s.active = entry?.active ?? false
      })
    } catch (error) {
      if (generation !== this.generation) return
      this.store.update((s) => { s.status = 'error'; s.error = messageOf(error) })
    }
  }

  /**
   * Open the official API keys page and store whatever key the user creates
   * there, once the public endpoint accepts it.
   */
  async provision(): Promise<void> {
    this.store.update((s) => { s.busy = 'provisioning'; s.error = undefined; s.notice = undefined })
    try {
      const captured = await this.bridge.provisionKey()
      if (!captured.ok) {
        this.store.update((s) => {
          s.busy = 'none'
          // A closed window is the user's choice, not a failure to report.
          s.error = captured.reason === 'cancelled' ? undefined : captured.message
        })
        return
      }
      await this.storeKey(captured.value.secret)
    } catch (error) {
      this.store.update((s) => { s.busy = 'none'; s.error = messageOf(error) })
    }
  }

  /**
   * Validate and store a key the user pasted.
   * @param secret - the key to check and store.
   */
  async saveKey(secret: string): Promise<void> {
    const trimmed = secret.trim()
    if (trimmed === '') {
      this.store.update((s) => { s.error = 'enter an API key first' })
      return
    }
    this.store.update((s) => { s.busy = 'saving'; s.error = undefined; s.notice = undefined })
    await this.storeKey(trimmed)
  }

  /**
   * Open one official page.
   * @param page - which page to open.
   */
  async openPage(page: AccountPage): Promise<void> {
    await this.bridge.openPage(page)
  }

  /** Validate one key, store it under the provider's reference, and reload. */
  private async storeKey(secret: string): Promise<void> {
    const ref = this.store.getSnapshot().credentialRef
    if (ref === undefined) {
      this.store.update((s) => {
        s.busy = 'none'
        s.error = 'the DeepSeek provider names no credential reference to store into'
      })
      return
    }
    const checked = await this.bridge.checkKey(secret)
    if (!checked.ok) {
      this.store.update((s) => { s.busy = 'none'; s.error = checked.message })
      return
    }
    const stored = await this.api.credentials.set({ ref, value: secret })
    if (!stored.result.ok) {
      this.store.update((s) => { s.busy = 'none'; s.error = stored.result.ok ? '' : stored.result.error.message })
      return
    }
    this.store.update((s) => {
      s.busy = 'none'
      s.balance = checked.value
      s.notice = 'stored'
    })
    await this.load()
  }
}
