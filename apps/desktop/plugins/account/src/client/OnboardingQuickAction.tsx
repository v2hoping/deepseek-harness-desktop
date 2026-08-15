/**
 * The quick path offered beside the onboarding credential input: create the
 * key on the platform instead of typing one.
 *
 * Storing the key emits `credentials/updated`, which the onboarding step's own
 * controller already listens for — so the step completes on its own once the
 * key lands, without this component knowing anything about that step.
 */

import { useEffect } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { AccountSectionInjected } from './AccountSection.tsx'
import css from './OnboardingQuickAction.module.css'

/** The route this action can satisfy. */
const DEEPSEEK_ROUTE = 'deepseek-official'

/** Full component props: the slot owner share plus this plugin's injection. */
export type OnboardingQuickActionProps =
  PropsRuntime<'settings.onboarding.credentialAction'> & AccountSectionInjected

/**
 * Render the quick-provision action for the DeepSeek route.
 * @param props - composed slot props including the provider being configured.
 * @returns the action, or null for a route this path cannot satisfy.
 */
export function OnboardingQuickAction({ provider, controller, useSnapshot, t }: OnboardingQuickActionProps) {
  const busy = useSnapshot(s => s.busy !== 'none')
  const error = useSnapshot(s => s.error)

  useEffect(() => { void controller.load() }, [controller])

  // Every other provider has its own way in; this path only knows DeepSeek's.
  if (provider !== DEEPSEEK_ROUTE) return null

  return (
    <button
      type="button"
      className={css.joinedButton}
      disabled={busy}
      title={error}
      onClick={() => { void controller.provision() }}
    >
      {busy ? t('action.provisioning') : t('action.provision')}
    </button>
  )
}
