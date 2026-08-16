import { describe, expect, it, vi } from 'vitest'

// './food-server' pulls in './repo', which touches expo-sqlite at import time —
// not available under vitest's node environment. Same mock food-server.test.ts uses.
const settings = new Map<string, string>()
vi.mock('./repo', () => ({
  setting: async (key: string, fallback = '') => settings.get(key) ?? fallback,
  putSetting: async (key: string, value: string) => { settings.set(key, value) },
}))

const { UNREACHABLE_COPY } = await import('./food-server')
const { isValidServerUrl, runServerTest } = await import('./server-url')
import type { FoodServerResult, Health } from './food-server'

describe('isValidServerUrl', () => {
  it('accepts http and https URLs', () => {
    expect(isValidServerUrl('http://100.96.136.73:7100')).toBe(true)
    expect(isValidServerUrl('https://example.com')).toBe(true)
  })

  it('rejects a scheme-less address', () => {
    expect(isValidServerUrl('100.96.136.73:7100')).toBe(false)
  })

  it('rejects garbage', () => {
    expect(isValidServerUrl('not a url')).toBe(false)
    expect(isValidServerUrl('')).toBe(false)
  })

  it('rejects a non-http(s) scheme', () => {
    expect(isValidServerUrl('ftp://example.com')).toBe(false)
  })
})

describe('runServerTest', () => {
  const health: Health = {
    foods: 100,
    portions: 0,
    barcodes: 5,
    builtAt: null,
    tiers: [],
    schemaMismatch: false,
  }
  const okResult: FoodServerResult<Health> = { kind: 'ok', value: health }

  it('rejects a garbage URL before persisting anything', async () => {
    const setFoodServerUrl = vi.fn(async () => {})
    const fetchHealth = vi.fn(async () => okResult)
    const result = await runServerTest('100.96.136.73:7100', { setFoodServerUrl, fetchHealth })
    expect(result.persisted).toBe(false)
    expect(result.status).toBe('That is not a valid address')
    expect(setFoodServerUrl).not.toHaveBeenCalled()
    expect(fetchHealth).not.toHaveBeenCalled()
  })

  it('persists and reports the health summary for a valid, reachable address', async () => {
    const setFoodServerUrl = vi.fn(async () => {})
    const fetchHealth = vi.fn(async () => okResult)
    const result = await runServerTest('http://100.64.0.9:7100', { setFoodServerUrl, fetchHealth })
    expect(setFoodServerUrl).toHaveBeenCalledWith('http://100.64.0.9:7100')
    expect(result.persisted).toBe(true)
    expect(result.status).toContain('100 foods')
  })

  it('never strands the caller: a rejecting setFoodServerUrl resolves with a visible error, not persisted', async () => {
    const setFoodServerUrl = vi.fn(async () => { throw new Error('disk full') })
    const fetchHealth = vi.fn(async () => okResult)
    const result = await runServerTest('http://100.64.0.9:7100', { setFoodServerUrl, fetchHealth })
    expect(result.persisted).toBe(false)
    expect(result.status).toBe('disk full')
    expect(fetchHealth).not.toHaveBeenCalled()
  })

  it('reports UNREACHABLE_COPY when the address is valid but the server does not answer', async () => {
    const setFoodServerUrl = vi.fn(async () => {})
    const fetchHealth = vi.fn(async (): Promise<FoodServerResult<Health>> => ({
      kind: 'server_unreachable',
      reason: 'timeout',
      detail: 'no answer',
    }))
    const result = await runServerTest('http://100.64.0.9:7100', { setFoodServerUrl, fetchHealth })
    expect(result.persisted).toBe(true)
    expect(result.status).toBe(UNREACHABLE_COPY)
  })
})
