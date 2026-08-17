import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createHostSupervisor,
  type HostChild,
} from '../src/host-supervisor.ts'

vi.mock('node:child_process', { spy: true })

type HostExitListener = Parameters<HostChild['onExit']>[0]
type HostExitSignal = Parameters<HostExitListener>[1]

class FakeOutput {
  private readonly listeners = new Set<(chunk: string) => void>()

  onData(listener: (chunk: string) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  emit(chunk: string): void {
    for (const listener of this.listeners) listener(chunk)
  }
}

class FakeHostChild implements HostChild {
  readonly pid = 123
  readonly stdout = new FakeOutput()
  readonly stderr = new FakeOutput()
  readonly signals: Array<'SIGTERM' | 'SIGKILL'> = []
  private readonly exitListeners = new Set<HostExitListener>()
  private readonly errorListeners = new Set<(error: Error) => void>()

  onExit(listener: HostExitListener): () => void {
    this.exitListeners.add(listener)
    return () => { this.exitListeners.delete(listener) }
  }

  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener)
    return () => { this.errorListeners.delete(listener) }
  }

  kill(signal: 'SIGTERM' | 'SIGKILL'): void {
    this.signals.push(signal)
  }

  emitExit(code: number | null = 0, signal: HostExitSignal = null): void {
    for (const listener of this.exitListeners) listener(code, signal)
  }

  emitError(error: Error): void {
    for (const listener of this.errorListeners) listener(error)
  }
}

