import { beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate, type DbAdapter } from '@nutai/db-adapter'
import { openMemoryDb } from '@nutai/db-adapter/node'
import type { IngredientRow } from '@nutai/core-schema'

/**
 * The three keyless paths, end to end at the orchestrator level.
 *
 * What this pins is the property the whole plan exists for: with NO provider,
 * NO credential and NO network, a searched food, a typed food and a saved meal
 * each arrive at `phase.kind === 'ready'` with usable totals — the same phase a
 * barcode or label scan produces, which is the same phase `result.tsx` logs.
 *
 * The provider client is mocked to throw. If any of these three paths ever
 * grows a model call, that throw is what will catch it.
 */

vi.mock('expo-image-manipulator', () => ({
  ImageManipulator: { manipulate: () => { throw new Error('no image work on a keyless path') } },
  SaveFormat: { JPEG: 'jpeg' },
}))

const CHICKEN = {
  id: 171077,
  name: 'Chicken, broilers or fryers, breast, meat only, cooked, roasted',
  energy_kcal: 165,
  protein_g: 31,
  fat_g: 3.6,
  carb_g: 0,
  fiber_g: null,
  sugar_g: null,
  sodium_mg: 74,
}

const CHICKEN_ROW = {
  id: '171077',
  name: CHICKEN.name,
  energy_kcal: 165,
  protein_g: 31,
  fat_g: 3.6,
  carb_g: 0,
  fiber_g: null,
  sugar_g: null,
  sodium_mg: 74,
}

vi.mock('../data/food-server', () => ({
  lookupBarcode: async () => ({ kind: 'not_found' }),
  runRemotePipeline: async () => ({ kind: 'server_unreachable', reason: 'network', detail: 'no server in this test' }),
  UNREACHABLE_COPY: 'Food database unreachable — is the PC on?',
}))

vi.mock('../data/repo', () => ({
  setting: async () => '',
  putSetting: async () => {},
}))

vi.mock('../inference/credentials', () => ({ loadCredential: async () => null }))

vi.mock('../inference/cloud/client', () => {
  const boom = () => { throw new Error('a keyless path must never call a provider') }
  return { runLabelScan: boom, runReceiptScan: boom, runScanWithFallback: boom, runWebLookup: boom }
})

const { startManualLog, startSavedMealLog, startSearchLog } = await import('./orchestrator')
const { getPhase, reset } = await import('./store')

beforeEach(() => reset())

describe('search → log, with no key', () => {
  it('reaches a ready phase with the corpus food at the chosen portion', () => {
    expect(startSearchLog(CHICKEN_ROW, 150)).toBe(true)

    const phase = getPhase()
    expect(phase.kind).toBe('ready')
    if (phase.kind !== 'ready') throw new Error('unreachable')

    const [row] = phase.result.meal.ingredients
    expect(row!.displayName).toBe(CHICKEN.name)
    expect(row!.grams).toBe(150)
    expect(row!.origin).toBe('db_search')
    // 165 kcal / 100 g at 150 g = 247.5, reconciled from displayed macros.
    // Protein 31 g/100 g at 150 g = 46.5 g raw; display rounding (@nutai/totals
    // roundDisplayGrams, whole grams at >= 10 g) rounds that to 47 before the
    // calorie reconciliation runs — the same rule every other display total obeys.
    expect(phase.result.totals.kcal).toBeGreaterThan(180)
    expect(phase.result.totals.protein_g).toBeCloseTo(47, 1)
    expect(phase.result.meal.engineId).toBe('search-log')
  })

  it('asks no clarifying questions — the user already answered the only one', () => {
    startSearchLog(CHICKEN_ROW, 150)
    const phase = getPhase()
    if (phase.kind !== 'ready') throw new Error('unreachable')
    expect(phase.result.questions).toEqual([])
    expect(phase.result.items[0]!.resolution).toBe('auto_accept')
  })

  it('reports a corpus row that is not there, instead of opening an empty review', () => {
    expect(startSearchLog(null, 150)).toBe(false)
    expect(getPhase().kind).toBe('idle')
  })
})

