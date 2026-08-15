/** The Account section: get a DeepSeek API key into the model credential. */

import { useEffect, useState, type ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { AccountPage } from '../bridge.ts'
import type { AccountPageState, AccountStore } from './account-store.ts'
import css from './AccountSection.module.css'

/** What the plugin injects into this section. */
export interface AccountSectionInjected {
  /** The page controller. */
  readonly controller: AccountStore
  /** Snapshot selector bound to the controller's store. */
  readonly useSnapshot: <T>(select: (state: AccountPageState) => T) => T
  /** Dictionary lookup for this section's namespace. */
  readonly t: TranslateNS<'account'>
}

/**
 * Full component props: the section owner share, with this plugin's injection
 * flattened onto it the way the slot runtime composes an `inject` factory.
 */
export type AccountSectionComponentProps =
  PropsRuntime<'settings.section'> & AccountSectionInjected

/** One Setting-Cell row: title over description, control at the row's end. */
function Row({ title, description, children }: {
  title: string
  description?: string | undefined
  children?: ReactNode
}) {
  return (
    <div className={css.row}>
      <div className={css.rowText}>
        <div className={css.title}>{title}</div>
        {description !== undefined && <div className={css.description}>{description}</div>}
      </div>
      {children}
    </div>
  )
}

/** Mask a key down to its recognizable ends. */
function maskKey(value: string): string {
  return value.length <= 12 ? '••••••••' : `${value.slice(0, 7)}••••••••${value.slice(-4)}`
}

/** The obtained key: its value behind a reveal, for this session only. */
function KeyRow({ state, t }: { state: AccountPageState; t: TranslateNS<'account'> }) {
  const [revealed, setRevealed] = useState(false)
  const value = state.keyValue
  if (value === undefined) return null
  return (
    <Row title={t('key.title')}>
      <span className={css.keyValue}>{revealed ? value : maskKey(value)}</span>
      <button
        type="button"
        className={css.linkButton}
        onClick={() => { setRevealed(current => !current) }}
      >
        {revealed ? t('key.hide') : t('key.show')}
      </button>
    </Row>
  )
}

/** The key row's description, which says what its button will do. */
function keyDescription(state: AccountPageState, t: TranslateNS<'account'>): string {
  if (state.status === 'loading') return t('state.loading')
  if (state.credentialRef === undefined) return t('state.noRef')
  if (state.configured && !state.writable) return t('state.readonly')
  return state.configured ? t('intro.configured') : t('intro')
}

/**
 * Render the account page.
 * @param props - composed slot props including this plugin's injection.
 * @returns the section element tree.
 */
export function AccountSection({ controller, useSnapshot, t }: AccountSectionComponentProps) {
  const state = useSnapshot(s => s)

  useEffect(() => { void controller.load() }, [controller])

  const busy = state.busy !== 'none'
  const links: readonly { page: AccountPage; title: string; description?: string }[] = [
    { page: 'top-up', title: t('links.topUp') },
    { page: 'usage', title: t('links.usage') },
    { page: 'billing', title: t('links.billing') },
    { page: 'api-keys', title: t('links.apiKeys') },
  ]

  return (
    <div className={css.section}>
      <Row title={t('title')} description={keyDescription(state, t)}>
        {state.credentialRef !== undefined && state.writable && (
          <button
            type="button"
            className={css.primaryButton}
            disabled={busy}
            onClick={() => { void controller.provision() }}
          >
            {state.busy === 'provisioning'
              ? t('action.provisioning')
              : state.configured ? t('action.replace') : t('action.provision')}
          </button>
        )}
      </Row>

      <KeyRow state={state} t={t} />


      {state.error !== undefined && (
        <Row title={t('error.title')} description={state.error} />
      )}

      {links.map(link => (
        <Row
          key={link.page}
          title={link.title}
          {...link.description === undefined ? {} : { description: link.description }}
        >
          <button type="button" className={css.linkButton} onClick={() => { void controller.openPage(link.page) }}>
            {t('links.open')}
          </button>
        </Row>
      ))}
    </div>
  )
}
