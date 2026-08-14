import { describe, expect, it } from 'vitest'
import { bandTier } from '@nutai/confidence'
import type { IngredientRow } from '@nutai/core-schema'
import {
  bandReasonFor,
  resolutionFor,
  rowFromCorpusFood,
  rowFromManualEntry,
  scaleRows,
  type CorpusFoodRow,
} from './rows'

/**
 * The keyless origins' rows.
 *
 * Every row in this app carries a PER-100 g snapshot and a gram count, and the
 * totals are re-derived from that pair. A row built here that stored per-serving
 * numbers in the snapshot would read correct on the review screen and wrong in
 * the log, so these tests pin the per-100 g contract at the source.
 */

const NOW = 1_754_100_000_000

const CHICKEN: CorpusFoodRow = {
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

describe('rowFromCorpusFood', () => {
  it('copies the corpus per-100 g figures into the snapshot untouched', () => {
    const row = rowFromCorpusFood(CHICKEN, 150, NOW)
    expect(row.nutrientSnapshot).toEqual({
      kcal: 165,
      protein_g: 31,
      fat_g: 3.6,
      carbs_g: 0,
      fiber_g: null,
      sugar_g: null,
      sodium_mg: 74,
    })
    expect(row.grams).toBe(150)
  })

  it('carries the corpus id, so the row is traceable to its source', () => {
    expect(rowFromCorpusFood(CHICKEN, 150, NOW).sourceFoodId).toBe('171077')
  })

  it('is a db_search row on the user_edited pathway — the user typed the grams', () => {
    const row = rowFromCorpusFood(CHICKEN, 150, NOW)
    expect(row.origin).toBe('db_search')
    expect(row.gramPathway).toBe('user_edited')
    expect(row.isEstimate).toBe(false)
  })

  it('treats a corpus row with no energy as zero rather than NaN', () => {
    const row = rowFromCorpusFood({ ...CHICKEN, energy_kcal: null, protein_g: null }, 100, NOW)
    expect(row.nutrientSnapshot.kcal).toBe(0)
    expect(row.nutrientSnapshot.protein_g).toBe(0)
  })
})

describe('rowFromManualEntry', () => {
  it('converts the typed per-portion figures to a per-100 g snapshot', () => {
    const row = rowFromManualEntry(
      { name: 'Nonna’s lasagne', grams: 250, kcal: 500, protein_g: 25, carbs_g: 50, fat_g: 20 },
      NOW,
    )
    expect(row.grams).toBe(250)
    expect(row.nutrientSnapshot.kcal).toBe(200)
    expect(row.nutrientSnapshot.protein_g).toBe(10)
    expect(row.nutrientSnapshot.carbs_g).toBe(20)
    expect(row.nutrientSnapshot.fat_g).toBe(8)
  })

  it('is a manual_custom row with no band — the user typed the truth', () => {
    const row = rowFromManualEntry({ name: 'Toast', grams: 40, kcal: 100, protein_g: 3, carbs_g: 18, fat_g: 1 }, NOW)
    expect(row.origin).toBe('manual_custom')
    expect(row.gramPathway).toBe('user_edited')
    expect(row.bandHalfPct).toBe(0)
    expect(row.sourceFoodId).toBeNull()
    expect(row.isEstimate).toBe(false)
  })

  it('refuses to divide by zero grams', () => {
    const row = rowFromManualEntry({ name: 'Air', grams: 0, kcal: 100, protein_g: 0, carbs_g: 0, fat_g: 0 }, NOW)
    expect(row.nutrientSnapshot.kcal).toBe(0)
    expect(Number.isNaN(row.nutrientSnapshot.kcal)).toBe(false)
  })
})

describe('scaleRows', () => {
  const saved: IngredientRow[] = [
    {
      id: 'row_old_1',
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
  ]

  it('scales grams and leaves the snapshot alone — the snapshot is per 100 g', () => {
    const [row] = scaleRows(saved, 0.5, NOW)
    expect(row!.grams).toBe(100)
    expect(row!.nutrientSnapshot.kcal).toBe(130)
  })

  it('issues fresh row ids so a relog never collides with the original', () => {
    const [row] = scaleRows(saved, 1, NOW)
    expect(row!.id).not.toBe('row_old_1')
  })

  it('is the identity at factor 1, apart from the id', () => {
    const [row] = scaleRows(saved, 1, NOW)
    expect({ ...row, id: 'row_old_1' }).toEqual(saved[0])
  })
})

/**
 * `readyFromRows` in orchestrator.ts (untestable directly under Vitest — it
 * transitively imports react-native) is fed by six call sites, including
 * `startSavedMealLog`, which can relog a row of ANY origin ever written,
 * including `vision_model` and `assumption_filler` from a prior photo scan.
 * These two functions are the honesty gate: no origin may fall through to a
 * barcode claim it did not earn.
 */
describe('bandReasonFor', () => {
  it('never lets vision_model or assumption_filler fall through to a barcode claim', () => {
    expect(bandReasonFor('vision_model')).toBe('Estimated from the photo')
    expect(bandReasonFor('assumption_filler')).toBe('Estimated from the photo')
  })

  it('keeps the barcode claim explicit, not a fallback default', () => {
    expect(bandReasonFor('barcode')).toBe('Matched by barcode to a labeled product')
  })

  it('gives every keyless origin its own honest reason', () => {
    expect(bandReasonFor('db_search')).toBe('Matched to a USDA corpus food, at a portion you chose')
    expect(bandReasonFor('manual_custom')).toBe('Numbers you entered yourself')
  })

  it('gives label_ocr and web_lookup their transcription reasons', () => {
    expect(bandReasonFor('label_ocr')).toBe('Transcribed from the printed nutrition label')
    expect(bandReasonFor('web_lookup')).toBe('Transcribed from published nutrition facts')
  })
})

describe('resolutionFor', () => {
  it('resolves vision_model and assumption_filler as miss, never barcode', () => {
    expect(resolutionFor('vision_model')).toBe('miss')
    expect(resolutionFor('assumption_filler')).toBe('miss')
  })

  it('auto_accepts what the user picked or typed', () => {
    expect(resolutionFor('db_search')).toBe('auto_accept')
    expect(resolutionFor('manual_custom')).toBe('auto_accept')
  })

  it('reserves barcode resolution for barcode, label_ocr and web_lookup rows', () => {
    expect(resolutionFor('barcode')).toBe('barcode')
    expect(resolutionFor('label_ocr')).toBe('barcode')
    expect(resolutionFor('web_lookup')).toBe('barcode')
  })
})

/**
 * Tier is DERIVED from bandHalfPct via the same `bandTier` function the
 * engine's own bands use — never a hardcoded 'tight'. A manual_custom row
 * carries bandHalfPct 0, which must resolve to 'none' (ConfidenceChip
 * suppresses the badge only at tier 'none' — a hardcoded 'tight' would render
 * "Estimate — tap for range" over a zero-width range).
 */
describe('bandTier — the tier readyFromRows now derives instead of hardcoding', () => {
  it('maps a zero band (manual_custom) to none', () => {
    expect(bandTier(0)).toBe('none')
  })

  it('maps a wide relogged vision-model band away from tight', () => {
    expect(bandTier(0.4)).not.toBe('tight')
    expect(bandTier(0.4)).toBe('wide')
  })
})
