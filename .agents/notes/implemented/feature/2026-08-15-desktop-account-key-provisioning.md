# Agent Note: The desktop account page provisions a key without acting as the user

Status: implemented

English | [中文](2026-08-15-desktop-account-key-provisioning.zh.md)

## Problem

First use requires the user to supply an API key: understand the concept, register on the DeepSeek platform, create a key, and paste it. For a non-developer that is the largest obstacle before the first message. The desktop application should get a working key into the model credential with as little of that as possible, and show where to add credit.

This fork also has to keep merging upstream cheaply, so the feature must reach the product through existing extension points rather than by editing the upstream package tier.

Three platform facts, established by signing in and recording what the platform's own pages do, bound what is possible:

- The public DeepSeek API is `chat/completions`, `models`, and `user/balance`. There is no public endpoint for sign-in, key management, usage, or billing.
- The key listing (`GET /api/v0/users/get_api_keys`) returns masked values (`sk-75dc3***…0a11`). A usable secret appears only in the response to a creation, which is what the platform's own page states.
- The platform authenticates its website calls with a bearer token that is in no ordinary browser storage — not cookies, `localStorage`, `sessionStorage`, or IndexedDB — alongside a graphical challenge, a device identifier, and a WAF session.

So "read the key list and pick one" cannot work, and obtaining the token would require reading a deliberately obfuscated store out of the official page's runtime.

## Decision

`@deepseek-ai/dsh-desktop-account` in `apps/desktop/plugins/account` adds an Account section to Settings. The shell never authenticates as the user and never issues a request on the user's behalf to the platform website.

Key provisioning runs on the platform's own page. `Get an API key` opens the official keys page in a `BrowserWindow` bound to a persistent partition, so the platform sees its own page with its own device identity, its own challenge flow, and the user's own clicks. The shell attaches Chrome DevTools Protocol network events to that window, enables `Network` only, and reads response bodies looking for an unmasked `sk-…` value. It injects no script, sends no request, and never reads the page's session credential. Matching the unmasked value rather than an endpoint path is what distinguishes a creation response from the masked listing, and it keeps working when the platform renames endpoints.

A key reaches storage only after the public `GET /user/balance` endpoint accepts it — the one request this application issues, authenticated by the user's own key. It is then written through the existing `credentials.set` RPC, so the credential subsystem owns it and model requests resolve it on their next call. Pasting a key the user already has runs the same check-then-store path.

`credentials.describe` never returns values, so a key already in place cannot be re-checked from here. The page reports configured state, winning layer, and writability, and guarantees only that a key it wrote was accepted first.

Usage, billing, top up, and key management are links that open the official pages in the same session partition. Redrawing them would require the internal endpoints this decision refuses to call.

### Reaching the product without touching upstream

The plugin is an out-of-tree bundle. `dsh plugin --profile web add file:<dir>` installs it into the profile directory, where the Loader's bare-specifier resolution reaches it, and the CLI appends any package declaring `dsh.bundle.patch` to `dsh.profile.bundles`. `apps/desktop/src/account/ensure-plugin.ts` runs that before the Host boots and skips it once the profile manifest records the dependency, so an ordinary launch starts no package manager. A failure there leaves the Host fully functional without the account page.

The section itself needs no shell change: `settings.section` is an open list slot. The browser half reads `window.dshDesktop?.account` and registers nothing when it is absent, so a `dsh web` browser tab shows the Settings pages exactly as before. The renderer reaches the shell through a preload that exposes three account methods and no raw IPC channel, with sandboxing and context isolation unchanged.

Nothing in `packages/` changes for this feature.

## Verification

`apps/desktop/tests/account.spec.ts` pins that capture takes the secret out of a creation response, ignores the masked listing form and a body with no key, and reports a missing name; and that the install check reads a fresh profile, a foreign manifest, and a damaged one as not installed. A browser driven against the desktop Host confirms the section registers with the bridge present and is absent without it, which is the `dsh web` guarantee. Installing into the profile was confirmed end to end: the manifest records the dependency and `dsh.profile.bundles` gains `@deepseek-ai/dsh-desktop-account`.

The sign-in and creation paths need a real account and were exercised by hand against the platform.

## Alternatives considered

**Extract the platform's bearer token and call its internal endpoints.** This is what full automation would require — list keys, create one, read usage, all without the user leaving the application. The token is in no ordinary storage, so obtaining it means reading an obfuscated store out of the official page's runtime, and every later request would carry none of the browser identity the platform expects. The cost of being wrong is the user's account, not a failed feature.

**Read the key list and reuse the first key.** The obvious design, and the one originally asked for. The listing returns masked values only, so no key it reports can authenticate anything.

**Frame the sign-in page inside the application.** The platform sets `X-Frame-Options`, and a framed page would not share the session anyway.

**Build a sign-in form and call the platform's login endpoint.** No public login endpoint exists, the flow carries a graphical challenge and device fingerprinting, and the user's password and SMS code would pass through our interface — which a user is right to refuse.

**Ship the plugin in `packages/client`.** It would sit beside the other UI plugins and be readier to contribute upstream, but it would take on the package tier's gates (per-file full coverage, an invariant companion, the limitations section) for a fork-local feature, and it would put a desktop-only capability in the shared tier.

**Redraw usage and billing in the application.** Both need the internal endpoints. Links cost the user one window and cannot break when the platform changes.

## Consequences

The user reaches a working key in two clicks and a sign-in, and the application never holds a platform credential, never replays a session, and never sends a request the platform did not originate. A platform redesign of its internal endpoints does not break this feature, because it calls none of them.

The residual exposure is that the window is Electron, whose user agent identifies it as such, and that CDP attachment is in principle observable. Neither is disguised: overriding the user agent would turn "a different browser" into evasion. The worst outcome is the platform asking that window to verify again, not an account penalty, because from the platform's side this is one signed-in user acting in their own session.

The feature costs a per-launch profile check, a pnpm install on first launch, and a preload on the main window. A key already stored cannot be validated from the page, so the reported state is "configured", not "working". Whether the user's paste path or the captured path ran, the stored key was accepted by the public endpoint first.
