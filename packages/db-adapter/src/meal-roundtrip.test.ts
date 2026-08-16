import { beforeEach, describe, expect, it } from 'vitest'
import { openMemoryDb } from './node.js'
import { DEDUCTED_KCAL_EXPR, USER_SCHEMA } from './schema.js'
import type { DbAdapter } from './types.js'

/**
 * The log-then-read round trip, against the REAL user schema.
 *
 * The app's logMeal writes per-100g snapshots and dayTotals re-derives energy
 * as snap x grams / 100 x portion_eaten_fraction. These tests use the same
 * SQL shapes the app uses, so a schema rename, a wrong unit, or a status the
 * totals query doesn't count shows up here instead of as a Today ring that
 * quietly reads zero.
 */

let db: DbAdapter

beforeEach(async () => {
  db = openMemoryDb()
  await db.exec(USER_SCHEMA)
})

const NOW = 1_754_000_000_000

async function insertMeal(status: string, fraction = 1.0): Promise<number> {
  const r = await db.run(
    `INSERT INTO meals (logged_at, local_date, meal_slot, photo_uri, portion_eaten_fraction,
                        analysis_status, engine_id, prompt_version, schema_version, clamp_flags_json, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [NOW, '2026-08-01', 'lunch', null, fraction, status, 'test', 'food-scan-v1.1.0', '1.0.0', '[]', NOW],
  )
  return Number(r.lastInsertRowId)
}

async function insertItem(mealId: number, kcalPer100: number, grams: number, macrosUserEdited = 0): Promise<void> {
  await db.run(
    `INSERT INTO log_items (meal_id, matched_food_id, matched_food_source, raw_model_label,
                            display_name, grams, gram_pathway, portion_source,
                            snap_energy_kcal, snap_protein_g, snap_fat_g, snap_carb_g,
                            snap_fiber_g, snap_sugar_g, snap_sodium_mg,
                            is_estimate, macros_user_edited, band_half_pct, assumptions_json, sort_order, logged_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [mealId, 1, 'corpus', null, 'Test food', grams, 'packaged_exact', 'vision_model',
     kcalPer100, 10, 5, 20, null, null, null, 0, macrosUserEdited, 0.1, '[]', 0, NOW],
  )
}

// Atwater 4/4/9 over insertItem's fixed per-100g macros (10 P / 5 F / 20 C).
const ATWATER_PER_100 = 10 * 4 + 20 * 4 + 5 * 9 // = 165

const DAY_TOTALS_SQL = `
  SELECT SUM((${DEDUCTED_KCAL_EXPR}) * li.grams / 100.0 * m.portion_eaten_fraction) AS kcal,
         COUNT(DISTINCT m.id) AS meals
  FROM meals m JOIN log_items li ON li.meal_id = m.id
  WHERE m.local_date = ? AND m.analysis_status IN ('complete','manual')`

describe('meal round trip', () => {
  it('recovers snapshot x grams / 100 exactly', async () => {
    const mealId = await insertMeal('complete')
    await insertItem(mealId, 250, 200)
    const row = await db.get<{ kcal: number }>(DAY_TOTALS_SQL, ['2026-08-01'])
    expect(row!.kcal).toBeCloseTo(500, 6)
  })

  it('applies portion_eaten_fraction as a whole-meal multiplier', async () => {
    const mealId = await insertMeal('complete', 0.5)
    await insertItem(mealId, 250, 200)
    const row = await db.get<{ kcal: number }>(DAY_TOTALS_SQL, ['2026-08-01'])
    expect(row!.kcal).toBeCloseTo(250, 6)
  })

  it('counts only complete/manual meals — a pending scan contributes ZERO', async () => {
    const done = await insertMeal('complete')
    await insertItem(done, 100, 100)
    const pending = await insertMeal('analyzing')
    await insertItem(pending, 900, 500)

    const row = await db.get<{ kcal: number; meals: number }>(DAY_TOTALS_SQL, ['2026-08-01'])
    expect(row!.kcal).toBeCloseTo(100, 6)
    expect(row!.meals).toBe(1)
  })

  it('deducts the Atwater 4/4/9 recompute for a macros-edited row — matching what the display shows (issue #29)', async () => {
    const mealId = await insertMeal('manual')
    await insertItem(mealId, 250, 100, 1)
    const row = await db.get<{ kcal: number }>(DAY_TOTALS_SQL, ['2026-08-01'])
    // The display switches to the 4/4/9 recompute the moment macros are edited
    // (§6.2), so the day total must deduct that figure — never the stale 250.
    expect(row!.kcal).toBeCloseTo(ATWATER_PER_100, 6)
  })

  it('keeps deducting stored kcal verbatim for untouched rows, mixed in the same day', async () => {
    const edited = await insertMeal('manual')
    await insertItem(edited, 250, 100, 1)
    const untouched = await insertMeal('complete')
    await insertItem(untouched, 250, 100, 0)
    const row = await db.get<{ kcal: number }>(DAY_TOTALS_SQL, ['2026-08-01'])
    expect(row!.kcal).toBeCloseTo(ATWATER_PER_100 + 250, 6)
  })

  it('cascades item deletion with the meal', async () => {
    await db.exec('PRAGMA foreign_keys = ON;')
    const mealId = await insertMeal('complete')
    await insertItem(mealId, 100, 100)
    await db.run('DELETE FROM meals WHERE id = ?', [mealId])
    const left = await db.get<{ c: number }>('SELECT COUNT(*) c FROM log_items')
    expect(left!.c).toBe(0)
  })

  it('accepts a scan_cost_ledger entry tied to the meal', async () => {
    const mealId = await insertMeal('complete')
    await db.run(
      `INSERT INTO scan_cost_ledger (meal_id, provider, model, input_tokens, output_tokens, cost_usd, local_month, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [mealId, 'anthropic', 'claude-haiku-4-5-20251001', 1200, 340, 0.0029, '2026-08', NOW],
    )
    const spend = await db.get<{ usd: number }>(
      "SELECT SUM(cost_usd) usd FROM scan_cost_ledger WHERE local_month = '2026-08'",
    )
    expect(spend!.usd).toBeCloseTo(0.0029, 6)
  })
})
