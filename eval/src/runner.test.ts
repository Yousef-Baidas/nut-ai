import { existsSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { SEEDED_BASELINES } from '@nutai/confidence'
import type { DbAdapter } from '@nutai/db-adapter'
import { openNodeDb } from '@nutai/db-adapter/node'
import { makeFoodDb } from '@nutai/pipeline'
import type { PersonalPriors } from '@nutai/gram-engine'
import {
  DB_PATH,
  evaluateGoldenSet,
  loadGateBaselines,
  loadGoldenSet,
  printReport,
  type GoldenSet,
} from './runner.js'

/**
 * Pins the claim this file exists to make true: the eval harness runs the REAL
 * pipeline, against the REAL fixture corpus, under plain Node — not a
 * reimplementation, not a mock database.
 */

const hasCorpus = existsSync(DB_PATH)
const maybe = hasCorpus ? describe : describe.skip

if (!hasCorpus) {
  console.warn(`\n[eval runner] corpus not found at ${DB_PATH} — run \`npm run data:build\` first.\n`)
}

maybe('the eval runner against the real fixture corpus', () => {
  let db: DbAdapter
  const priors: PersonalPriors = { get: () => null, containers: new Map() }
  const foodDb = makeFoodDb(new Map())

  beforeAll(() => {
    db = openNodeDb(DB_PATH, { readonly: true })
  })
  afterAll(async () => {
    await db.close()
  })

  const deps = () => ({ db, priors, baselines: SEEDED_BASELINES, path: 'cloud' as const, now: 1_753_900_000_000 })

  it('produces a gate verdict from the real golden set run through the real pipeline', async () => {
    const goldenSet = loadGoldenSet()
    const gateBaselines = loadGateBaselines()
    const run = await evaluateGoldenSet(goldenSet, deps(), foodDb, gateBaselines)

    expect(run.failures).toEqual([])
    expect(run.predictions.length).toBe(goldenSet.cases.length)
    expect(run.gate.pass).toBe(true)
    expect(run.gate.failures).toEqual([])
    expect(run.overall.n).toBe(goldenSet.cases.length)
  })

  it('fails the gate when a case truth is corrupted by 10x', async () => {
    const goldenSet = loadGoldenSet()
    const gateBaselines = loadGateBaselines()
    const good = goldenSet.cases[0]
    if (!good) throw new Error('golden set is empty')

    const corrupted: GoldenSet = {
      ...goldenSet,
      cases: [{ ...good, id: `${good.id}-corrupted`, truth: { ...good.truth, kcal: good.truth.kcal * 10 } }],
    }

    const run = await evaluateGoldenSet(corrupted, deps(), foodDb, gateBaselines)

    expect(run.failures).toEqual([])
    expect(run.gate.pass).toBe(false)
    expect(run.gate.failures.length).toBeGreaterThan(0)
  })

  it('labels the printed report as seeded, never as measured accuracy', async () => {
    const goldenSet = loadGoldenSet()
    expect(goldenSet.provenance).toBe('seeded')
    for (const c of goldenSet.cases) expect(c.provenance).toBe('seeded')

    const gateBaselines = loadGateBaselines()
    const run = await evaluateGoldenSet(goldenSet, deps(), foodDb, gateBaselines)
    expect(run.provenance).toBe('seeded')

    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '))
    })
    try {
      printReport(run)
    } finally {
      spy.mockRestore()
    }

    const output = lines.join('\n')
    expect(output).toContain('SEEDED')
    expect(output).not.toContain('measured accuracy:')
  })
})
