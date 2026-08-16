import { describe, expect, it } from 'vitest'
import type { ResolvedFood } from '@nutai/resolver'
import { corpusRowFromResolved, rowFromCorpusFood } from './rows'

const FOOD: ResolvedFood = {
  foodId: '2',
  name: 'Almarai Fresh Laban',
  brand: 'Almarai',
  energyKcal: 40,
  proteinG: 3.2,
  fatG: 1.5,
  carbG: 4.6,
  fiberG: null,
  sugarG: 4.6,
  sodiumMg: 50,
  servingSizeG: 200,
  servingDesc: '200 ml',
  license: 'ODbL-1.0',
  source: 'off',
}

describe('corpusRowFromResolved', () => {
  it('maps the server camelCase shape onto the row builder snake_case shape', () => {
    const row = corpusRowFromResolved(FOOD)
    expect(row.id).toBe('2')
    expect(row.name).toBe('Almarai Fresh Laban')
    expect(row.energy_kcal).toBe(40)
    expect(row.protein_g).toBe(3.2)
    expect(row.carb_g).toBe(4.6)
    expect(row.sodium_mg).toBe(50)
  })

  it('keeps a not-reported nutrient null rather than inventing a zero', () => {
    const row = corpusRowFromResolved({ ...FOOD, fiberG: null })
    expect(row.fiber_g).toBeNull()
  })

  it('produces a row the existing builder accepts unchanged', () => {
    const ingredient = rowFromCorpusFood(corpusRowFromResolved(FOOD), 200, 1_755_000_000_000)
    expect(ingredient.displayName).toBe('Almarai Fresh Laban')
    expect(ingredient.sourceFoodId).toBe('2')
    expect(ingredient.grams).toBe(200)
    expect(ingredient.nutrientSnapshot.kcal).toBe(40)
    expect(ingredient.origin).toBe('db_search')
  })
})
