import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isPluginInstalled } from '../src/account/ensure-plugin.ts'
import { captureApiKey } from '../src/account/key-capture.ts'

describe('created API key capture', () => {
  it('takes the complete secret out of a creation response', () => {
    const body = JSON.stringify({
      code: 0,
      data: { biz_data: { name: 'dsh-desktop', key: 'sk-1234567890abcdefghijklmnopqrstuv' } },
    })

    expect(captureApiKey(body)).toEqual({
      secret: 'sk-1234567890abcdefghijklmnopqrstuv',
      name: 'dsh-desktop',
    })
  })

  it('ignores the masked values the key listing returns', () => {
    // The listing endpoint answers with sensitive_id, never a usable key.
    const body = JSON.stringify({
      data: { biz_data: { api_keys: [{ name: 'deepseek-v2hoping', sensitive_id: 'sk-75dc3***********************0a11' }] } },
    })

    expect(captureApiKey(body)).toBeUndefined()
  })

  it('reports a secret without a name when the response carries none', () => {
    expect(captureApiKey('{"key":"sk-abcdefghijklmnopqrstuvwxyz012345"}'))
      .toEqual({ secret: 'sk-abcdefghijklmnopqrstuvwxyz012345' })
  })

  it('ignores a body with no key at all', () => {
    expect(captureApiKey('{"code":0,"data":{"biz_data":{"api_keys":[]}}}')).toBeUndefined()
  })
})

describe('account plugin installation state', () => {
  it('reports installed once the profile manifest depends on the plugin', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-profile-'))
    try {
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({ dependencies: { '@deepseek-ai/dsh-desktop-account': 'file:../plugin' } }),
      )

      expect(isPluginInstalled(dir)).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reports not installed for a fresh profile, a foreign manifest, and a damaged one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-profile-'))
    try {
      expect(isPluginInstalled(dir)).toBe(false)

      await writeFile(join(dir, 'package.json'), JSON.stringify({ dependencies: { other: '1.0.0' } }))
      expect(isPluginInstalled(dir)).toBe(false)

      // A malformed manifest must not throw into desktop startup.
      await writeFile(join(dir, 'package.json'), '{ not json')
      expect(isPluginInstalled(dir)).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
