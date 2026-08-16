import type { ResolutionOutcome, ResolvedFood } from '@nutai/resolver'
import { putSetting, setting } from './repo'

/**
 * The phone's only route to a food database.
 *
 * There is no bundled corpus any more, so this module is the difference between
 * "the food database is on your PC" and "the app is broken". Everything it can
 * return is one of four named outcomes, and NONE of them is a hang or a throw:
 * a call site that forgets to handle `server_unreachable` fails to typecheck.
 *
 * It does not retry. A phone on cellular with the PC asleep should say so in
 * four seconds, not spin for thirty.
 *
 * Wire types are re-declared here against `@nutai/resolver`'s `ResolutionOutcome`
 * / `ResolvedFood` rather than imported from `apps/food-server/src/wire.ts` — the
 * mobile app must never import the server workspace (it pulls in `node:net` etc.
 * and Metro would try, and fail, to bundle it). `wire.ts` is the source of truth
 * for the shapes below; keep this file's types in sync with it by hand.
 */

export const FOOD_SERVER_URL_KEY = 'food_server_url'
export const DEFAULT_FOOD_SERVER_URL = 'http://100.96.136.73:7100'
export const FOOD_SERVER_TIMEOUT_MS = 4000
export const CLIENT_SCHEMA_VERSION = 1

export const UNREACHABLE_COPY = 'Food database unreachable — is the PC on?'

export type FoodServerResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'not_found' }
  | { kind: 'server_unreachable'; reason: 'timeout' | 'network' | 'bad_response' | 'http'; detail: string }

export interface Health {
  foods: number
  portions: number
  barcodes: number
  builtAt: string | null
  tiers: string[]
  /** True when the server speaks a different wire version. We still try. */
  schemaMismatch: boolean
}

export interface PortionRow {
  measure_unit: string | null
  modifier: string | null
  amount: number | null
  gram_weight: number
  is_fndds_default: number
}

export interface FoodDetail {
  food: ResolvedFood
  portions: PortionRow[]
}

export interface SearchPayload {
  outcome: ResolutionOutcome
  ladderStep: number
  zeroHit: boolean
  details: Record<string, FoodDetail>
}

export interface BarcodePayload {
  food: ResolvedFood
  portions: PortionRow[]
}

export interface PipelinePayload {
  /** The pipeline's ScanResult, opaque here — the orchestrator owns its shape. */
  result: unknown
}

export async function foodServerUrl(): Promise<string> {
  const saved = await setting(FOOD_SERVER_URL_KEY, DEFAULT_FOOD_SERVER_URL)
  const trimmed = saved.trim()
  return (trimmed === '' ? DEFAULT_FOOD_SERVER_URL : trimmed).replace(/\/+$/, '')
}

export async function setFoodServerUrl(url: string): Promise<void> {
  await putSetting(FOOD_SERVER_URL_KEY, url.trim().replace(/\/+$/, ''))
}

const SKEW_HINT = 'the server and app versions may differ'

function unreachable(reason: 'timeout' | 'network' | 'bad_response' | 'http', detail: string) {
  return { kind: 'server_unreachable' as const, reason, detail }
}

async function request(path: string, init?: RequestInit): Promise<
  { kind: 'body'; status: number; body: unknown } | { kind: 'error'; result: FoodServerResult<never> }
> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FOOD_SERVER_TIMEOUT_MS)
  try {
    const base = await foodServerUrl()
    const res = await fetch(`${base}${path}`, { ...init, signal: controller.signal })
    let body: unknown
    try {
      body = await res.json()
    } catch (err) {
      // A timeout can fire while the body is still streaming — res.json() then
      // rejects with the SAME AbortError fetch() would have thrown. Attribute
      // it to the timeout, not to a malformed body.
      if (controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
        return { kind: 'error', result: unreachable('timeout', `no answer in ${FOOD_SERVER_TIMEOUT_MS} ms`) }
      }
      return { kind: 'error', result: unreachable('bad_response', `unreadable body — ${SKEW_HINT}`) }
    }
    if (res.status === 404) {
      // The server 404s two distinct things: "no food at this barcode"
      // (error: 'not_found', server.ts:103) and "this route doesn't exist on
      // this server" (error: 'no_route', server.ts:146 — e.g. a version-skewed
      // server that dropped a route). Only the former is a genuine miss; the
      // latter means we couldn't talk to the server we expected.
      if (isRecord(body) && body.error === 'not_found') {
        return { kind: 'error', result: { kind: 'not_found' } }
      }
      const routeError = isRecord(body) && typeof body.error === 'string' ? body.error : 'unknown route'
      return { kind: 'error', result: unreachable('http', `the server answered 404 (${routeError}) — is this the food server?`) }
    }
    if (!res.ok) {
      return { kind: 'error', result: unreachable('http', `the server answered ${res.status}`) }
    }
    return { kind: 'body', status: res.status, body }
  } catch (err) {
    const name = err instanceof Error ? err.name : ''
    if (name === 'AbortError') {
      return { kind: 'error', result: unreachable('timeout', `no answer in ${FOOD_SERVER_TIMEOUT_MS} ms`) }
    }
    return {
      kind: 'error',
      result: unreachable('network', err instanceof Error ? err.message : 'the request failed'),
    }
  } finally {
    clearTimeout(timer)
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

export async function fetchHealth(): Promise<FoodServerResult<Health>> {
  const r = await request('/health')
  if (r.kind === 'error') return r.result
  const b = r.body
  if (!isRecord(b) || typeof b.foods !== 'number' || typeof b.portions !== 'number') {
    return unreachable('bad_response', `/health was not the expected shape — ${SKEW_HINT}`)
  }
  return {
    kind: 'ok',
    value: {
      foods: b.foods,
      portions: b.portions,
      barcodes: typeof b.barcodes === 'number' ? b.barcodes : 0,
      builtAt: typeof b.builtAt === 'string' ? b.builtAt : null,
      tiers: Array.isArray(b.tiers) ? b.tiers.filter((t): t is string => typeof t === 'string') : [],
      schemaMismatch: b.schemaVersion !== CLIENT_SCHEMA_VERSION,
    },
  }
}

export async function searchFoods(q: string, grams: number | null): Promise<FoodServerResult<SearchPayload>> {
  const params = new URLSearchParams({ q })
  if (grams != null) params.set('grams', String(grams))
  const r = await request(`/search?${params.toString()}`)
  if (r.kind === 'error') return r.result

  const b = r.body
  if (!isRecord(b) || !isRecord(b.outcome) || typeof b.outcome.kind !== 'string') {
    return unreachable('bad_response', `/search was not the expected shape — ${SKEW_HINT}`)
  }
  return {
    kind: 'ok',
    value: {
      outcome: b.outcome as unknown as ResolutionOutcome,
      ladderStep: typeof b.ladderStep === 'number' ? b.ladderStep : 0,
      zeroHit: b.zeroHit === true,
      details: isRecord(b.details) ? (b.details as unknown as Record<string, FoodDetail>) : {},
    },
  }
}

export async function lookupBarcode(gtin: string): Promise<FoodServerResult<BarcodePayload>> {
  const r = await request(`/barcode/${encodeURIComponent(gtin)}`)
  if (r.kind === 'error') return r.result

  const b = r.body
  if (!isRecord(b) || !isRecord(b.food)) {
    return unreachable('bad_response', `/barcode was not the expected shape — ${SKEW_HINT}`)
  }
  return {
    kind: 'ok',
    value: {
      food: b.food as unknown as ResolvedFood,
      portions: Array.isArray(b.portions) ? (b.portions as unknown as PortionRow[]) : [],
    },
  }
}

export async function runRemotePipeline(req: {
  raw: unknown
  path: 'cloud' | 'local'
  barcode?: string
  now: number
}): Promise<FoodServerResult<PipelinePayload>> {
  const r = await request('/pipeline', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
  })
  if (r.kind === 'error') return r.result

  const b = r.body
  if (!isRecord(b) || b.result == null) {
    return unreachable('bad_response', `/pipeline was not the expected shape — ${SKEW_HINT}`)
  }
  return { kind: 'ok', value: { result: b.result } }
}
