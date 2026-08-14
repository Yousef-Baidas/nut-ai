import { describe, expect, it } from 'vitest'
import type { IngredientRow } from '@nutai/core-schema'
import { rowFromCorpusFood, rowFromManualEntry, scaleRows, type CorpusFoodRow } from './rows'

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
