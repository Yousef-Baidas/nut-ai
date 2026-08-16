import { describe, expect, it } from 'vitest'
import type { IngredientRow, LoggedMeal } from '@nutai/core-schema'
import {
  calorieBasisFor,
  itemCalories,
  labelRounding,
  recomputeTotals,
  reconcileFromMacros,
  roundDisplayGrams,
  toDisplayTotals,
  toDisplayTotalsForMeal,
} from './index.js'

function row(over: Partial<IngredientRow> = {}): IngredientRow {
  return {
    id: 'r1',
    displayName: 'Chicken breast, grilled',
    sourceFoodId: 'fdc:171077',
    grams: 100,
    nutrientSnapshot: {
      kcal: 165,
      protein_g: 31,
      fat_g: 3.6,
      carbs_g: 0,
      fiber_g: 0,
      sodium_mg: 74,
    },
    origin: 'db_search',
    gramPathway: 'fndds_standard_portion',
    bandHalfPct: 0.25,
    isEstimate: false,
    assumptions: [],
    ...over,
  }
}

function meal(ingredients: IngredientRow[], portionEatenFraction = 1): LoggedMeal {
  return {
    id: 'm1',
    loggedAt: '2026-07-31T18:00:00.000Z',
    ingredients,
    portionEatenFraction,
    engineId: 'test',
    promptVersion: 'food-scan-v1.0.0',
    schemaVersion: '1.0.0',
    clampFlags: [],
  }
}

describe('the documented edit bug this module exists to prevent', () => {
  // Reported behaviour of the app we are replacing: a user edited protein from
  // 226 g down to 175 g and the calorie figure stayed at 2,964 kcal, with fat and
  // carbs also unchanged. That is only possible if calories are stored as an
  // independent number rather than derived from the rows.
  it('moves calories when a macro is edited', () => {
    const before = row({
      grams: 100,
      nutrientSnapshot: { kcal: 2964, protein_g: 226, fat_g: 100, carbs_g: 380, fiber_g: 0, sodium_mg: 0 },
      macrosUserEdited: true,
    })
    const after = row({
      ...before,
      nutrientSnapshot: { ...before.nutrientSnapshot, protein_g: 175 },
      macrosUserEdited: true,
    })

    const kcalBefore = itemCalories(before)
    const kcalAfter = itemCalories(after)

    expect(kcalAfter).not.toBe(kcalBefore)
    // 51 g of protein removed x 4 kcal/g = 204 kcal.
    expect(kcalBefore - kcalAfter).toBeCloseTo(204, 6)
  })

  it('cannot store calories independently of the rows — there is no such field', () => {
    // The absence of a settable total is the actual fix. recomputeTotals derives
    // everything; a stale total has nowhere to live.
    const m = meal([row({ grams: 200 })])
    expect(recomputeTotals(m).kcal).toBeCloseTo(330, 6)
    expect(recomputeTotals({ ...m, ingredients: [row({ grams: 100 })] }).kcal).toBeCloseTo(165, 6)
  })
})

describe('recomputeTotals', () => {
  it('scales per-100g values by grams', () => {
    const t = recomputeTotals(meal([row({ grams: 250 })]))
    expect(t.kcal).toBeCloseTo(412.5, 6)
    expect(t.protein_g).toBeCloseTo(77.5, 6)
  })

  it('applies portionEatenFraction last, to the summed total', () => {
    const t = recomputeTotals(meal([row({ grams: 200 }), row({ id: 'r2', grams: 100 })], 0.5))
    // (330 + 165) * 0.5
    expect(t.kcal).toBeCloseTo(247.5, 6)
  })

  it('treats a null micronutrient as contributing zero to a sum, not as zero content', () => {
    const withNull = row({
      grams: 100,
      nutrientSnapshot: { kcal: 100, protein_g: 5, fat_g: 2, carbs_g: 10, fiber_g: null, sodium_mg: null },
    })
    const t = recomputeTotals(meal([withNull]))
    expect(t.fiber_g).toBe(0)
    expect(t.sodium_mg).toBe(0)
    // The row itself still records "not reported", which is what the UI renders.
    expect(withNull.nutrientSnapshot.fiber_g).toBeNull()
  })
})

describe('calorie basis disclosure', () => {
  it('uses the database value for an untouched resolved row', () => {
    const r = row({ grams: 100 })
    expect(calorieBasisFor(r)).toBe('database')
    // 165, the lab value — not 4*31 + 4*0 + 9*3.6 = 156.4.
    expect(itemCalories(r)).toBeCloseTo(165, 6)
  })

  it('switches to Atwater the moment a macro is edited', () => {
    const r = row({ grams: 100, macrosUserEdited: true })
    expect(calorieBasisFor(r)).toBe('recomputed')
    expect(itemCalories(r)).toBeCloseTo(156.4, 6)
  })
})

