# DeepSeek Harness Desktop Account

English | [中文](README.zh.md)

Adds an Account page to Settings, and a quick path beside the first-run credential input, that get a DeepSeek API key into the model credential.

## Why it lives here

The page needs the Electron shell: DeepSeek's platform has no public account API, its sign-in page refuses to be framed, and its key listing returns masked values, so a usable key exists only in the response to a creation the user performs on the official page. The plugin therefore ships with the desktop application rather than the package tier.

## How it reaches a launch

The application stages this directory into `$DSH_HOME/profiles/node_modules`, the module fallback Node's lookup walk reaches from every profile, and then boots its Host with `dsh web --patch <staged>/cordis.patch.yml`. Staging copies the directory and re-copies it whenever the shipped version moves, so a launch always composes the plugin the running application shipped.

Neither step runs a package manager, because a packaged application cannot reach one: a GUI launched from Finder or Explorer inherits a minimal PATH that excludes a user's own pnpm, and the staged Host ships none. Composing per launch through `--patch` also leaves the profile manifest untouched, so a `dsh web` from any other installation boots that profile exactly as it did before this application was installed, and keeps booting it after the application is removed.

## How a key arrives

**Get an API key** opens the official keys page in a window bound to a persistent session partition. The user signs in and creates a key there; the shell observes that page's own creation response, takes the key out of it, and stores it through the existing `credentials.set` RPC. Model requests resolve the credential on their next call, so the key works immediately.

The same action appears twice, driven by one controller: on the Account page, and beside the credential input of the first-run onboarding step — the latter through the neutral `settings.onboarding.credentialAction` slot, which knows nothing about accounts.

A key is stored as soon as it is captured, before anything else looks at it: its secret is shown once, so refusing to store one the user just created would lose it. The Account page then shows that key for the rest of the session, masked until asked to reveal it. Nothing about it is persisted here — closing the application forgets it, while the key itself stays in the credential layer.

## What it does not do

The shell never authenticates as the user and **issues no request to DeepSeek at all**. It extracts no session token, injects no script into any official page, and modifies nothing the platform renders. Every platform request comes from the platform's own page with its own device identity and the user's own clicks; the shell attaches Chrome DevTools Protocol network events to the window it opened, enables `Network` only, and reads one response body.

It also does not verify a stored key. The platform does not accept a freshly issued key right away, and a report that says so gives the user nothing to act on — only something to wait for.

## Browser behavior

The browser half checks for the desktop account bridge and registers nothing without it. An ordinary `dsh web` tab therefore shows the Settings pages exactly as before, and the onboarding step's extension seat stays empty.

## Model Experience

The plugin adds no model-visible input. Storing a key changes which credential the DeepSeek provider resolves, which the existing credential subsystem already owns.
