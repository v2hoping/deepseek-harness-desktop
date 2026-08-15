/**
 * Account plugin, browser half: registers the Account settings section, but
 * only in the Electron shell.
 *
 * The section's actions all need the desktop account bridge — opening an
 * official page in a window that carries the platform session, and observing
 * the key the user creates there. An ordinary `dsh web` browser tab has no
 * such capability, so this half registers nothing there and the Settings pages
 * stay exactly as they are.
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
// Type-only: the settings slot declarations plus the ctx.settingsScope merge.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls ctx.locale into this program.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { AccountSection, type AccountSectionInjected } from './AccountSection.tsx'
import { AccountStore, type AccountApi } from './account-store.ts'
import { en, zh, type AccountKey } from './locales.ts'

export type { AccountSectionComponentProps, AccountSectionInjected } from './AccountSection.tsx'
export type { AccountPageState } from './account-store.ts'
export { AccountStore } from './account-store.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Account page copy. */
    account: AccountKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'account'

/** Nav order: after the shipped sections, since this one is desktop-only. */
const NAV_ORDER = 50

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'connection']

/**
 * Register the Account section when the desktop bridge is present.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const bridge = globalThis.window.dshDesktop?.account
  // Browser tab: no account capability, so the page would have no working
  // action. Registering nothing keeps `dsh web` identical to before.
  if (bridge === undefined) return

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'desktop-account: dictionaries')
  const t = ctx.locale.bind(NS)

  const connection = ctx.get('connection') as ConnectionHandle
  const controller = new AccountStore(connection.api as unknown as AccountApi, bridge)
  const useSnapshot = bindSnapshotSelector(controller.store)
  const injected = (): AccountSectionInjected => ({ controller, useSnapshot, t })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'account',
    order: NAV_ORDER,
    label: () => t('nav'),
    locale: NS,
    inject: injected,
  }, AccountSection))
}
