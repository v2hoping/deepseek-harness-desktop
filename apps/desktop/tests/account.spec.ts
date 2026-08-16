import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureAccountPlugin, pruneLegacyProfileInstall, stagedPluginDir } from '../src/account/ensure-plugin.ts'
import { captureApiKey } from '../src/account/key-capture.ts'
import { createResponseTracker } from '../src/account/response-tracker.ts'

describe('created API key capture', () => {
  it('takes the complete secret out of a creation response', () => {
    const body = JSON.stringify({
      code: 0,
      data: { biz_data: { name: 'dsh-desktop', key: 'sk-1234567890abcdefghijklmnopqrstuv' } },
    })

    expect(captureApiKey(body)).toEqual({ secret: 'sk-1234567890abcdefghijklmnopqrstuv' })
  })

  it('ignores the masked values the key listing returns', () => {
    // The listing endpoint answers with sensitive_id, never a usable key.
    const body = JSON.stringify({
      data: { biz_data: { api_keys: [{ name: 'deepseek-v2hoping', sensitive_id: 'sk-75dc3***********************0a11' }] } },
    })

    expect(captureApiKey(body)).toBeUndefined()
  })

  it('reads a secret from a body carrying nothing else', () => {
    expect(captureApiKey('{"key":"sk-abcdefghijklmnopqrstuvwxyz012345"}'))
      .toEqual({ secret: 'sk-abcdefghijklmnopqrstuvwxyz012345' })
  })

  it('ignores a body with no key at all', () => {
    expect(captureApiKey('{"code":0,"data":{"biz_data":{"api_keys":[]}}}')).toBeUndefined()
  })
})

/** A Harness home and a plugin source directory, both removed on cleanup. */
async function withFixture(): Promise<{ home: string; source: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-'))
  const home = join(root, 'home')
  const source = join(root, 'account-plugin')
  await mkdir(source, { recursive: true })
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-desktop-account', version: '1.0.0' }))
  await writeFile(join(source, 'cordis.patch.yml'), '- insert:\n    - id: desktop-account\n')
  await mkdir(join(source, 'lib'), { recursive: true })
  await writeFile(join(source, 'lib/client.js'), 'client')
  vi.stubEnv('DSH_HOME', home)
  return { home, source, cleanup: async () => { await rm(root, { recursive: true, force: true }) } }
}

afterEach(() => { vi.unstubAllEnvs() })

describe('account plugin staging', () => {
  it('stages the plugin where the profile module lookup reaches it and returns its overlay', async () => {
    const { home, source, cleanup } = await withFixture()
    try {
      const patch = ensureAccountPlugin({ pluginDir: source, alwaysRestage: false })

      // One level above every profile, which is where Node's lookup walk from
      // the profile directory finds it.
      expect(stagedPluginDir()).toBe(join(home, 'profiles/node_modules/@deepseek-ai/dsh-desktop-account'))
      expect(patch).toBe(join(stagedPluginDir(), 'cordis.patch.yml'))
      expect(await readFile(join(stagedPluginDir(), 'lib/client.js'), 'utf8')).toBe('client')
    } finally {
      await cleanup()
    }
  })

  it('restages when the shipped version moves, and leaves a matching copy alone', async () => {
    const { source, cleanup } = await withFixture()
    try {
      ensureAccountPlugin({ pluginDir: source, alwaysRestage: false })
      await writeFile(join(stagedPluginDir(), 'lib/client.js'), 'stale')

      ensureAccountPlugin({ pluginDir: source, alwaysRestage: false })
      expect(await readFile(join(stagedPluginDir(), 'lib/client.js'), 'utf8')).toBe('stale')

      await writeFile(join(source, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-desktop-account', version: '1.1.0' }))
      ensureAccountPlugin({ pluginDir: source, alwaysRestage: false })
      expect(await readFile(join(stagedPluginDir(), 'lib/client.js'), 'utf8')).toBe('client')
    } finally {
      await cleanup()
    }
  })

  it('restages an unchanged version when asked, for a launch reading the checkout', async () => {
    const { source, cleanup } = await withFixture()
    try {
      ensureAccountPlugin({ pluginDir: source, alwaysRestage: false })
      await writeFile(join(source, 'lib/client.js'), 'rebuilt')

      ensureAccountPlugin({ pluginDir: source, alwaysRestage: true })
      expect(await readFile(join(stagedPluginDir(), 'lib/client.js'), 'utf8')).toBe('rebuilt')
    } finally {
      await cleanup()
    }
  })

  it('never copies an install tree the plugin directory carries', async () => {
    const { source, cleanup } = await withFixture()
    try {
      await mkdir(join(source, 'node_modules/react'), { recursive: true })
      await writeFile(join(source, 'node_modules/react/index.js'), 'react')

      ensureAccountPlugin({ pluginDir: source, alwaysRestage: false })

      expect(existsSync(join(stagedPluginDir(), 'node_modules'))).toBe(false)
    } finally {
      await cleanup()
    }
  })

  it('reports an absent plugin and lets the launch continue without the account page', async () => {
    const { source, cleanup } = await withFixture()
    try {
      await rm(join(source, 'package.json'))
      const lines: string[] = []

      expect(ensureAccountPlugin({ pluginDir: source, alwaysRestage: false, log: line => lines.push(line) })).toBeUndefined()
      expect(lines.join('')).toContain('the account page stays unavailable')
    } finally {
      await cleanup()
    }
  })
})

describe('legacy profile install cleanup', () => {
  /** Write a web profile carrying what an earlier `dsh plugin add` left. */
  async function writeLegacyProfile(home: string): Promise<string> {
    const dir = join(home, 'profiles/web')
    await mkdir(join(dir, 'node_modules/@deepseek-ai/dsh-desktop-account'), { recursive: true })
    await writeFile(join(dir, 'node_modules/@deepseek-ai/dsh-desktop-account/package.json'), '{"version":"0.0.1"}')
    await writeFile(join(dir, 'package.json'), JSON.stringify({
      dependencies: { '@deepseek-ai/dsh-desktop-account': 'file:/Users/builder/checkout/plugins/account' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-desktop-account'] } },
    }))
    return dir
  }

  it('removes the bundle row, the machine-pinned dependency, and the profile-local copy', async () => {
    const { home, source, cleanup } = await withFixture()
    try {
      const dir = await writeLegacyProfile(home)

      ensureAccountPlugin({ pluginDir: source, alwaysRestage: false })

      const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as {
        dependencies: Record<string, string>
        dsh: { profile: { bundles: string[] } }
      }
      // A surviving bundle row would compose the plugin a second time on top
      // of the overlay; a surviving local copy would win the module lookup.
      expect(manifest.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
      expect(manifest.dependencies).toEqual({})
      expect(existsSync(join(dir, 'node_modules/@deepseek-ai/dsh-desktop-account'))).toBe(false)
    } finally {
      await cleanup()
    }
  })

  it('leaves a profile that never carried the plugin byte-identical', async () => {
    const { home, cleanup } = await withFixture()
    try {
      const dir = join(home, 'profiles/web')
      await mkdir(dir, { recursive: true })
      const original = JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }, undefined, 2)
      await writeFile(join(dir, 'package.json'), original)

      pruneLegacyProfileInstall()

      expect(await readFile(join(dir, 'package.json'), 'utf8')).toBe(original)
    } finally {
      await cleanup()
    }
  })

  it('reports a manifest it cannot parse instead of throwing into startup', async () => {
    const { home, cleanup } = await withFixture()
    try {
      const dir = join(home, 'profiles/web')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'package.json'), '{ not json')
      const lines: string[] = []

      pruneLegacyProfileInstall(line => lines.push(line))

      expect(lines.join('')).toContain('could not clean its earlier profile install')
    } finally {
      await cleanup()
    }
  })
})

