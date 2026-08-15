# DeepSeek Harness Desktop Account

English | [中文](README.zh.md)

Adds an Account page to Settings that puts a DeepSeek API key into the model credential and points at the platform's top-up page.

## Why it lives here

The page needs the Electron shell: DeepSeek's platform has no public account API, its sign-in page refuses to be framed, and its key listing returns masked values, so a usable key exists only in the response to a creation the user performs on the official page. The plugin therefore ships with the desktop application rather than the package tier, and `dsh plugin --profile web add` installs it into the profile as an out-of-tree bundle. Nothing in the upstream package tier changes.

## What the page does

The Account page reports whether the DeepSeek provider's credential reference holds a key, and offers two ways to fill it. **Get an API key** opens the official keys page in a window carrying the platform session; when the user creates a key there, the shell reads that page's own response and stores the key. **Paste a key** takes one the user already has. Both paths check the key against the public `GET /user/balance` endpoint before storing it, so a stored key is one the platform accepted. The page also links to the platform's top-up, usage, billing, and key-management pages.

`credentials.describe` never returns values, so a key that is already stored cannot be re-checked from here. What the page guarantees is that a key it writes was accepted first.

## What it does not do

The shell never authenticates as the user. It extracts no session token, sends no request on the user's behalf to the platform website, and injects no script into any official page. Every platform request comes from the platform's own page with its own device identity; the shell observes one response through Electron's DevTools Protocol and reads nothing else. The only request this application issues is the public balance probe, authenticated by the user's own API key.

## Browser behavior

The browser half checks for the desktop account bridge and registers nothing without it. An ordinary `dsh web` tab therefore shows the Settings pages exactly as before.

## Model Experience

The plugin adds no model-visible input. Storing a key changes which credential the DeepSeek provider resolves, which the existing credential subsystem already owns.
