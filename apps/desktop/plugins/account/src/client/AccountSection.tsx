/** The Account section: get a DeepSeek API key into the model credential. */

import { useEffect, useState } from 'react'
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

/** One official-platform link row. */
function PlatformLink({ page, label, onOpen }: {
  page: AccountPage
  label: string
  onOpen: (page: AccountPage) => void
}) {
  return (
    <button type="button" className={css.link} onClick={() => { onOpen(page) }}>
      {label}
    </button>
  )
}

/**
 * Render the account page.
 * @param props - composed slot props including this plugin's injection.
 * @returns the section element tree.
 */
export function AccountSection({ controller, useSnapshot, t }: AccountSectionComponentProps) {
  const state = useSnapshot(s => s)
  const [pasted, setPasted] = useState('')

  useEffect(() => { void controller.load() }, [controller])

  const busy = state.busy !== 'none'
  const openPage = (page: AccountPage): void => { void controller.openPage(page) }

  return (
    <div className={css.section}>
      <h2 className={css.title}>{t('title')}</h2>
      <p className={css.intro}>{t('intro')}</p>

      <div className={css.status}>
        {state.status === 'loading' && <span className={css.muted}>{t('state.loading')}</span>}
        {state.status === 'ready' && state.credentialRef === undefined && (
          <span className={css.warn}>{t('state.noRef')}</span>
        )}
        {state.status === 'ready' && state.credentialRef !== undefined && (
          <>
            <span className={state.configured ? css.ok : css.warn}>
              {state.configured ? t('state.configured') : t('state.missing')}
            </span>
            {state.configured && state.source !== undefined && (
              <span className={css.muted}>{t('state.configured.source', { source: state.source })}</span>
            )}
            {state.configured && !state.writable && (
              <span className={css.muted}>{t('state.readonly')}</span>
            )}
          </>
        )}
        {state.balance !== undefined && (
          <span className={state.balance.available ? css.ok : css.warn}>
            {state.balance.available
              ? t('balance', { total: state.balance.total, currency: state.balance.currency })
              : t('balance.unavailable')}
          </span>
        )}
      </div>

      {state.error !== undefined && <p className={css.error}>{state.error}</p>}
      {state.notice === 'stored' && <p className={css.ok}>{t('notice.stored')}</p>}

      {state.credentialRef !== undefined && state.writable !== false && (
        <div className={css.actions}>
          <button
            type="button"
            className={css.primary}
            disabled={busy}
            onClick={() => { void controller.provision() }}
          >
            {state.busy === 'provisioning'
              ? t('action.provisioning')
              : state.configured ? t('action.replace') : t('action.provision')}
          </button>
          <span className={css.muted}>{t('action.provision.hint')}</span>
        </div>
      )}

      {state.credentialRef !== undefined && (
        <div className={css.paste}>
          <label className={css.pasteLabel} htmlFor="dsh-account-key">{t('paste.label')}</label>
          <div className={css.pasteRow}>
            <input
              id="dsh-account-key"
              className={css.input}
              type="password"
              autoComplete="off"
              placeholder={t('paste.placeholder')}
              value={pasted}
              disabled={busy}
              onChange={(event) => { setPasted(event.target.value) }}
            />
            <button
              type="button"
              className={css.secondary}
              disabled={busy || pasted.trim() === ''}
              onClick={() => {
                void controller.saveKey(pasted).then(() => { setPasted('') })
              }}
            >
              {state.busy === 'saving' ? t('paste.saving') : t('paste.save')}
            </button>
          </div>
        </div>
      )}

      <div className={css.links}>
        <span className={css.linksTitle}>{t('links.title')}</span>
        <PlatformLink page="top-up" label={t('links.topUp')} onOpen={openPage} />
        <PlatformLink page="usage" label={t('links.usage')} onOpen={openPage} />
        <PlatformLink page="billing" label={t('links.billing')} onOpen={openPage} />
        <PlatformLink page="api-keys" label={t('links.apiKeys')} onOpen={openPage} />
      </div>
      <p className={css.muted}>{t('links.topUp.hint')}</p>
    </div>
  )
}
