import type { IngredientRow } from '@nutai/core-schema'

/**
 * Ingredient rows for the three keyless origins: a corpus food picked out of
 * text search, a food the user typed by hand, and a saved meal being relogged.
 *
 * THE CONTRACT EVERY ROW OBEYS: `nutrientSnapshot` is PER 100 g and `grams` is
 * the portion. Totals are re-derived from that pair everywhere — the review
 * screen, `dayTotals`, the backup. A row that stashed per-serving numbers in
 * the snapshot would look right once and be wrong forever after, so the
 * conversion happens here, in one place, with tests on it.
 *
 * All three use the `user_edited` gram pathway. That is not a shrug: the user
 * literally typed or picked the number, which is the strongest gram provenance
 * the app has — stronger than any ladder tier.
 */

/** The columns `startSearchLog` reads out of the corpus `foods` table. */
export interface CorpusFoodRow {
  id: number
  name: string
  energy_kcal: number | null
  protein_g: number | null
  fat_g: number | null
  carb_g: number | null
  fiber_g: number | null
  sugar_g: number | null
  sodium_mg: number | null
}

/** What the manual-entry form produces, once validated. Figures are PER PORTION. */
export interface ManualEntry {
  name: string
  grams: number
  kcal: number
  protein_g: number
  carbs_g: number
  fat_g: number
}

let seq = 0
function rowId(now: number): string {
  seq += 1
  return `row_${now}_${seq}`
}

export function rowFromCorpusFood(food: CorpusFoodRow, grams: number, now: number): IngredientRow {
  return {
    id: rowId(now),
    displayName: food.name,
    sourceFoodId: String(food.id),
    grams,
    // The corpus stores per 100 g already. Nothing to convert.
    nutrientSnapshot: {
      kcal: food.energy_kcal ?? 0,
      protein_g: food.protein_g ?? 0,
      fat_g: food.fat_g ?? 0,
      carbs_g: food.carb_g ?? 0,
      fiber_g: food.fiber_g,
      sugar_g: food.sugar_g,
      sodium_mg: food.sodium_mg,
    },
    origin: 'db_search',
    gramPathway: 'user_edited',
    // USDA generic-tier variation, not model uncertainty: the food is exact,
    // the specimen on the plate is not.
    bandHalfPct: 0.05,
    isEstimate: false,
    assumptions: [],
  }
}

export function rowFromManualEntry(entry: ManualEntry, now: number): IngredientRow {
  // Typed figures describe the PORTION. The snapshot is per 100 g.
  const per100 = entry.grams > 0 ? 100 / entry.grams : 0
  return {
    id: rowId(now),
    displayName: entry.name,
    sourceFoodId: null,
    grams: entry.grams,
    nutrientSnapshot: {
      kcal: entry.kcal * per100,
      protein_g: entry.protein_g * per100,
      fat_g: entry.fat_g * per100,
      carbs_g: entry.carbs_g * per100,
      fiber_g: null,
      sugar_g: null,
      sodium_mg: null,
    },
    origin: 'manual_custom',
    gramPathway: 'user_edited',
    // No band at all. The user is not estimating; there is nothing to be
    // uncertain about that the app knows better than they do.
    bandHalfPct: 0,
    isEstimate: false,
    assumptions: [],
  }
}

/**
 * Relog a saved meal, optionally at a fraction of the saved size.
 *
 * Only `grams` moves. The snapshot is per 100 g and therefore scale-invariant —
 * which is the same property that makes correcting a scan free.
 */
export function scaleRows(
  rows: readonly IngredientRow[],
  factor: number,
  now: number,
): IngredientRow[] {
  const f = Number.isFinite(factor) && factor > 0 ? factor : 1
  return rows.map((r) => ({ ...r, id: rowId(now), grams: r.grams * f }))
}
