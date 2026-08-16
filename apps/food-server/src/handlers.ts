import { SEEDED_BASELINES } from '@nutai/confidence'
import type { DbAdapter } from '@nutai/db-adapter'
import { makeFoodDb, runPipeline } from '@nutai/pipeline'
import type { PersonalPriors } from '@nutai/gram-engine'
import {
  loadFood,
  normalizeSearchText,
  resolveByBarcode,
  resolveByText,
  type ScoredCandidate,
} from '@nutai/resolver'
import {
  SCHEMA_VERSION,
  type BarcodeResponse,
  type FoodDetail,
  type HealthResponse,
  type PipelineRequest,
  type PipelineResponse,
  type PortionRow,
  type SearchResponse,
} from './wire.js'

const EMPTY_PRIORS: PersonalPriors = { get: () => null, containers: new Map() }

const PORTIONS_SQL = `
SELECT measure_unit, modifier, amount, gram_weight, is_fndds_default
FROM food_portions WHERE food_id = ? AND gram_weight > 0
`

/** Thrown when the model's payload fails Zod validation inside runPipeline. */
export class BadPipelinePayloadError extends Error {}

/**
 * `/health` is a liveness probe — callers can and will poll it. On the full,
 * multi-GB corpus, `COUNT(*) FROM foods` and `SELECT DISTINCT tier FROM foods`
 * are both near-full-table scans, which is an expensive thing to run on every
 * poll. `build-full.mjs` already writes one `counts.<tier>` manifest row per
 * tier at build time (tools/nutrition-data/src/build-full.mjs:91) — summing
 * those rows gives the total food count and their key suffixes give the tier
 * list, with zero table scan.
 *
 * The live-scan path stays as a FALLBACK for the one case the manifest can't
 * cover: a corpus built without `counts.*` rows (the small dev corpus from
 * build.mjs, or a hand-built test fixture). It only runs when that manifest
 * data is genuinely absent, never as a "just in case" double-check.
 */
export async function handleHealth(db: DbAdapter): Promise<HealthResponse> {
  const built = await db.get<{ value: string }>("SELECT value FROM build_manifest WHERE key = 'built_at'")
  const tierCounts = await db.all<{ key: string; value: string }>(
    "SELECT key, value FROM build_manifest WHERE key LIKE 'counts.%'",
  )

  let foods: number
  let tiers: string[]
  if (tierCounts.length > 0) {
    foods = tierCounts.reduce((sum, r) => sum + Number(r.value), 0)
    tiers = tierCounts.map((r) => r.key.slice('counts.'.length)).sort()
  } else {
    const foodsRow = await db.get<{ c: number }>('SELECT COUNT(*) c FROM foods')
    foods = foodsRow?.c ?? 0
    const tierRows = await db.all<{ tier: string | null }>(
      'SELECT DISTINCT tier FROM foods WHERE tier IS NOT NULL ORDER BY tier',
    )
    tiers = tierRows.map((t) => t.tier).filter((t): t is string => t != null)
  }

  // `build-full.mjs` does not (yet) write manifest counts for portions or
  // barcodes, so these two always take the live-scan path — that is the
  // fallback rule applied correctly, not an oversight: there is no manifest
  // row to prefer.
  const portions = await db.get<{ c: number }>('SELECT COUNT(*) c FROM food_portions')
  const barcodes = await db.get<{ c: number }>('SELECT COUNT(*) c FROM foods WHERE barcode IS NOT NULL')

  return {
    ok: true,
    schemaVersion: SCHEMA_VERSION,
    foods,
    portions: portions?.c ?? 0,
    barcodes: barcodes?.c ?? 0,
    builtAt: built?.value ?? null,
    tiers,
  }
}

function candidatesOf(outcome: SearchResponse['outcome']): ScoredCandidate[] {
  if (outcome.kind === 'auto_accept') return [outcome.match]
  if (outcome.kind === 'disambiguate') return outcome.candidates
  return []
}

/**
 * Text search.
 *
 * The query is folded HERE so every client gets Arabic handling for free — the
 * corpus was indexed with the same function at build time, which is the only
 * reason folding works at all.
 */
export async function handleSearch(db: DbAdapter, q: string, grams: number | null): Promise<SearchResponse> {
  const result = await resolveByText(db, {
    canonicalFoodKey: normalizeSearchText(q),
    observedBrand: null,
    prepFacet: null,
    modelCategory: null,
    estimatedGrams: grams,
  })

  const details: Record<string, FoodDetail> = {}
  for (const c of candidatesOf(result.outcome)) {
    const food = await loadFood(db, c.foodId)
    if (food == null) continue
    details[c.foodId] = { food, portions: await db.all<PortionRow>(PORTIONS_SQL, [c.foodId]) }
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    outcome: result.outcome,
    ladderStep: result.ladderStep,
    zeroHit: result.zeroHit,
    details,
  }
}

export async function handleBarcode(db: DbAdapter, gtin: string): Promise<BarcodeResponse | null> {
  const food = await resolveByBarcode(db, gtin)
  if (food == null) return null
  return {
    schemaVersion: SCHEMA_VERSION,
    food,
    portions: await db.all<PortionRow>(PORTIONS_SQL, [food.foodId]),
  }
}

/**
 * The deterministic pipeline, server-side.
 *
 * The phone has no corpus, so stages 4-9 cannot run there any more. It sends the
 * model's raw payload and gets back the same `ScanResult` `runPipeline` always
 * produced — the identical code path the eval harness scores.
 */
export async function handlePipeline(db: DbAdapter, req: PipelineRequest): Promise<PipelineResponse> {
  const portions = await db.all<{ food_id: number; measure_unit: string | null; gram_weight: number }>(
    'SELECT food_id, measure_unit, gram_weight FROM food_portions WHERE gram_weight > 0',
  )
  const byFood = new Map<string, Record<string, number>>()
  for (const p of portions) {
    const key = String(p.food_id)
    const measure = (p.measure_unit ?? '').trim().toLowerCase()
    if (measure === '') continue
    const existing = byFood.get(key) ?? {}
    existing[measure] = p.gram_weight
    byFood.set(key, existing)
  }

  const result = await runPipeline(
    req.raw,
    {
      db,
      priors: EMPTY_PRIORS,
      baselines: SEEDED_BASELINES,
      path: req.path,
      now: req.now,
      ...(req.barcode == null ? {} : { barcode: req.barcode }),
    },
    makeFoodDb(byFood),
  )

  // `runPipeline` returns null when the model's payload fails Zod validation
  // (stage 4). That is a client error, not a server error, so the boundary
  // (server.ts) turns this into a 400 rather than a 500.
  if (result == null) throw new BadPipelinePayloadError('the payload failed validation')

  return { schemaVersion: SCHEMA_VERSION, result }
}