describe('manual entry → log, with no key', () => {
  it('reaches a ready phase whose totals are the numbers the user typed', () => {
    startManualLog({ name: 'Nonna’s lasagne', grams: 250, kcal: 500, protein_g: 25, carbs_g: 50, fat_g: 20 })

    const phase = getPhase()
    expect(phase.kind).toBe('ready')
    if (phase.kind !== 'ready') throw new Error('unreachable')
    expect(phase.result.meal.ingredients[0]!.displayName).toBe('Nonna’s lasagne')
    expect(phase.result.totals.protein_g).toBeCloseTo(25, 1)
    expect(phase.result.totals.carbs_g).toBeCloseTo(50, 1)
    expect(phase.result.totals.fat_g).toBeCloseTo(20, 1)
    expect(phase.result.meal.engineId).toBe('manual-entry')
  })

  it('shows the typed kcal, not 0, for a calories-only entry (issue #28)', () => {
    // Repro: name + calories only, macros left at 0 (the form's own copy says
    // this is enough). The result screen used to recompute kcal via Atwater
    // over the rounded 0/0/0 macros and show 0, while day totals — which sum
    // stored kcal directly — deducted the real figure.
    startManualLog({ name: 'Protein bar', grams: 60, kcal: 150, protein_g: 0, carbs_g: 0, fat_g: 0 })
    const phase = getPhase()
    expect(phase.kind).toBe('ready')
    if (phase.kind !== 'ready') throw new Error('unreachable')

    expect(phase.result.totals.kcal).toBe(150)
    // What dayTotals deducts for an untouched row: snap_energy_kcal * grams / 100 * portion.
    const [row] = phase.result.meal.ingredients
    const deducted =
      (row!.nutrientSnapshot.kcal * row!.grams * phase.result.meal.portionEatenFraction) / 100
    expect(phase.result.totals.kcal).toBeCloseTo(deducted, 6)
  })

  it('carries no band — the user is not estimating', () => {
    startManualLog({ name: 'Toast', grams: 40, kcal: 100, protein_g: 3, carbs_g: 18, fat_g: 1 })
    const phase = getPhase()
    if (phase.kind !== 'ready') throw new Error('unreachable')
    expect(phase.bands[0]!.halfPct).toBe(0)
    expect(phase.bands[0]!.reasons).toEqual(['Numbers you entered yourself'])
  })
})

describe('saved meal → log again, with no key', () => {
  const saved: IngredientRow[] = [
    {
      id: 'row_saved_1',
      displayName: 'Rice, white, cooked',
      sourceFoodId: '169704',
      grams: 200,
      nutrientSnapshot: { kcal: 130, protein_g: 2.7, fat_g: 0.3, carbs_g: 28, fiber_g: 0.4, sugar_g: null, sodium_mg: 1 },
      origin: 'db_search',
      gramPathway: 'user_edited',
      bandHalfPct: 0.05,
      isEstimate: false,
      assumptions: [],
    },
    {
      id: 'row_saved_2',
      displayName: 'Chicken breast, roasted',
      sourceFoodId: '171077',
      grams: 150,
      nutrientSnapshot: { kcal: 165, protein_g: 31, fat_g: 3.6, carbs_g: 0, fiber_g: null, sugar_g: null, sodium_mg: 74 },
      origin: 'db_search',
      gramPathway: 'user_edited',
      bandHalfPct: 0.05,
      isEstimate: false,
      assumptions: [],
    },
  ]

  it('relogs every saved row at full size with the saved snapshots', () => {
    startSavedMealLog(saved, 1)

    const phase = getPhase()
    expect(phase.kind).toBe('ready')
    if (phase.kind !== 'ready') throw new Error('unreachable')
    expect(phase.result.meal.ingredients.map((r) => r.grams)).toEqual([200, 150])
    expect(phase.result.meal.ingredients.map((r) => r.nutrientSnapshot.kcal)).toEqual([130, 165])
    expect(phase.result.meal.engineId).toBe('saved-meal')
  })

  it('halves grams and nothing else at factor 0.5', () => {
    startSavedMealLog(saved, 0.5)
    const phase = getPhase()
    if (phase.kind !== 'ready') throw new Error('unreachable')
    expect(phase.result.meal.ingredients.map((r) => r.grams)).toEqual([100, 75])
    expect(phase.result.meal.ingredients.map((r) => r.nutrientSnapshot.kcal)).toEqual([130, 165])
  })

  it('issues fresh row ids so a relog cannot collide with the saved original', () => {
    startSavedMealLog(saved, 1)
    const phase = getPhase()
    if (phase.kind !== 'ready') throw new Error('unreachable')
    expect(phase.result.meal.ingredients.map((r) => r.id)).not.toContain('row_saved_1')
  })
})

