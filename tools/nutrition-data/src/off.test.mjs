import { describe, expect, it } from 'vitest'
import { isNutritionallySane, offFoodToRow, parseOffLine } from './off.mjs'

const GOOD = JSON.stringify({
  code: '6281006012011',
  product_name: 'Almarai Fresh Laban',
  product_name_ar: 'لبن المراعي الطازج',
  brands: 'Almarai',
  serving_size: '200 ml',
  serving_quantity: 200,
  nutriments: {
    'energy-kcal_100g': 40,
    proteins_100g: 3.2,
    fat_100g: 1.5,
    'saturated-fat_100g': 1,
    carbohydrates_100g: 4.6,
    fiber_100g: 0,
    sugars_100g: 4.6,
    sodium_100g: 0.05,
  },
})

describe('parseOffLine', () => {
  it('reads the core nutriments and both name languages', () => {
    const f = parseOffLine(GOOD)
    expect(f).not.toBeNull()
    expect(f.code).toBe('6281006012011')
    expect(f.name).toBe('Almarai Fresh Laban')
    expect(f.brand).toBe('Almarai')
    expect(f.kcal).toBe(40)
    expect(f.sodiumMg).toBeCloseTo(50, 6)
    expect(f.servingSizeG).toBe(200)
    expect(f.synonyms).toContain('لبن المراعي الطازج')
  })

  it('returns null on a blank line, malformed JSON, or a missing barcode', () => {
    expect(parseOffLine('')).toBeNull()
    expect(parseOffLine('{not json')).toBeNull()
    expect(parseOffLine(JSON.stringify({ product_name: 'x', nutriments: {} }))).toBeNull()
  })

  it('returns null when any core nutriment is absent — no fabricated zeroes', () => {
    const missingFat = JSON.parse(GOOD)
    delete missingFat.nutriments.fat_100g
    expect(parseOffLine(JSON.stringify(missingFat))).toBeNull()

    const noName = JSON.parse(GOOD)
    noName.product_name = ''
    expect(parseOffLine(JSON.stringify(noName))).toBeNull()
  })

  it('strips a BOM/zero-width-prefixed line and fields rather than mis-routing them to Arabic folding', () => {
    // ARABIC_RE (@nutai/resolver) spans U+FE70-U+FEFF, which includes the BOM
    // (U+FEFF) itself — an unstripped BOM-prefixed token gets folded as Arabic
    // script instead of Latin. The line is also invalid JSON with a raw leading
    // BOM, so this doubles as the JSON.parse-tolerance case.
    const withBom = '﻿' + JSON.stringify({
      code: '6281006012011',
      product_name: '﻿Almarai Fresh Laban',
      brands: 'Almarai',
      nutriments: {
        'energy-kcal_100g': 40,
        proteins_100g: 3.2,
        fat_100g: 1.5,
        carbohydrates_100g: 4.6,
      },
    })
    const f = parseOffLine(withBom)
    expect(f).not.toBeNull()
    expect(f.name).toBe('Almarai Fresh Laban')
    expect(f.name.includes('﻿')).toBe(false)
  })
})

describe('isNutritionallySane', () => {
  it('accepts a real product', () => {
    expect(isNutritionallySane(parseOffLine(GOOD))).toBe(true)
  })

  it('rejects an impossible energy density (kJ reported as kcal)', () => {
    const f = parseOffLine(GOOD)
    expect(isNutritionallySane({ ...f, kcal: 1700 })).toBe(false)
  })

  it('rejects macros that exceed 100 g per 100 g', () => {
    const f = parseOffLine(GOOD)
    expect(isNutritionallySane({ ...f, protein: 60, fat: 30, carb: 40 })).toBe(false)
  })

  it('rejects an Atwater mismatch beyond the clamp tolerance', () => {
    const f = parseOffLine(GOOD)
    // 4*3.2 + 4*4.6 + 9*1.5 = 44.7 kcal; a stated 400 is a decimal slip.
    expect(isNutritionallySane({ ...f, kcal: 400 })).toBe(false)
  })

  it('rejects negative values', () => {
    const f = parseOffLine(GOOD)
    expect(isNutritionallySane({ ...f, protein: -1 })).toBe(false)
  })
})

describe('offFoodToRow', () => {
  it('stamps the off tier and the ODbL licence and folds the synonyms', () => {
    const row = offFoodToRow(parseOffLine(GOOD))
    expect(row.tier).toBe('off')
    expect(row.license).toBe('ODbL-1.0')
    expect(row.source).toBe('off')
    expect(row.sourceId).toBe('6281006012011')
    expect(row.barcode).toBe('6281006012011')
    expect(row.completeness).toBe(1)
    expect(row.synonyms.some((s) => s.includes('لبن'))).toBe(true)
  })
})
