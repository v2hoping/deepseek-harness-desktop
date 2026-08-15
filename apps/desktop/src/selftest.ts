/**
 * Acceptance probes for the desktop shell.
 *
 * These drive the application the way a user does — through the route table,
 * the IPC carrier, and the rendered page — and report where they stop. They
 * live beside the shell rather than in a test file because the thing under
 * test is a booted Electron application: there is no harness that can supply a
 * main process, a preload bridge, and a renderer.
 *
 * Selected by environment variable so the product path stays free of them:
 * `DSH_DESKTOP_SELFTEST=1` runs the carrier probes, `DSH_DESKTOP_PROBE_CHAT=1`
 * adds a Host-side conversation, `DSH_DESKTOP_PROBE_UI=1` adds one driven
 * through the real UI, and `DSH_DESKTOP_CAPTURE=<path>` writes a screenshot.
 */

import { BrowserWindow } from 'electron'
import { writeFile } from 'node:fs/promises'
import type { DesktopHost } from './host.ts'

/**
 * Probe the booted Host through its own RPC surface, exactly as the renderer
 * will: an unroutable method must come back as a structured refusal rather
 * than a crash, which proves the Fetch entry is wired to the API plane.
 * @param booted - the booted Host.
 * @returns the probe's HTTP status.
 */
export async function probeRpcSurface(booted: DesktopHost): Promise<number> {
  const response = await booted.routes.dispatch(new Request('http://127.0.0.1/api/host.describe', {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: '127.0.0.1' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'selftest-0', method: 'host.describe', payload: {} }),
  }))
  return response.status
}

/**
 * Drive one request from a real renderer through the whole IPC carrier —
 * preload bridge, main-process dispatch, Host, and the streamed response back.
 * Probing the Host's Fetch entry directly would skip every part that is new.
 * @returns the transcript of sink callbacks the renderer observed.
 */
export async function probeIpcCarrier(preload: string): Promise<unknown> {
  const probe = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload },
  })
  try {
    await probe.loadURL('about:blank')
    return await probe.webContents.executeJavaScript(`new Promise((resolve) => {
      const seen = []
      const decoder = new TextDecoder()
      window.dshDesktop.fetch(
        {
          url: 'http://desktop.invalid/api/host.describe',
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId: 'ipc-selftest', method: 'host.describe', payload: {} }),
        },
        {
          head: (status) => { seen.push('head:' + status) },
          chunk: (bytes) => { seen.push('chunk:' + decoder.decode(bytes).slice(0, 60)) },
          end: () => { resolve(seen) },
          error: (message) => { resolve(seen.concat('error:' + message)) },
        },
      )
    })`)
  } finally {
    probe.destroy()
  }
}

/**
 * Load the real page and write a screenshot, then exit. The acceptance
 * question for the browser roster is whether it renders at all under this
 * carrier, and only a painted window answers it.
 * @param target - file path for the PNG.
 * @returns a short report of what the page settled into.
 */
export async function captureWindow(makeWindow: () => BrowserWindow, target: string): Promise<string> {
  const window = makeWindow()
  // Renderer diagnostics are the only account of a bundle that failed to load;
  // without them a stuck loading page reports nothing at all.
  const problems: string[] = []
  window.webContents.on('console-message', (event) => {
    if (event.level === 'error' || event.level === 'warning') problems.push(event.message.slice(0, 200))
  })
  window.webContents.on('did-fail-load', (_event, code, description, url) => {
    problems.push(`did-fail-load ${String(code)} ${description} ${url}`)
  })
  await new Promise<void>((resolve) => { window.webContents.once('did-finish-load', () => { resolve() }) })
  // The shell boots in two stages — module prefetch, then the loader tree — and
  // only flips to the real UI once every fiber is active. Poll for the settled
  // marker rather than guessing a delay.
  const settled = await window.webContents.executeJavaScript(`new Promise((resolve) => {
    const deadline = Date.now() + 30000
    const tick = () => {
      const root = document.getElementById('root')
      const text = root === null ? '' : root.innerText.slice(0, 200)
      const painted = root !== null && root.childElementCount > 0
      if (painted && !text.includes('Loading') && !text.includes('加载')) return resolve({ ok: true, text })
      if (Date.now() > deadline) return resolve({ ok: false, text })
      setTimeout(tick, 250)
    }
    tick()
  })`) as { ok: boolean; text: string }

  const image = await window.webContents.capturePage()
  await writeFile(target, image.toPNG())
  window.destroy()
  const report = `${settled.ok ? 'settled' : 'TIMED OUT'} — ${JSON.stringify(settled.text.replaceAll('\n', ' ').slice(0, 160))}`
  if (problems.length === 0) return report
  return `${report}\n  renderer problems:\n${problems.slice(0, 12).map(line => `    - ${line}`).join('\n')}`
}

