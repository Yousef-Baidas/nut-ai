import { beforeEach, describe, expect, it } from 'vitest'
import { migrate, type DbAdapter } from '@nutai/db-adapter'
import { openMemoryDb } from '@nutai/db-adapter/node'
import type { IngredientRow } from '@nutai/core-schema'
import {
  deleteSavedMeal,
  listSavedMeals,
  parseSavedItems,
  saveMeal,
  touchSavedMeal,
} from './saved-meals'

/**
 * The saved_meals write path, against the REAL user schema.
 *
 * The table has shipped since the first migration and nothing has ever written
 * to it, so the round trip has never been exercised. What matters is that the
 * stored blob is the CORRECTED ingredient array — snapshots and all — because
 * that is the entire reason relogging costs zero network requests.
 */

let db: DbAdapter
const NOW = 1_754_100_000_000

const ROWS: IngredientRow[] = [
  {
    id: 'row_1',
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
    id: 'row_2',
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

describe('saveMeal', () => {
  it('round-trips the corrected ingredient array, snapshots intact', async () => {
    const id = await saveMeal(db, 'Rice and chicken', ROWS, NOW)
    const [saved] = await listSavedMeals(db)
    expect(saved!.id).toBe(id)
    expect(saved!.name).toBe('Rice and chicken')
    expect(parseSavedItems(saved!.items_json)).toEqual(ROWS)
  })

  it('starts at zero uses — saving is not logging', async () => {
    await saveMeal(db, 'Rice and chicken', ROWS, NOW)
    const [saved] = await listSavedMeals(db)
    expect(saved!.use_count).toBe(0)
  })

  it('trims the name and refuses an empty one', async () => {
    await saveMeal(db, '  Porridge  ', ROWS, NOW)
    const [saved] = await listSavedMeals(db)
    expect(saved!.name).toBe('Porridge')
    await expect(saveMeal(db, '   ', ROWS, NOW)).rejects.toThrow()
  })
})

describe('listSavedMeals', () => {
  it('orders by use count, then by most recently used', async () => {
    const a = await saveMeal(db, 'A', ROWS, NOW)
    const b = await saveMeal(db, 'B', ROWS, NOW)
    await touchSavedMeal(db, b, NOW + 1000)
    const names = (await listSavedMeals(db)).map((m) => m.name)
    expect(names).toEqual(['B', 'A'])
    expect(a).not.toBe(b)
  })
})

describe('touchSavedMeal', () => {
  it('increments the use count and stamps last_used_at', async () => {
    const id = await saveMeal(db, 'Rice and chicken', ROWS, NOW)
    await touchSavedMeal(db, id, NOW + 5000)
    await touchSavedMeal(db, id, NOW + 9000)
    const row = await db.get<{ use_count: number; last_used_at: number }>(
      'SELECT use_count, last_used_at FROM saved_meals WHERE id = ?',
      [id],
    )
    expect(row!.use_count).toBe(2)
    expect(row!.last_used_at).toBe(NOW + 9000)
  })
})

describe('deleteSavedMeal', () => {
  it('removes the row and nothing else', async () => {
    const keep = await saveMeal(db, 'Keep', ROWS, NOW)
    const drop = await saveMeal(db, 'Drop', ROWS, NOW)
    await deleteSavedMeal(db, drop)
    expect((await listSavedMeals(db)).map((m) => m.id)).toEqual([keep])
  })
})

describe('parseSavedItems', () => {
  it('returns an empty array for a blob it cannot read, rather than throwing at a user', () => {
    expect(parseSavedItems('not json')).toEqual([])
    expect(parseSavedItems('{"not":"an array"}')).toEqual([])
  })
})
