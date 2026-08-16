import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { VisionPayload } from '@nutai/core-schema'
import { type MeasuredBaselines, SEEDED_BASELINES } from '@nutai/confidence'
import type { DbAdapter } from '@nutai/db-adapter'
import { openNodeDb } from '@nutai/db-adapter/node'
import type { PersonalPriors } from '@nutai/gram-engine'
import { makeFoodDb, runPipeline, validatePayload, type PipelineDeps } from '@nutai/pipeline'
import {
  computeMetrics,
  evaluateGate,
  metricsByPathway,
  metricsByStratum,
  type Baselines,
  type GateResult,
  type GroundTruth,
  type Metrics,
  type Prediction,
} from './scorers.js'

/**
 * The eval runner.
 *
 * The claim this repo has made in four places (packages/db-adapter/src/types.ts,
 * packages/db-adapter/src/index.ts, packages/core-schema/src/index.ts, README.md)
 * is that the eval harness imports the REAL gram engine and the REAL resolver and
 * runs them under Node against the golden set. This file is what makes that true:
 * every import above is the real package, not a stub, and `runPipeline` is the
 * exact function apps/food-server calls in production.
 *
 * The golden set (eval/golden/cases.json) is currently SEEDED — synthetic cases,
 * `provenance: 'seeded'`, computed from the fixture corpus's own per-100g values
 * rather than a kitchen scale. Every line this runner prints or returns says so.
 * Nothing here may be presented as measured accuracy until kitchen-scale-weighed
 * cases replace the seeded ones, case by case.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '../..')
export const DB_PATH = join(REPO_ROOT, 'tools/nutrition-data/out/nutrition.db')
export const GOLDEN_SET_PATH = join(HERE, '../golden/cases.json')
export const GATE_BASELINES_PATH = join(HERE, '../baselines.json')

export interface GoldenTruth {
  kcal: number
  protein_g: number
  fat_g: number
  carb_g: number
  itemGrams: number[]
}

export interface GoldenCase {
  id: string
  stratum: string
  pathway: string
  payload: VisionPayload
  truth: GoldenTruth
  provenance: 'seeded' | 'measured'
}

export interface GoldenSet {
  provenance: 'seeded' | 'measured'
  description: string
  cases: GoldenCase[]
}

interface RawGoldenFile {
  _meta: { provenance: 'seeded' | 'measured'; description: string }
  cases: GoldenCase[]
}

/** Loads and lightly validates the golden set. Never mutates it. */
export function loadGoldenSet(path: string = GOLDEN_SET_PATH): GoldenSet {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as RawGoldenFile
  if (!Array.isArray(raw.cases) || raw.cases.length === 0) {
    throw new Error(`golden set at ${path} has no cases`)
  }
  for (const c of raw.cases) {
    if (c.provenance !== 'seeded' && c.provenance !== 'measured') {
      throw new Error(`golden case ${c.id} has an unlabeled provenance`)
    }
  }
  return { provenance: raw._meta.provenance, description: raw._meta.description, cases: raw.cases }
}

/** Loads the merge-gate baselines (eval/baselines.json). */
export function loadGateBaselines(path: string = GATE_BASELINES_PATH): Baselines {
  return JSON.parse(readFileSync(path, 'utf8')) as Baselines
}

export interface CaseRunFailure {
  id: string
  reason: string
}

export interface EvalRunResult {
  provenance: 'seeded' | 'measured'
  predictions: Prediction[]
  truth: GroundTruth[]
  failures: CaseRunFailure[]
  overall: Metrics
  byStratum: Record<string, Metrics>
  byPathway: Record<string, Metrics>
  gate: GateResult
}

/**
 * Runs the REAL pipeline once per golden case and scores the result with the
 * existing (unmodified) scorers. `deps` and `foodDb` are exactly what
 * `runPipeline` takes in production — this function performs no simulation of
 * its own.
 */