/**
 * Drive one real conversation through the route table and report each step.
 *
 * This walks the same path the renderer walks — every call goes through the
 * `/api` route with its fence and interceptor, and the reply stream is read
 * as SSE off the response body — so a failure here is a failure the user
 * would see, and the step it stops at names the layer at fault.
 * @param booted - the booted Host.
 * @returns one line per step.
 */
export async function probeConversation(booted: DesktopHost): Promise<string[]> {
  const log: string[] = []
  // Printed as each step lands, not collected and dumped at the end: a probe
  // that hangs must still say which step it hung on.
  const record = (line: string): void => {
    log.push(line)
    console.log(`dsh-desktop: ${line}`)
  }
  let rpc = 0
  const call = async (method: string, payload: unknown): Promise<Record<string, unknown>> => {
    rpc += 1
    const response = await booted.routes.dispatch(new Request(`http://127.0.0.1/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: '127.0.0.1' },
      body: JSON.stringify({ type: 'client-request', rpcId: `probe-${String(rpc)}`, method, payload }),
    }))
    if (!response.ok) throw new Error(`${method} → HTTP ${String(response.status)}`)
    return await response.json() as Record<string, unknown>
  }

  const models = await call('llm.models', {})
  record(`llm.models → ${JSON.stringify(models.result).slice(0, 220)}`)

  const created = await call('session.create', {})
  const result = created.result as { ok?: boolean; value?: { sessionId?: string }; error?: unknown }
  if (result.ok !== true) throw new Error(`session.create refused: ${JSON.stringify(result.error)}`)
  const sessionId = result.value?.sessionId
  record(`session.create → ${String(sessionId)}`)

  // Open the event stream BEFORE prompting: the reply arrives on it, and a
  // stream opened afterwards would miss the frames the turn already emitted.
  // Through `events`, not the route — the route answers 426 here.
  const events = await booted.events(new URL('http://127.0.0.1/api/events.mux'))
  record(`events.mux → HTTP ${String(events.status)}${events.body === null ? ' (no body)' : ''}`)

  const prompted = await call('session.prompt', {
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: '回复一个字：好' }],
  })
  record(`session.prompt → ${JSON.stringify(prompted.result).slice(0, 220)}`)

  if (events.body === null) return log
  // Read until the assistant produces text or the turn ends, bounded so a
  // silent stream reports rather than hangs.
  const reader: ReadableStreamDefaultReader<Uint8Array> = events.body.getReader()
  const decoder = new TextDecoder()
  const deadline = Date.now() + 45_000
  const kinds = new Set<string>()
  let text = ''
  try {
    while (Date.now() < deadline) {
      const { done, value } = await reader.read()
      if (done) break
      for (const line of decoder.decode(value, { stream: true }).split('\n')) {
        if (!line.startsWith('data: ')) continue
        const frame = JSON.parse(line.slice(6)) as { payload?: { kind?: string; delta?: string; text?: string } }
        const kind = frame.payload?.kind
        if (kind !== undefined) kinds.add(kind)
        text += frame.payload?.delta ?? frame.payload?.text ?? ''
      }
      if (text.length > 0) break
    }
  } finally {
    reader.cancel().catch(() => undefined)
  }
  record(`frames → ${[...kinds].join(', ') || '(none)'}`)
  record(`assistant text → ${JSON.stringify(text.slice(0, 120))}`)
  return log
}

/**
 * Drive the real UI: type into the composer, send, and watch what the page
 * does. This is the acceptance path the probes above cannot reach — a prompt
 * that reaches the Host but produces nothing on screen still reads to the user
 * as an application that does not work.
 * @param target - file path for a screenshot of the result.
 * @returns one line per step.
 */
export async function probeUiConversation(makeWindow: () => BrowserWindow, target: string): Promise<string[]> {
  const window = makeWindow()
  const problems: string[] = []
  window.webContents.on('console-message', (event) => {
    if (event.level === 'error') problems.push(event.message.slice(0, 180))
  })
  await new Promise<void>((resolve) => { window.webContents.once('did-finish-load', () => { resolve() }) })

  const run = <T>(script: string): Promise<T> => window.webContents.executeJavaScript(script) as Promise<T>
  const pageText = (): Promise<string> => run<string>(
    '(document.getElementById("root")?.innerText ?? "").replace(/\\s+/g, " ").trim()',
  )
  const report: string[] = []

  // Wait for the composer itself, not merely for text on the page: the shell
  // paints the workspace chrome before the conversation surface mounts, so a
  // text-only check reports ready while there is still nothing to type into.
  await run(`new Promise((resolve) => {
    const tick = (left) => {
      if (document.querySelector('textarea') !== null || left === 0) return resolve()
      setTimeout(() => tick(left - 1), 250)
    }
    tick(160)
  })`)
  report.push(`settled: ${(await pageText()).slice(0, 90)}`)

  // First run opens the onboarding notice, a modal that holds the app root
  // inert — the composer does not mount behind it. Dismissing it is part of
  // the user's own first run, so the probe does what they would.
  const dismissed = await run<string>(`(() => {
    const button = [...document.querySelectorAll('button')]
      .filter((b) => b.offsetParent !== null)
      .find((b) => ['继续', 'Continue', '稍后配置', 'Configure later'].includes(b.innerText.trim()))
    if (button === undefined) return 'none'
    button.click()
    return button.innerText.trim()
  })()`)
  if (dismissed !== 'none') {
    report.push(`dismissed onboarding: ${dismissed}`)
    await run(`new Promise((resolve) => {
      const tick = (left) => {
        if (document.querySelector('textarea') !== null || left === 0) return resolve()
        setTimeout(() => tick(left - 1), 250)
      }
      tick(80)
    })`)
  }

  const focused = await run<boolean>(`(() => {
    const editor = document.querySelector('textarea')
    if (editor === null) return false
    editor.focus()
    return document.activeElement === editor
  })()`)
  if (!focused) {
    report.push('FAIL: no composer to focus')
    // Name what IS on the page: an editor that never mounts and one that
    // mounted as a different element are different failures.
    report.push(await run<string>(`(() => {
      const editable = [...document.querySelectorAll('[contenteditable="true"]')].length
      const inputs = [...document.querySelectorAll('input')].map((i) => i.type).join(',')
      const buttons = [...document.querySelectorAll('button')]
        .filter((b) => b.offsetParent !== null)
        .map((b) => (b.getAttribute('aria-label') ?? b.innerText).replace(/\\s+/g, ' ').trim().slice(0, 24))
        .filter((t) => t !== '')
      return 'dom: contenteditable=' + editable + ' inputs=[' + inputs + '] buttons=[' + buttons.join(' | ') + ']'
    })()`))
    window.destroy()
    return report
  }

  // Electron's own text insertion rather than a synthetic event: the composer
  // is a controlled component, and assigning `value` is discarded on the next
  // render because the framework's state never learns of it.
  const message = 'Reply with exactly one word: ok'
  void window.webContents.insertText(message)
  await new Promise<void>((resolve) => { setTimeout(resolve, 500) })
  const typed = await run<string>('document.querySelector("textarea")?.value ?? ""')
  report.push(`typed: ${JSON.stringify(typed.slice(0, 40))}`)
  if (typed === '') {
    report.push('FAIL: composer did not accept text')
    window.destroy()
    return report
  }

  const before = await pageText()
  for (const type of ['keyDown', 'char', 'keyUp'] as const) {
    window.webContents.sendInputEvent({ type, keyCode: 'Enter' })
  }

  // Poll for the turn to show up, then for it to produce something.
  let after = before
  for (let attempt = 0; attempt < 90; attempt += 1) {
    await new Promise<void>((resolve) => { setTimeout(resolve, 1000) })
    after = await pageText()
    if (after !== before && !after.includes(message)) break
    if (after !== before && after.length > before.length + message.length + 40) break
  }
  report.push(after === before ? 'FAIL: page unchanged after send' : 'page changed after send')
  report.push(`after: ${after.slice(0, 500)}`)

  const image = await window.webContents.capturePage()
  await writeFile(target, image.toPNG())
  window.destroy()
  return problems.length === 0 ? report : [...report, `renderer errors: ${problems.slice(0, 6).join(' | ')}`]
}
