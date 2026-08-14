import { describe, expect, it } from 'vitest'
import type { DbAdapter } from '@nutai/db-adapter'
import {
  DEFAULT_PORTION_GRAMS,
  portionOptionsFor,
  toPortionOptions,
  type PortionSourceRow,
} from './portion-options'

/**
 * Household measures for the portion sheet.
 *
 * The gram ladder's mapping (portions.ts) throws away everything it cannot
 * classify into four keys. This one keeps the free text, because a human
 * reading "1 cup, sliced — 150 g" needs no classification at all. What it must
 * NOT do is offer a zero-weight row or two rows that say the same thing.
 */

function fakeDb(rows: PortionSourceRow[]): DbAdapter {
  return { all: async () => rows as never } as unknown as DbAdapter
}

describe('toPortionOptions', () => {
  it('labels a measure with its amount, unit and modifier', () => {
    expect(
      toPortionOptions([
        { measure_unit: 'cup', modifier: 'sliced', amount: 1, gram_weight: 150, is_fndds_default: 0 },
      ]),
    ).toEqual([{ label: '1 cup, sliced', grams: 150 }])
  })

  it('keeps a plural amount visible so nobody mistakes it for one unit', () => {
    expect(
      toPortionOptions([
        { measure_unit: 'piece', modifier: null, amount: 3, gram_weight: 84, is_fndds_default: 0 },
      ]),
    ).toEqual([{ label: '3 piece', grams: 84 }])
  })

  it('drops USDA placeholder units rather than offering "1 undetermined"', () => {
    expect(
      toPortionOptions([
        { measure_unit: 'undetermined', modifier: 'medium', amount: 1, gram_weight: 118, is_fndds_default: 0 },
      ]),
    ).toEqual([{ label: '1 medium', grams: 118 }])
  })

  it('drops rows with no usable weight and no usable text', () => {
    expect(
      toPortionOptions([
        { measure_unit: 'cup', modifier: null, amount: 1, gram_weight: 0, is_fndds_default: 0 },
        { measure_unit: 'undetermined', modifier: null, amount: null, gram_weight: 50, is_fndds_default: 0 },
      ]),
    ).toEqual([])
  })

  it('de-duplicates identical label/weight pairs', () => {
    expect(
      toPortionOptions([
        { measure_unit: 'cup', modifier: null, amount: 1, gram_weight: 150, is_fndds_default: 0 },
        { measure_unit: 'cup', modifier: null, amount: 1, gram_weight: 150, is_fndds_default: 1 },
      ]),
    ).toEqual([{ label: '1 cup', grams: 150 }])
  })

  it('puts the FNDDS default first — it is USDA’s own idea of a serving', () => {
    expect(
      toPortionOptions([
        { measure_unit: 'cup', modifier: null, amount: 1, gram_weight: 150, is_fndds_default: 0 },
        { measure_unit: 'piece', modifier: null, amount: 1, gram_weight: 28, is_fndds_default: 1 },
      ]),
    ).toEqual([
      { label: '1 piece', grams: 28 },
      { label: '1 cup', grams: 150 },
    ])
  })
})

describe('portionOptionsFor', () => {
  it('returns the mapped options for a food', async () => {
    const opts = await portionOptionsFor(
      fakeDb([{ measure_unit: 'cup', modifier: null, amount: 1, gram_weight: 150, is_fndds_default: 0 }]),
      '42',
    )
    expect(opts).toEqual([{ label: '1 cup', grams: 150 }])
  })

  it('returns an empty list for the 285 foods with no portion rows — the sheet falls to 100 g', async () => {
    expect(await portionOptionsFor(fakeDb([]), '999')).toEqual([])
    expect(DEFAULT_PORTION_GRAMS).toBe(100)
  })

  it('degrades to an empty list rather than throwing when the query fails', async () => {
    const broken = { all: async () => { throw new Error('no such table') } } as unknown as DbAdapter
    expect(await portionOptionsFor(broken, '1')).toEqual([])
  })
})