/**
 * Controller addition (pre-flight ruling F3): the saved-meal test above hand-builds a
 * row array in memory. That pins the orchestrator seam but not the persistence round
 * trip — it never proves that what `saveMeal` actually writes is what `startSavedMealLog`
 * can actually relog. This block closes that gap against a real (in-memory) DB, using
 * the same `openMemoryDb` + `migrate` idiom `saved-meals.test.ts` uses.
 */
describe('saved meal → log again, through a real save/list round trip', () => {
  let db: DbAdapter
  const NOW = 1_754_100_000_000

  const original: IngredientRow[] = [
    {
      id: 'row_orig_1',
      displayName: 'Rice, white, cooked',
      sourceFoodId: '169704',
      grams: 200,
      nutrientSnapshot: { kcal: 130, protein_g: 2.7, fat_g: 0.3, carbs_g: 28, fiber_g: 0.4, sugar_g: null, sodium_mg: 1 },
      origin: 'db_search',
      gramPathway: 'user_edited',
      bandHalfPct: 0.05,
      isEstimate: false,
      assumptions: [],
    },
    {
      id: 'row_orig_2',
      displayName: 'Chicken breast, roasted',
      sourceFoodId: '171077',
      grams: 150,
      nutrientSnapshot: { kcal: 165, protein_g: 31, fat_g: 3.6, carbs_g: 0, fiber_g: null, sugar_g: null, sodium_mg: 74 },
      origin: 'db_search',
      gramPathway: 'user_edited',
      bandHalfPct: 0.05,
      isEstimate: false,
      assumptions: [],
    },
  ]

  beforeEach(async () => {
    db = openMemoryDb()
    await db.exec('PRAGMA foreign_keys = ON;')
    await migrate(db, NOW)
  })

  it('relogs a meal that was actually saved and read back, scaled by the chosen factor', async () => {
    const { parseSavedItems, saveMeal, listSavedMeals } = await import('../data/saved-meals')

    await saveMeal(db, 'Rice and chicken', original, NOW)
    const [saved] = await listSavedMeals(db)
    const rows = parseSavedItems(saved!.items_json)
    expect(rows).toEqual(original)

    startSavedMealLog(rows, 0.5)

    const phase = getPhase()
    expect(phase.kind).toBe('ready')
    if (phase.kind !== 'ready') throw new Error('unreachable')

    // Grams scale by the factor; per-gram nutrient snapshot values do not.
    expect(phase.result.meal.ingredients.map((r) => r.grams)).toEqual(
      original.map((r) => r.grams * 0.5),
    )
    expect(phase.result.meal.ingredients.map((r) => r.nutrientSnapshot.kcal)).toEqual(
      original.map((r) => r.nutrientSnapshot.kcal),
    )
    expect(phase.result.meal.engineId).toBe('saved-meal')
  })
})