describe('toDisplayTotalsForMeal — basis-aware meal display (issue #28)', () => {
  // Repro: a manual entry of 150 kcal with macros left at 0 (the app tells the
  // user "only a name and calories are required") displayed 0 kcal on the
  // result screen while dayTotals — which sums stored kcal directly — deducted
  // the real 150. toDisplayTotals(recomputeTotals(meal)) always reconciles
  // display kcal from Atwater over the ALREADY-ROUNDED macros, discarding a
  // row's own trusted stored kcal even when nothing was edited.
  it('shows the typed kcal for a calories-only manual entry, matching what dayTotals deducts', () => {
    const manualRow = row({
      origin: 'manual_custom',
      sourceFoodId: null,
      grams: 60,
      nutrientSnapshot: { kcal: 250, protein_g: 0, fat_g: 0, carbs_g: 0, fiber_g: null, sugar_g: null, sodium_mg: null },
      bandHalfPct: 0,
    })
    const m = meal([manualRow])

    // Old behaviour (documented here, not asserted): toDisplayTotals would
    // reconcile from the rounded 0/0/0 macros and show 0 kcal.
    expect(toDisplayTotals(recomputeTotals(m)).kcal).toBe(0)

    // The fix: meal display kcal matches the row's basis-aware total, which
    // dayTotals (SUM of snap_energy_kcal * grams / 100) also uses.
    const displayed = toDisplayTotalsForMeal(m)
    const deducted = m.ingredients.reduce((s, r) => s + (r.nutrientSnapshot.kcal * r.grams) / 100, 0)
    expect(displayed.kcal).toBeCloseTo(deducted, 6)
    expect(displayed.kcal).toBe(150)
  })

  it('leaves an untouched db_search row on the Atwater-reconciled figure — pipeline tests mandate it', () => {
    // Same basis ('database', via calorieBasisFor) and the same display-vs-
    // deduction split is visible on the DB-search flow too (issue #28's repro:
    // 221 displayed vs 224 deducted). But unlike manual_custom, db_search is
    // NOT switched to verbatim stored kcal here: pipeline.e2e.test.ts ("shows
    // displayed calories that are reproducible from the displayed macros")
    // and pipeline.corpus.test.ts ("keeps displayed calories reproducible
    // from displayed macros across many real foods") pin the Atwater figure
    // as REQUIRED for resolved database rows — a documented §6.3 mandate for
    // that row class, per the controller ruling this fix follows.
    const dbRow = row({
      grams: 150,
      nutrientSnapshot: { kcal: 224, protein_g: 13, fat_g: 13, carbs_g: 13, fiber_g: 0, sugar_g: 0, sodium_mg: 0 },
    })
    const m = meal([dbRow])
    expect(toDisplayTotalsForMeal(m)).toEqual(toDisplayTotals(recomputeTotals(m)))
  })

  it('still reconciles from macros for a row the user has edited', () => {
    const edited = row({
      grams: 100,
      nutrientSnapshot: { kcal: 2964, protein_g: 175, fat_g: 100, carbs_g: 380, fiber_g: 0, sodium_mg: 0 },
      macrosUserEdited: true,
    })
    const m = meal([edited])
    // Atwater: 175*4 + 380*4 + 100*9 = 700 + 1520 + 900 = 3120.
    expect(toDisplayTotalsForMeal(m).kcal).toBe(3120)
  })

  it('mixes: a manual_custom row contributes its own kcal, a db_search row keeps Atwater', () => {
    const manualRow = row({
      id: 'r1',
      origin: 'manual_custom',
      sourceFoodId: null,
      grams: 60,
      nutrientSnapshot: { kcal: 250, protein_g: 0, fat_g: 0, carbs_g: 0, fiber_g: null, sugar_g: null, sodium_mg: null },
      bandHalfPct: 0,
    })
    const dbRow = row({
      id: 'r2',
      grams: 150,
      nutrientSnapshot: { kcal: 224, protein_g: 13, fat_g: 13, carbs_g: 13, fiber_g: 0, sugar_g: 0, sodium_mg: 0 },
    })
    const m = meal([manualRow, dbRow])
    const dbOnlyAtwater = toDisplayTotals(recomputeTotals({ ...m, ingredients: [dbRow] })).kcal
    // manual row's raw kcal (150) plus the db row's Atwater-reconciled kcal.
    expect(toDisplayTotalsForMeal(m).kcal).toBe(150 + dbOnlyAtwater)
  })

  it('scales the basis-aware kcal by portionEatenFraction', () => {
    const manualRow = row({
      origin: 'manual_custom',
      sourceFoodId: null,
      grams: 60,
      nutrientSnapshot: { kcal: 250, protein_g: 0, fat_g: 0, carbs_g: 0, fiber_g: null, sugar_g: null, sodium_mg: null },
      bandHalfPct: 0,
    })
    const m = meal([manualRow], 0.5)
    expect(toDisplayTotalsForMeal(m).kcal).toBe(75)
  })
})

