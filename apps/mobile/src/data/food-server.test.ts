import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// Type-only — erased at compile time, so this never pulls the server workspace
// (or its node:net-touching code) into a Metro bundle. It exists purely so a
// fixture that drifts from the real wire contract (apps/food-server/src/wire.ts)
// is a compile failure here, not a silent runtime mismatch discovered in prod.
import type {
  BarcodeResponse, HealthResponse, PipelineRequest, SearchResponse,
} from '../../../food-server/src/wire.js'

const settings = new Map<string, string>()
vi.mock('./repo', () => ({
  setting: async (key: string, fallback = '') => settings.get(key) ?? fallback,
  putSetting: async (key: string, value: string) => { settings.set(key, value) },
}))

const {
  DEFAULT_FOOD_SERVER_URL, FOOD_SERVER_URL_KEY, UNREACHABLE_COPY,
  fetchHealth, foodServerUrl, lookupBarcode, runRemotePipeline, searchFoods, setFoodServerUrl,
} = await import('./food-server')

function jsonResponse<T>(status: number, body: T): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => { settings.clear(); vi.restoreAllMocks() })
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

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
    const body: SearchResponse = {
      schemaVersion: 1,
      outcome: { kind: 'miss' },
      ladderStep: 3,
      zeroHit: true,
      details: {},
    }
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, body)))
    const r = await searchFoods('ful', 250)
    expect(r.kind).toBe('ok')
    if (r.kind !== 'ok') throw new Error('unreachable')
    expect(r.value.zeroHit).toBe(true)
  })

  it('sends the query and grams as URL parameters', async () => {
    const body: SearchResponse = {
      schemaVersion: 1, outcome: { kind: 'miss' }, ladderStep: 0, zeroHit: true, details: {},
    }
    const spy = vi.fn(async (..._args: unknown[]) => jsonResponse(200, body))
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

  it('maps an abort that fires while the body is streaming to timeout, not bad_response', async () => {
    // fetch() itself resolves, but res.json() rejects with the same AbortError
    // once the timer fires mid-stream. This must still be attributed to the
    // timeout, not mislabeled as a malformed body.
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 200,
      ok: true,
      json: async () => {
        const err = new Error('Aborted')
        err.name = 'AbortError'
        throw err
      },
    } as unknown as Response)))
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

  it('maps a 404 no_route body (version-skewed server) to server_unreachable, not not_found', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(404, {
      error: 'no_route', message: 'GET /search is not a route',
    })))
    const r = await searchFoods('ful', null)
    expect(r.kind).toBe('server_unreachable')
    if (r.kind !== 'server_unreachable') throw new Error('unreachable')
    expect(r.reason).toBe('http')
  })
})

describe('lookupBarcode', () => {
  it('returns ok for a hit', async () => {
    const body: BarcodeResponse = {
      schemaVersion: 1,
      food: { foodId: '2', name: 'Almarai Fresh Laban', brand: 'Almarai', energyKcal: 40,
        proteinG: 3.2, fatG: 1.5, carbG: 4.6, fiberG: null, sugarG: null, sodiumMg: null,
        servingSizeG: 200, servingDesc: '200 ml', license: 'ODbL-1.0', source: 'off' },
      portions: [],
    }
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, body)))
    const r = await lookupBarcode('6281006012011')
    expect(r.kind).toBe('ok')
    if (r.kind !== 'ok') throw new Error('unreachable')
    expect(r.value.food.energyKcal).toBe(40)
  })

  it('maps a 404 not_found body to not_found — distinct from unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(404, { error: 'not_found', message: 'no' })))
    const r = await lookupBarcode('0000000000000')
    expect(r.kind).toBe('not_found')
  })

  it('maps a 404 no_route body to server_unreachable — a version-skewed server, not a food miss', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(404, {
      error: 'no_route', message: 'GET /barcode/x is not a route',
    })))
    const r = await lookupBarcode('0000000000000')
    expect(r.kind).toBe('server_unreachable')
    if (r.kind !== 'server_unreachable') throw new Error('unreachable')
    expect(r.reason).toBe('http')
  })
})

describe('fetchHealth', () => {
  it('returns ok and keeps going on a schemaVersion mismatch', async () => {
    const body: HealthResponse = {
      ok: true, schemaVersion: 99, foods: 2_100_000, portions: 30, barcodes: 1_900_000,
      builtAt: '2026-08-16T00:00:00.000Z', tiers: ['arab_curated', 'fdc_branded', 'off'],
    }
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, body)))
    const r = await fetchHealth()
    expect(r.kind).toBe('ok')
    if (r.kind !== 'ok') throw new Error('unreachable')
    expect(r.value.foods).toBe(2_100_000)
    expect(r.value.schemaMismatch).toBe(true)
  })

  it('maps a 404 no_route body to server_unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(404, {
      error: 'no_route', message: 'GET /health is not a route',
    })))
    const r = await fetchHealth()
    expect(r.kind).toBe('server_unreachable')
  })
})

describe('runRemotePipeline', () => {
  it('sends a wire-legal InferencePath and returns ok on 200', async () => {
    const req: PipelineRequest = { raw: { note: 'ful medames' }, path: 'cloud', now: 1_700_000_000_000 }
    const spy = vi.fn(async (_input: unknown, init?: RequestInit) => {
      // The literal request body must typecheck as the server's own
      // PipelineRequest — this is what pins defect #1 (path: 'device' would
      // fail this cast, since InferencePath is 'cloud' | 'local').
      const sent = JSON.parse(String(init?.body)) as PipelineRequest
      expect(sent.path).toBe('cloud')
      return jsonResponse(200, { schemaVersion: 1, result: { isFood: true } })
    })
    vi.stubGlobal('fetch', spy)
    const r = await runRemotePipeline(req)
    expect(r.kind).toBe('ok')
    if (r.kind !== 'ok') throw new Error('unreachable')
    expect(r.value.result).toEqual({ isFood: true })
  })

  it('never sends a path value the server would reject with 400', () => {
    // Compile-time pin: 'device' is not a legal InferencePath, so this must
    // fail to typecheck if uncommented — the type system, not a runtime
    // assertion, is what should catch this class of drift going forward.
    // @ts-expect-error 'device' is not assignable to InferencePath ('cloud' | 'local')
    const bad: PipelineRequest = { raw: {}, path: 'device', now: 0 }
    expect(bad.path).toBe('device')
  })

  it('aborts and reports timeout when the server never answers', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn((_input: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
      const signal = init?.signal
      signal?.addEventListener('abort', () => {
        const err = new Error('Aborted')
        err.name = 'AbortError'
        reject(err)
      })
    })))
    const pending = runRemotePipeline({ raw: {}, path: 'cloud', now: 0 })
    await vi.advanceTimersByTimeAsync(4_000)
    const r = await pending
    expect(r.kind).toBe('server_unreachable')
    if (r.kind !== 'server_unreachable') throw new Error('unreachable')
    expect(r.reason).toBe('timeout')
  })
})

describe('UNREACHABLE_COPY', () => {
  it('is the honest sentence the spec requires', () => {
    expect(UNREACHABLE_COPY).toBe('Food database unreachable — is the PC on?')
  })
})
