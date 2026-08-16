import type { IngredientRow } from '@nutai/core-schema'
import type { ScanResult } from '@nutai/pipeline'

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
  id: string | number
  name: string
  energy_kcal: number | null
  protein_g: number | null
  fat_g: number | null
  carb_g: number | null
  fiber_g: number | null
  sugar_g: number | null
  sodium_mg: number | null
  /** `foods.source` — feeds `attributionFor`. Absent only for pre-existing callers. */
  source?: string | null
}

/**
 * Honest per-source attribution text. ResolvedFood/CorpusFoodRow carry
 * `source`, which names the actual origin of a corpus row — collapsing every
 * hit to "USDA" is simply false for the majority-share Open Food Facts tier.
 *
 * `source` values seen in practice: 'off' (Open Food Facts), 'fdc_branded' /
 * 'fdc_foundation' / 'fdc_sr_legacy' (USDA), 'arab_curated' (the checked-in,
 * cited CSV). Anything else (null, a future tier) falls back to a name that is
 * never wrong, just less specific.
 */
export function attributionFor(source: string | null | undefined): string {
  if (source === 'off') return 'Open Food Facts'
  if (source === 'arab_curated') return 'a cited food-composition table'
  if (source != null && (source.startsWith('fdc') || source.startsWith('usda'))) return 'USDA'
  return 'a food database'
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
    dbSource: food.source ?? null,
    gramPathway: 'user_edited',
    // Corpus generic-tier variation, not model uncertainty: the food is exact,
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

/**
 * Band reason per origin, honest about what actually produced the row.
 *
 * `readyFromRows` (orchestrator.ts) is fed by SIX call sites — barcode, label,
 * receipt, and the three keyless seams here (search, manual, saved-meal-relog).
 * A saved meal can carry ANY origin the app has ever written, including
 * `vision_model` and `assumption_filler` rows from a prior photo scan. Falling
 * through to the barcode string for those would claim a barcode match that
 * never happened.
 */
export function bandReasonFor(origin: IngredientRow['origin'], dbSource?: string | null): string {
  switch (origin) {
    case 'label_ocr':
      return 'Transcribed from the printed nutrition label'
    case 'web_lookup':
      return 'Transcribed from published nutrition facts'
    case 'db_search':
      return `Matched to a food-database result (${attributionFor(dbSource)}), at a portion you chose`
    case 'manual_custom':
      return 'Numbers you entered yourself'
    case 'barcode':
      return `Matched by barcode to a labeled product (${attributionFor(dbSource)})`
    case 'vision_model':
    case 'assumption_filler':
      return 'Estimated from the photo'
    default:
      return 'Estimated'
  }
}

/**
 * The server's `ResolvedFood` in the shape the row builders already speak.
 *
 * Two names for one row is a smell, but the alternative is rewriting every
 * builder and every test that feeds it — and the snake_case shape is the corpus
 * column names, which is a meaning worth keeping.
 */
export function corpusRowFromResolved(food: {
  foodId: string
  name: string
  energyKcal: number | null
  proteinG: number | null
  fatG: number | null
  carbG: number | null
  fiberG: number | null
  sugarG: number | null
  sodiumMg: number | null
  source?: string | null
}): CorpusFoodRow {
  return {
    id: food.foodId,
    name: food.name,
    energy_kcal: food.energyKcal,
    protein_g: food.proteinG,
    fat_g: food.fatG,
    carb_g: food.carbG,
    fiber_g: food.fiberG,
    sugar_g: food.sugarG,
    sodium_mg: food.sodiumMg,
    source: food.source ?? null,
  }
}

/**
 * Resolution per origin. Only a row the user picked or typed (`db_search`,
 * `manual_custom`) or one that matched an exact barcode/label/citation
 * (`barcode`, `label_ocr`, `web_lookup`) is `auto_accept` / `barcode` —
 * everything else (a bare model estimate, e.g. `vision_model` or
 * `assumption_filler` surfacing on a relogged saved meal) is a `miss`, never
 * a borrowed barcode label it did not earn.
 */
export function resolutionFor(origin: IngredientRow['origin']): ScanResult['items'][number]['resolution'] {
  switch (origin) {
    case 'db_search':
    case 'manual_custom':
      return 'auto_accept'
    case 'barcode':
    case 'label_ocr':
    case 'web_lookup':
      return 'barcode'
    default:
      return 'miss'
  }
}