describe('display rounding — Regime B', () => {
  it('reproduces the spec worked example, resolving a contradiction inside it', () => {
    // Three items summing to 480.9 kcal / 52.69 P / 6.19 F / 50.0 C.
    //
    // docs/inherited-design.md I §6.3 contradicts itself here. The stated rule is
    // "one decimal for grams under 10 g; whole grams at 10 g and above", which
    // makes 6.19 g of fat display as 6.2. But the worked example immediately
    // below it shows that same 6.19 rounding to 6 — the whole-gram rule — and
    // therefore reports 466 kcal.
    //
    // We follow the STATED RULE, not the example, for two reasons: it preserves
    // real information (6.2 g of fat is a materially different number from 6 g
    // when the daily target is ~60 g), and the property that actually matters is
    // unaffected — displayed calories are computed FROM the displayed macros
    // either way, so the user can still hand-multiply and get the shown figure.
    //
    // Under the stated rule: round(4*53 + 4*50 + 9*6.2) = round(467.8) = 468.
    const d = toDisplayTotals({
      kcal: 480.9,
      protein_g: 52.69,
      fat_g: 6.19,
      carbs_g: 50.0,
      fiber_g: 4.2,
      sugar_g: 0,
      sodium_mg: 611.4,
    })
    expect(d.protein_g).toBe(53)
    expect(d.fat_g).toBe(6.2)
    expect(d.carbs_g).toBe(50)
    expect(d.kcal).toBe(468)
    // The invariant the example was really demonstrating still holds exactly.
    expect(d.kcal).toBe(Math.round(4 * d.protein_g + 4 * d.carbs_g + 9 * d.fat_g))
  })

  it('keeps one decimal below 10 g and whole grams at or above 10 g', () => {
    expect(roundDisplayGrams(6.19)).toBe(6.2)
    expect(roundDisplayGrams(9.94)).toBe(9.9)
    expect(roundDisplayGrams(10.4)).toBe(10)
    expect(roundDisplayGrams(52.69)).toBe(53)
  })
})

describe('display rounding — Regime A (21 CFR 101.9(c))', () => {
  it('rounds calories to 5 up to 50 and to 10 above 50', () => {
    expect(labelRounding.calories(3)).toBe(0)
    expect(labelRounding.calories(23)).toBe(25)
    expect(labelRounding.calories(50)).toBe(50)
    expect(labelRounding.calories(137)).toBe(140)
  })

  it('rounds fat to half grams below 5 g and whole grams above', () => {
    expect(labelRounding.fat(0.3)).toBe(0)
    expect(labelRounding.fat(2.3)).toBe(2.5)
    expect(labelRounding.fat(7.4)).toBe(7)
  })

  it('applies the three sodium tiers', () => {
    expect(labelRounding.sodium(3)).toBe(0)
    expect(labelRounding.sodium(63)).toBe(65)
    expect(labelRounding.sodium(287)).toBe(290)
  })

  it('distinguishes zero from a declarable trace amount', () => {
    expect(labelRounding.gramNutrient(0.3)).toBe(0)
    expect(labelRounding.isTrace(0.3)).toBe(false)
    expect(labelRounding.isTrace(0.7)).toBe(true)
  })

  it('applies the three %DV tiers', () => {
    expect(labelRounding.percentDV(7)).toBe(8)
    expect(labelRounding.percentDV(33)).toBe(35)
    expect(labelRounding.percentDV(76)).toBe(80)
  })

  it('does not compose additively — which is why sums must use Regime B', () => {
    // Three real fat values. Rounding each to the label then summing gives a
    // different answer from rounding the true sum once. This test documents the
    // hazard rather than guarding against it: it is why the two regimes exist.
    const fats = [2.3, 2.3, 2.3]
    const sumOfRounded = fats.reduce((a, g) => a + labelRounding.fat(g), 0)
    const roundedSum = labelRounding.fat(fats.reduce((a, g) => a + g, 0))
    expect(sumOfRounded).toBe(7.5)
    expect(roundedSum).toBe(7)
    expect(sumOfRounded).not.toBe(roundedSum)
  })
})

describe('reconcileFromMacros', () => {
  it('is Atwater 4/4/9', () => {
    expect(reconcileFromMacros(31, 0, 3.6)).toBeCloseTo(156.4, 6)
  })
})