export async function evaluateGoldenSet(
  goldenSet: GoldenSet,
  deps: PipelineDeps,
  foodDb: ReturnType<typeof makeFoodDb>,
  baselines: Baselines,
): Promise<EvalRunResult> {
  const predictions: Prediction[] = []
  const truth: GroundTruth[] = []
  const failures: CaseRunFailure[] = []

  for (const goldenCase of goldenSet.cases) {
    const validated = validatePayload(goldenCase.payload)
    if (!validated) {
      failures.push({ id: goldenCase.id, reason: 'payload failed VisionPayload validation' })
      continue
    }

    const result = await runPipeline(goldenCase.payload, deps, foodDb)
    if (!result) {
      failures.push({ id: goldenCase.id, reason: 'runPipeline returned null' })
      continue
    }
    if (!result.isFood) {
      failures.push({ id: goldenCase.id, reason: 'pipeline refused the payload as not-food' })
      continue
    }

    const predictedGrams = result.items.reduce((sum, item) => sum + item.row.grams, 0)

    predictions.push({
      dishId: goldenCase.id,
      stratum: goldenCase.stratum,
      pathway: goldenCase.pathway,
      predictedKcal: result.totals.kcal,
      predictedGrams,
      bandHalfPct: result.mealBand.halfPct,
    })

    truth.push({
      dishId: goldenCase.id,
      stratum: goldenCase.stratum,
      actualKcal: goldenCase.truth.kcal,
      actualGrams: goldenCase.truth.itemGrams.reduce((sum, g) => sum + g, 0),
    })
  }

  const byStratum = metricsByStratum(predictions, truth)

  return {
    provenance: goldenSet.provenance,
    predictions,
    truth,
    failures,
    overall: computeMetrics(predictions, truth),
    byStratum,
    byPathway: metricsByPathway(predictions, truth),
    gate: evaluateGate(byStratum, baselines),
  }
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`
}

function printMetricsTable(title: string, byKey: Record<string, Metrics>): void {
  console.log(`\n${title}`)
  console.log('-'.repeat(title.length))
  const keys = Object.keys(byKey).sort()
  if (keys.length === 0) {
    console.log('  (no cases)')
    return
  }
  for (const key of keys) {
    const m = byKey[key]
    if (!m || m.n === 0) continue
    console.log(
      `  ${key.padEnd(20)} n=${String(m.n).padEnd(3)} MAPE=${pct(m.mape).padEnd(7)} ` +
        `medianAPE=${pct(m.medianApe).padEnd(7)} MSPE=${pct(m.mspe).padEnd(8)} ` +
        `bandCoverage=${pct(m.bandCoverage)}`,
    )
  }
}

export function printReport(run: EvalRunResult): void {
  console.log('='.repeat(72))
  console.log('EVAL RUN — golden set provenance: SEEDED'.padEnd(60) + (run.provenance === 'seeded' ? '(seeded)' : '(measured)'))
  console.log(
    'These numbers come from a synthetic, provenance-labelled golden set, not\n' +
      'kitchen-scale-weighed dishes. They exercise the real pipeline end to end and\n' +
      'must never be presented as measured accuracy.',
  )
  console.log('='.repeat(72))

  if (run.failures.length > 0) {
    console.log('\nCASE FAILURES')
    console.log('-------------')
    for (const f of run.failures) console.log(`  ${f.id}: ${f.reason}`)
  }

  printMetricsTable('By stratum', run.byStratum)
  printMetricsTable('By pathway', run.byPathway)

  console.log(`\nOverall: n=${run.overall.n} MAPE=${pct(run.overall.mape)} bandCoverage=${pct(run.overall.bandCoverage)}`)

  console.log('\nGATE VERDICT')
  console.log('------------')
  if (run.gate.pass) {
    console.log('PASS: gate verdict — pass (seeded golden set)')
  } else {
    console.log('FAIL: gate verdict — fail (seeded golden set)')
    for (const f of run.gate.failures) console.log(`  - ${f}`)
  }
  for (const w of run.gate.warnings) console.log(`  warning: ${w}`)
}

async function main(): Promise<void> {
  if (!existsSync(DB_PATH)) {
    console.error(
      `Fixture corpus not found at ${DB_PATH}.\nRun \`npm run data:build\` first (delete the file first if a rebuild over an existing one fails on DROP TABLE ordering — see #32).`,
    )
    process.exitCode = 1
    return
  }

  const goldenSet = loadGoldenSet()
  const gateBaselines = loadGateBaselines()

  const db: DbAdapter = openNodeDb(DB_PATH, { readonly: true })
  try {
    const priors: PersonalPriors = { get: () => null, containers: new Map() }
    const foodDb = makeFoodDb(new Map())
    const deps: PipelineDeps = {
      db,
      priors,
      baselines: SEEDED_BASELINES satisfies MeasuredBaselines,
      path: 'cloud',
      now: Date.now(),
    }

    const run = await evaluateGoldenSet(goldenSet, deps, foodDb, gateBaselines)
    printReport(run)

    if (run.failures.length > 0 || !run.gate.pass) {
      process.exitCode = 1
    }
  } finally {
    await db.close()
  }
}

const isMainModule = process.argv[1] != null && import.meta.url === `file://${process.argv[1]}`
if (isMainModule) {
  main().catch((err: unknown) => {
    console.error(err)
    process.exitCode = 1
  })
}
