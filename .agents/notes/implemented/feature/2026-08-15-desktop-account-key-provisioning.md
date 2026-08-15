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

Key provisioning runs on the platform's own page. `Get an API key` opens the official keys page in a `BrowserWindow` bound to a persistent partition, so the platform sees its own page with its own device identity, its own challenge flow, and the user's own clicks. The shell attaches Chrome DevTools Protocol network events to that window, enables `Network` only, and reads response bodies looking for an unmasked `sk-…` value. It injects no script, issues no request of its own, and never reads the page's session credential.

Three details decide whether that capture works, and each was wrong before it was right. Only `POST` responses are inspected: creation is a POST, while the list refresh that follows it is a GET whose entries are masked, and reading those yields a value the API rejects. The body is read at `Network.loadingFinished`, because `getResponseBody` answers "No data found for resource with given identifier" at `responseReceived`. And the match is on the unmasked value rather than a field name or endpoint path — the platform calls the field `sensitive_id` and returns it complete on creation and masked in the listing, so the value's own form is the only reliable discriminator, and it survives the platform renaming either.

A captured key is stored immediately, through the existing `credentials.set` RPC, before anything else examines it. Its secret is shown once, so refusing to store a key the user just created would lose it outright. The page then shows that key for the rest of the session, masked until revealed, and holds it only in the controller's memory: closing the application forgets it, while the key stays in the credential layer where the credential subsystem owns it.

The application does not verify the stored key. A freshly issued key is not accepted by the API right away, and a report that says so gives the user nothing to act on — the key is already stored and already in use by the next model request. Probing for it cost a request, up to eleven seconds of retries in the way of the interface, and a warning that reads like a failure.

Usage, billing, top up, and key management are links that open the official pages in the same session partition. Redrawing them would require the internal endpoints this decision refuses to call.

### Reaching the product without touching upstream

The plugin is an out-of-tree bundle. `dsh plugin --profile web add file:<dir>` installs it into the profile directory, where the Loader's bare-specifier resolution reaches it, and the CLI appends any package declaring `dsh.bundle.patch` to `dsh.profile.bundles`. `apps/desktop/src/account/ensure-plugin.ts` runs that before the Host boots and skips it once the profile manifest records the dependency, so an ordinary launch starts no package manager. A failure there leaves the Host fully functional without the account page.

The Account section itself needs no shell change: `settings.section` is an open list slot. The browser half reads `window.dshDesktop?.account` and registers nothing when it is absent, so a `dsh web` browser tab shows the Settings pages exactly as before. The renderer reaches the shell through a preload that exposes two account methods and no raw IPC channel, with sandboxing and context isolation unchanged.

Reaching the first-run step is the one thing an existing package had to allow. `settings.onboarding.credentialAction` is a single slot beside the onboarding credential input, declared with the provider route it is asking about; `ProviderEditor` renders whatever occupies it inside the input's control group, and squares off the input's adjoining corners only when something does. The slot names no account concept and carries no dependency on this plugin: unoccupied, the step renders exactly as before. This plugin occupies it, declines every route but `deepseek-official`, and stores through the same controller the Account page uses — so a key obtained during onboarding is the one the Account page then shows. Storing emits `credentials/updated`, which the step's own controller already listens for, so the step completes without either side knowing about the other.

## Verification

`apps/desktop/tests/account.spec.ts` pins that capture takes the secret out of a creation response, ignores the masked listing form and a body carrying no key, and reads a base64-transferred body; that a listing refresh is never mistaken for a creation; that the response tracker follows only the platform API, hands each body back once, and stays bounded when responses never finish; and that the install check reads a fresh profile, a foreign manifest, and a damaged one as not installed. A browser driven against the desktop Host confirms the Account section registers with the bridge present and is absent without it, which is the `dsh web` guarantee. Installing into the profile was confirmed end to end: the manifest records the dependency and `dsh.profile.bundles` gains `@deepseek-ai/dsh-desktop-account`.

The CDP timing was established by measurement, not assumption: at `responseReceived` the protocol answers "No data found for resource with given identifier", at `loadingFinished` it returns the body.

The sign-in and creation paths need a real account and were exercised by hand against the platform, including the case this decision exists for — a key created and stored while the API still rejects it.

## Alternatives considered

**Extract the platform's bearer token and call its internal endpoints.** This is what full automation would require — list keys, create one, read usage, all without the user leaving the application. The token is in no ordinary storage, so obtaining it means reading an obfuscated store out of the official page's runtime, and every later request would carry none of the browser identity the platform expects. The cost of being wrong is the user's account, not a failed feature.

**Read the key list and reuse the first key.** The obvious design, and the one originally asked for. The listing returns masked values only, so no key it reports can authenticate anything.

**Frame the sign-in page inside the application.** The platform sets `X-Frame-Options`, and a framed page would not share the session anyway.

**Build a sign-in form and call the platform's login endpoint.** No public login endpoint exists, the flow carries a graphical challenge and device fingerprinting, and the user's password and SMS code would pass through our interface — which a user is right to refuse.

**Ship the plugin in `packages/client`.** It would sit beside the other UI plugins and be readier to contribute upstream, but it would take on the package tier's gates (per-file full coverage, an invariant companion, the limitations section) for a fork-local feature, and it would put a desktop-only capability in the shared tier.

**Redraw usage and billing in the application.** Both need the internal endpoints. Links cost the user one window and cannot break when the platform changes.

**Verify a stored key before reporting success.** The first implementation did this, and it was wrong twice over: it delayed the interface by up to eleven seconds of retries for an answer the user cannot act on, and an early version made storage conditional on it — which would discard a key whose secret is shown once. What a rejection actually means right after creation is "not yet", and waiting is the only response to that either way.

**Persist which key was obtained.** A durable record would survive restarts and could show the key's provenance. It also meant writing a complete key into a second file, against the credential subsystem's rule that references are stored and values are not. Session memory shows the user the key they just created — the moment it is actually needed — and costs nothing.

**Hide the platform's own navigation in the account window.** The window could be stripped to just the key form with injected CSS. The window is trustworthy precisely because it looks like the platform's own page, which matters when the user is typing a password into it; and its sidebar carries the top-up entry a user creating a key may well want next.

## Consequences

The user reaches a working key in two clicks and a sign-in, from the first-run step or from Settings, and the application never holds a platform credential, never replays a session, and sends no request to DeepSeek at all. A platform redesign of its internal endpoints does not break this feature, because it calls none of them; renaming the creation endpoint or its field does not either, because the match is on the key's own form.

The residual exposure is that the window is Electron, whose user agent identifies it as such, and that CDP attachment is in principle observable. Neither is disguised: overriding the user agent would turn "a different browser" into evasion. The worst outcome is the platform asking that window to verify again, not an account penalty, because from the platform's side this is one signed-in user acting in their own session.

The feature costs a per-launch profile check, a pnpm install on first launch, and a preload on the main window. It states nothing about whether a stored key works: `credentials.describe` never returns values, and this decision stopped probing for what it could not act on. A key that turns out to be wrong surfaces as a failed model request, and the same button replaces it.

One upstream file group changed for this: the onboarding credential seat. It is a neutral extension point — a slot declaration, the editor rendering whatever occupies it, and the test that pins an empty seat — carrying no account concept and no dependency on this plugin, so it can be offered upstream as it stands. Everything else this feature needs was already an open slot or an existing RPC.
