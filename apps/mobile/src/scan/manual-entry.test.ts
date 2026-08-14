import { describe, expect, it } from 'vitest'
import { validateManualEntry, type ManualEntryForm } from './manual-entry'

/**
 * The manual-entry form's contract.
 *
 * The screen is the last resort — no corpus match, no barcode, no key — so it
 * must not itself become a way to log nonsense. Two rules: a name and a calorie
 * figure are required (a nameless zero-calorie row is not a meal), and no number
 * may be negative. Everything else is optional, because a packet that prints
 * only calories is a real packet.
 */

const BLANK: ManualEntryForm = { name: '', grams: '', kcal: '', protein: '', carbs: '', fat: '' }

describe('validateManualEntry', () => {
  it('accepts a name, grams and calories', () => {
    const r = validateManualEntry({ ...BLANK, name: 'Nonna’s lasagne', grams: '250', kcal: '500' })
    expect(r).toEqual({
      ok: true,
      value: { name: 'Nonna’s lasagne', grams: 250, kcal: 500, protein_g: 0, carbs_g: 0, fat_g: 0 },
    })
  })

  it('keeps the macros when they are given', () => {
    const r = validateManualEntry({
      name: 'Protein bar',
      grams: '60',
      kcal: '220',
      protein: '20',
      carbs: '22',
      fat: '7',
    })
    expect(r.ok && r.value).toEqual({
      name: 'Protein bar',
      grams: 60,
      kcal: 220,
      protein_g: 20,
      carbs_g: 22,
      fat_g: 7,
    })
  })

  it('defaults grams to 100 when the packet does not say', () => {
    const r = validateManualEntry({ ...BLANK, name: 'Mystery snack', kcal: '180' })
    expect(r.ok && r.value.grams).toBe(100)
  })

  it('requires a name', () => {
    expect(validateManualEntry({ ...BLANK, name: '   ', kcal: '200' })).toEqual({
      ok: false,
      error: 'Give it a name — you will need to recognise it in the log.',
    })
  })

  it('requires calories', () => {
    expect(validateManualEntry({ ...BLANK, name: 'Toast' })).toEqual({
      ok: false,
      error: 'Calories are required. Everything else is optional.',
    })
  })

  it('rejects a negative number anywhere', () => {
    expect(validateManualEntry({ ...BLANK, name: 'Toast', kcal: '100', fat: '-2' })).toEqual({
      ok: false,
      error: 'Numbers cannot be negative.',
    })
    expect(validateManualEntry({ ...BLANK, name: 'Toast', kcal: '100', grams: '-1' })).toEqual({
      ok: false,
      error: 'Numbers cannot be negative.',
    })
  })

  it('rejects text where a number belongs instead of silently logging NaN', () => {
    expect(validateManualEntry({ ...BLANK, name: 'Toast', kcal: 'a lot' })).toEqual({
      ok: false,
      error: 'Calories are required. Everything else is optional.',
    })
    expect(validateManualEntry({ ...BLANK, name: 'Toast', kcal: '100', protein: 'some' })).toEqual({
      ok: false,
      error: 'Protein is not a number.',
    })
  })

  it('rejects zero grams instead of logging an all-zero snapshot', () => {
    expect(validateManualEntry({ ...BLANK, name: 'Toast', kcal: '100', grams: '0' })).toEqual({
      ok: false,
      error: 'Grams cannot be zero — leave it blank to default to 100 g.',
    })
    expect(validateManualEntry({ ...BLANK, name: 'Toast', kcal: '100', grams: '0.0' })).toEqual({
      ok: false,
      error: 'Grams cannot be zero — leave it blank to default to 100 g.',
    })
  })

  it('still defaults grams to 100 when the field is left blank', () => {
    const r = validateManualEntry({ ...BLANK, name: 'Toast', kcal: '100' })
    expect(r.ok && r.value.grams).toBe(100)
  })

  it('trims the name', () => {
    const r = validateManualEntry({ ...BLANK, name: '  Porridge  ', kcal: '150' })
    expect(r.ok && r.value.name).toBe('Porridge')
  })
})
