import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isPluginInstalled } from '../src/account/ensure-plugin.ts'
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

describe('platform response tracking', () => {
  it('tracks only the platform API and hands each body back once', () => {
    const tracker = createResponseTracker('/api/v0/')

    expect(tracker.observe('r1', 'https://platform.deepseek.com/api/v0/users/create_api_key')).toBe(true)
    expect(tracker.observe('r2', 'https://platform.deepseek.com/static/app.js')).toBe(false)
    expect(tracker.size).toBe(1)

    // The body is read at loadingFinished, which claims the request.
    expect(tracker.claim('r1')).toBe('https://platform.deepseek.com/api/v0/users/create_api_key')
    expect(tracker.claim('r1')).toBeUndefined()
    expect(tracker.claim('r2')).toBeUndefined()
    expect(tracker.size).toBe(0)
  })

  it('bounds itself when responses never report completion', () => {
    const tracker = createResponseTracker('/api/v0/')
    for (let i = 0; i < 200; i += 1) tracker.observe(`r${String(i)}`, `https://platform.deepseek.com/api/v0/x/${String(i)}`)

    expect(tracker.size).toBe(64)
    // The oldest were evicted; the newest survive.
    expect(tracker.claim('r0')).toBeUndefined()
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