function observeSettlement<T>(promise: Promise<T>): ReturnType<typeof vi.fn> {
  const settled = vi.fn()
  void promise.then(settled, settled)
  return settled
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** Readiness the test drives, standing in for the Host answering on its origin. */
class FakeProbe {
  private answering = false
  private failure: Error | undefined

  readonly probe = async (): Promise<boolean> => {
    if (this.failure !== undefined) throw this.failure
    return this.answering
  }

  answer(): void { this.answering = true }
  breakWith(failure: Error): void { this.failure = failure }
}

const ORIGIN = 'http://127.0.0.1:4567'

/** Supervisor over a fake child whose readiness the test controls. */
function supervisorOver(
  probe: FakeProbe,
  child: HostChild | (() => HostChild),
  overrides: Partial<Parameters<typeof createHostSupervisor>[0]> = {},
) {
  return createHostSupervisor({
    spawnHost: typeof child === 'function' ? child : () => child,
    origin: ORIGIN,
    probeReady: probe.probe,
    readinessIntervalMs: 1,
    ...overrides,
  })
}

describe('desktop Host supervisor', () => {
  it('starts one child for concurrent callers and returns the origin it probed', async () => {
    const probe = new FakeProbe()
    const child = new FakeHostChild()
    const spawnHost = vi.fn(() => child)
    const supervisor = supervisorOver(probe, spawnHost)

    const first = supervisor.start()
    const second = supervisor.start()
    expect(second).toBe(first)
    expect(spawnHost).toHaveBeenCalledOnce()

    probe.answer()
    await expect(first).resolves.toBe(ORIGIN)
    expect(child.signals).toEqual([])
  })

  it('ignores stdout entirely when deciding readiness', async () => {
    // Electron drops a child's piped stdout on Windows, so a Host that printed
    // its readiness line but is not yet answering must not count as ready --
    // and one answering without ever printing must.
    const probe = new FakeProbe()
    const child = new FakeHostChild()
    const supervisor = supervisorOver(probe, child)
    const starting = supervisor.start()
    const settled = observeSettlement(starting)

    child.stdout.emit(`dsh web: ${ORIGIN}\n`)
    await vi.waitFor(() => { expect(settled).not.toHaveBeenCalled() })

    probe.answer()
    await expect(starting).resolves.toBe(ORIGIN)
  })

  it('reports output when the Host exits before readiness', async () => {
    const probe = new FakeProbe()
    const child = new FakeHostChild()
    const supervisor = supervisorOver(probe, child)
    const starting = supervisor.start()

    child.stderr.emit('configuration rejected\n')
    child.emitExit(7)

    await expect(starting).rejects.toThrow(/exited before readiness \(code 7, signal null\).*configuration rejected/su)
  })

  it('contains a synchronous spawn failure as a rejected start', async () => {
    const failure = new Error('spawn unavailable')
    const supervisor = supervisorOver(new FakeProbe(), () => { throw failure })

    await expect(supervisor.start()).rejects.toBe(failure)
  })

  it('terminates the child when the probe itself fails', async () => {
    const probe = new FakeProbe()
    const child = new FakeHostChild()
    probe.breakWith(new Error('probe unavailable'))
    const supervisor = supervisorOver(probe, child)

    await expect(supervisor.start()).rejects.toThrow('probe unavailable')
    expect(child.signals).toEqual(['SIGTERM'])
  })

  it('forbids starting after shutdown', async () => {
    const spawnHost = vi.fn(() => new FakeHostChild())
    const supervisor = supervisorOver(new FakeProbe(), spawnHost)

    await expect(supervisor.shutdown()).resolves.toBeUndefined()
    await expect(supervisor.start()).rejects.toThrow('desktop Host cannot start after shutdown')
    expect(spawnHost).not.toHaveBeenCalled()
  })

  it('times out startup once and terminates the unready child', async () => {
    const probe = new FakeProbe()
    const child = new FakeHostChild()
    const supervisor = supervisorOver(probe, child, { readinessTimeoutMs: 25 })

    await expect(supervisor.start()).rejects.toThrow('desktop Host readiness timed out after 25ms')
    expect(child.signals).toEqual(['SIGTERM'])

    await new Promise<void>((wake) => { setTimeout(wake, 25) })
    expect(child.signals).toEqual(['SIGTERM'])
  })

  it('reports a ready Host exit only when shutdown does not own it', async () => {
    const probe = new FakeProbe()
    const child = new FakeHostChild()
    const onUnexpectedExit = vi.fn()
    const supervisor = supervisorOver(probe, child, { onUnexpectedExit })

    probe.answer()
    await supervisor.start()
    child.emitExit(9, null)

    expect(onUnexpectedExit).toHaveBeenCalledOnce()
    expect(onUnexpectedExit).toHaveBeenCalledWith({ code: 9, signal: null })
  })

  it('coalesces shutdown and waits for the ready child to exit after SIGTERM', async () => {
    const probe = new FakeProbe()
    const child = new FakeHostChild()
    const onUnexpectedExit = vi.fn()
    const supervisor = supervisorOver(probe, child, { shutdownTimeoutMs: 25, onUnexpectedExit })

    probe.answer()
    await supervisor.start()

    const first = supervisor.shutdown()
    const second = supervisor.shutdown()
    const settled = observeSettlement(first)
    expect(second).toBe(first)
    expect(child.signals).toEqual(['SIGTERM'])
    expect(onUnexpectedExit).not.toHaveBeenCalled()

    child.emitExit(0)
    await expect(first).resolves.toBeUndefined()
    expect(settled).toHaveBeenCalledOnce()
  })

  it('escalates a stuck shutdown once and still waits for child exit', async () => {
    const probe = new FakeProbe()
    const child = new FakeHostChild()
    const supervisor = supervisorOver(probe, child, { shutdownTimeoutMs: 25 })

    probe.answer()
    await supervisor.start()

    const closing = supervisor.shutdown()
    const settled = observeSettlement(closing)
    expect(child.signals).toEqual(['SIGTERM'])
    await vi.waitFor(() => { expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']) })
    expect(settled).not.toHaveBeenCalled()

    child.emitExit(null, 'SIGKILL')
    await expect(closing).resolves.toBeUndefined()
    expect(settled).toHaveBeenCalledOnce()
  })
})

describe('desktop Host process', () => {
  it('opts the packaged Electron executable into its Node runtime', async () => {
    const spawned = {
      stdout: { on: vi.fn(), off: vi.fn() },
      stderr: { on: vi.fn(), off: vi.fn() },
      on: vi.fn(),
      off: vi.fn(),
      kill: vi.fn(),
    }
    vi.mocked(spawn).mockReturnValue(spawned as never)

    const { spawnDshWeb } = await import('../src/host-supervisor.ts')
    spawnDshWeb({
      nodeExecutable: '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
      cliEntry: '/Applications/DeepSeek Harness.app/Contents/Resources/host/node_modules/@deepseek-ai/dsh/lib/bin.js',
      cwd: '/Users/tester',
      env: { DSH_DESKTOP: '1' },
      electronRunAsNode: true,
      patches: [],
      port: 4567,
    })

    expect(spawn).toHaveBeenCalledWith(
      '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
      ['--expose-internals', expect.stringContaining('/Resources/host/node_modules/@deepseek-ai/dsh/lib/bin.js'), 'web', '--host', '127.0.0.1', '--port', '4567'],
      expect.objectContaining({ env: { DSH_DESKTOP: '1', ELECTRON_RUN_AS_NODE: '1' } }),
    )
  })

  it('composes patch overlays before the flags the web app owns', async () => {
    const spawned = {
      stdout: { on: vi.fn(), off: vi.fn() },
      stderr: { on: vi.fn(), off: vi.fn() },
      on: vi.fn(),
      off: vi.fn(),
      kill: vi.fn(),
    }
    vi.mocked(spawn).mockReturnValue(spawned as never)

    const { spawnDshWeb } = await import('../src/host-supervisor.ts')
    spawnDshWeb({
      nodeExecutable: '/usr/bin/node',
      cliEntry: '/app/bin.js',
      cwd: '/Users/tester',
      env: {},
      patches: ['/home/.dsh/profiles/node_modules/@deepseek-ai/dsh-desktop-account/cordis.patch.yml'],
      port: 4567,
    })

    // `dsh web` stops parsing its own options at the first one it does not
    // own, so --patch after --host would reach the web app as a stray flag.
    expect(spawn).toHaveBeenCalledWith(
      '/usr/bin/node',
      [
        '--expose-internals', '/app/bin.js', 'web',
        '--patch', '/home/.dsh/profiles/node_modules/@deepseek-ai/dsh-desktop-account/cordis.patch.yml',
        '--host', '127.0.0.1', '--port', '4567',
      ],
      expect.objectContaining({ cwd: '/Users/tester' }),
    )
  })
})