describe('platform response tracking', () => {
  it('tracks only the platform API and hands each body back once', () => {
    const tracker = createResponseTracker('/api/v0/')

    expect(tracker.observe('r1', 'https://platform.deepseek.com/api/v0/users/create_api_key')).toBe(true)
    expect(tracker.observe('r2', 'https://platform.deepseek.com/static/app.js')).toBe(false)

    // The body is read at loadingFinished, which claims the request.
    expect(tracker.claim('r1')).toBe('https://platform.deepseek.com/api/v0/users/create_api_key')
    expect(tracker.claim('r1')).toBeUndefined()
    expect(tracker.claim('r2')).toBeUndefined()
  })

  it('bounds itself when responses never report completion', () => {
    const tracker = createResponseTracker('/api/v0/')
    for (let i = 0; i < 200; i += 1) tracker.observe(`r${String(i)}`, `https://platform.deepseek.com/api/v0/x/${String(i)}`)

    // The oldest were evicted; the newest survive.
    expect(tracker.claim('r0')).toBeUndefined()
    expect(tracker.claim('r135')).toBeUndefined()
    expect(tracker.claim('r136')).toBe('https://platform.deepseek.com/api/v0/x/136')
    expect(tracker.claim('r199')).toBe('https://platform.deepseek.com/api/v0/x/199')
  })
})

describe('creation-only capture', () => {
  it('never mistakes a listing refresh for the created key', () => {
    // What the page does right after a creation: GET the list, whose entries
    // carry masked values only.
    const listing = JSON.stringify({
      data: { biz_data: { api_keys: [
        { name: 'one', sensitive_id: 'sk-75dc3***********************0a11', tracking_id: '9cf4f9a4-b2e8' },
        { name: 'two', sensitive_id: 'sk-1a2b3***********************a54c', tracking_id: '1b2c3d4e-5f60' },
      ] } },
    })

    expect(captureApiKey(listing)).toBeUndefined()
  })

  it('reads a base64-transferred creation body', () => {
    const body = JSON.stringify({ data: { biz_data: { name: 'dsh', key: 'sk-abcdefghijklmnopqrstuvwxyz0123' } } })
    const encoded = Buffer.from(body, 'utf8').toString('base64')

    expect(captureApiKey(Buffer.from(encoded, 'base64').toString('utf8')))
      .toEqual({ secret: 'sk-abcdefghijklmnopqrstuvwxyz0123' })
  })
})
