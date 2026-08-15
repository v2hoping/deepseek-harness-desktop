import { clientBundle } from '../../../../packages/client/tsdown.client.ts'

/**
 * Emits the Loader entry (`lib/index.js`) and the browser bundle
 * (`lib/client.js`) that `dsh-client-modules` serves at
 * `/plugins/desktop-account/client.js`.
 */
export default clientBundle('@deepseek-ai/dsh-desktop-account', ['lib/types/index.js'])
