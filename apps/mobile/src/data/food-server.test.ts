import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const settings = new Map<string, string>()
vi.mock('./repo', () => ({
  setting: async (key: string, fallback = '') => settings.get(key) ?? fallback,
  putSetting: async (key: string, value: string) => { settings.set(key, value) },
}))

const {
  DEFAULT_FOOD_SERVER_URL, FOOD_SERVER_URL_KEY, UNREACHABLE_COPY,
  fetchHealth, foodServerUrl, lookupBarcode, searchFoods, setFoodServerUrl,
} = await import('./food-server')

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => { settings.clear(); vi.restoreAllMocks() })
afterEach(() => { vi.unstubAllGlobals() })

describe('foodServerUrl', () => {
  it('defaults to the tailnet address', async () => {
    expect(await foodServerUrl()).toBe(DEFAULT_FOOD_SERVER_URL)
    expect(DEFAULT_FOOD_SERVER_URL).toBe('http://100.96.136.73:7100')
  })

  it('uses the saved setting, trimmed of a trailing slash', async () => {
    await setFoodServerUrl('http://100.64.0.9:7100/')
    expect(settings.get(FOOD_SERVER_URL_KEY)).toBe('http://100.64.0.9:7100')
    expect(await foodServerUrl()).toBe('http://100.64.0.9:7100')
  })
})

describe('searchFoods', () => {
  it('returns ok with the payload on a 200', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, {
      schemaVersion: 1,
      outcome: { kind: 'miss' },
      ladderStep: 3,
      zeroHit: true,
      details: {},
    })))
    const r = await searchFoods('ful', 250)
    expect(r.kind).toBe('ok')
    if (r.kind !== 'ok') throw new Error('unreachable')
    expect(r.value.zeroHit).toBe(true)
  })

  it('sends the query and grams as URL parameters', async () => {
    const spy = vi.fn(async (..._args: unknown[]) => jsonResponse(200, {
      schemaVersion: 1, outcome: { kind: 'miss' }, ladderStep: 0, zeroHit: true, details: {},
    }))
    vi.stubGlobal('fetch', spy)
    await searchFoods('فول', 250)
    const url = String(spy.mock.calls[0]![0])
    expect(url).toContain('/search?q=')
    expect(url).toContain(encodeURIComponent('فول'))
    expect(url).toContain('grams=250')
  })

  it('maps a network failure to server_unreachable, never a throw', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Network request failed') }))
    const r = await searchFoods('ful', null)
    expect(r.kind).toBe('server_unreachable')
    if (r.kind !== 'server_unreachable') throw new Error('unreachable')
    expect(r.reason).toBe('network')
  })

  it('maps an abort to server_unreachable with reason timeout', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      const err = new Error('Aborted')
      err.name = 'AbortError'
      throw err
    }))
    const r = await searchFoods('ful', null)
    expect(r.kind).toBe('server_unreachable')
    if (r.kind !== 'server_unreachable') throw new Error('unreachable')
    expect(r.reason).toBe('timeout')
  })

  it('maps a body that is not the expected shape to server_unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { hello: 'world' })))
    const r = await searchFoods('ful', null)
    expect(r.kind).toBe('server_unreachable')
    if (r.kind !== 'server_unreachable') throw new Error('unreachable')
    expect(r.reason).toBe('bad_response')
    expect(r.detail).toContain('versions may differ')
  })

  it('maps a 500 to server_unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(500, { error: 'server_error', message: 'boom' })))
    const r = await searchFoods('ful', null)
    expect(r.kind).toBe('server_unreachable')
  })
})

describe('lookupBarcode', () => {
  it('returns ok for a hit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, {
      schemaVersion: 1,
      food: { foodId: '2', name: 'Almarai Fresh Laban', brand: 'Almarai', energyKcal: 40,
        proteinG: 3.2, fatG: 1.5, carbG: 4.6, fiberG: null, sugarG: null, sodiumMg: null,
        servingSizeG: 200, servingDesc: '200 ml', license: 'ODbL-1.0', source: 'off' },
      portions: [],
    })))
    const r = await lookupBarcode('6281006012011')
    expect(r.kind).toBe('ok')
    if (r.kind !== 'ok') throw new Error('unreachable')
    expect(r.value.food.energyKcal).toBe(40)
  })

  it('maps a 404 to not_found — distinct from unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(404, { error: 'not_found', message: 'no' })))
    const r = await lookupBarcode('0000000000000')
    expect(r.kind).toBe('not_found')
  })
})

describe('fetchHealth', () => {
  it('returns ok and keeps going on a schemaVersion mismatch', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, {
      ok: true, schemaVersion: 99, foods: 2_100_000, portions: 30, barcodes: 1_900_000,
      builtAt: '2026-08-16T00:00:00.000Z', tiers: ['arab_curated', 'fdc_branded', 'off'],
    })))
    const r = await fetchHealth()
    expect(r.kind).toBe('ok')
    if (r.kind !== 'ok') throw new Error('unreachable')
    expect(r.value.foods).toBe(2_100_000)
    expect(r.value.schemaMismatch).toBe(true)
  })
})

describe('UNREACHABLE_COPY', () => {
  it('is the honest sentence the spec requires', () => {
    expect(UNREACHABLE_COPY).toBe('Food database unreachable — is the PC on?')
  })
})
