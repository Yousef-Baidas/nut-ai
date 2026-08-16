import { beforeEach, describe, expect, it } from 'vitest'
import { NUTRITION_FTS_SCHEMA, NUTRITION_SCHEMA, type DbAdapter } from '@nutai/db-adapter'
import { openMemoryDb } from '@nutai/db-adapter/node'
import {
  AUTO_ACCEPT,
  decideOutcome,
  gs1CheckDigit,
  isValidGtin,
  matchLadder,
  normalizeBm25,
  normalizeGtin,
  normalizeSearchText,
  prepMatch,
  resolveByBarcode,
  resolveByText,
  scoreCandidates,
  toMatchExpression,
  toTrigramExpression,
  upcEToUpcA,
  type Candidate,
  type ScoringContext,
} from './index.js'

// ---------------------------------------------------------------------------
// GTIN normalization
// ---------------------------------------------------------------------------

describe('GTIN normalization', () => {
  it('resolves a UPC-A and its EAN-13 equivalent to the same canonical form', () => {
    // A UPC-A is an EAN-13 with a leading zero.
    const upcA = '012345678905'
    const ean13 = '0012345678905'
    expect(normalizeGtin(upcA)).toBe(normalizeGtin(ean13))
    expect(normalizeGtin(upcA)).toHaveLength(13)
  })

  it('computes GS1 mod-10 check digits', () => {
    expect(gs1CheckDigit('01234567890')).toBe(5)
    expect(isValidGtin('012345678905')).toBe(true)
    expect(isValidGtin('012345678901')).toBe(false)
  })

  it('expands UPC-E to UPC-A', () => {
    const upce = '01234565'
    const expanded = upcEToUpcA(upce)
    expect(expanded).not.toBeNull()
    expect(expanded).toHaveLength(12)
  })

  it('rejects nonsense rather than guessing', () => {
    expect(normalizeGtin('hello')).toBeNull()
    expect(normalizeGtin('')).toBeNull()
    expect(normalizeGtin('123')).toBeNull()
  })

  it('strips a GTIN-14 packaging indicator when the inner 13 validates', () => {
    const inner = normalizeGtin('012345678905')!
    expect(normalizeGtin(`1${inner}`)).toBe(inner)
  })
})

// ---------------------------------------------------------------------------
// Query construction
// ---------------------------------------------------------------------------

describe('FTS query construction', () => {
  it('quotes every token so operators cannot leak in from food names', () => {
    expect(toMatchExpression('chicken OR breast')).toBe('"chicken" "or" "breast"')
    expect(toMatchExpression('chicken - breast')).toBe('"chicken" "breast"')
  })

  it('splits on commas, matching USDA naming', () => {
    // "grilled" folds its doubled consonant (ll -> l) now that toMatchExpression
    // runs the same normalizeSearchText fold the index is built with (C1/C2) —
    // this is the real, honest output, not raw-index behavior.
    expect(toMatchExpression('chicken breast, grilled')).toBe('"chicken" "breast" "griled"')
  })

  it('returns null for an empty query rather than a matcher that errors', () => {
    expect(toMatchExpression('   ')).toBeNull()
    expect(toMatchExpression('***')).toBeNull()
  })

  it('builds a ladder that drops trailing modifiers before the head noun', () => {
    // Same fold as toMatchExpression, applied inside matchLadder itself — the
    // single choke point (C1/C2).
    const ladder = matchLadder('chicken breast, grilled')
    expect(ladder[0]).toBe('"chicken" "breast" "griled"')
    expect(ladder[1]).toBe('"chicken" "breast"')
    expect(ladder[2]).toBe('"chicken"')
    expect(ladder.at(-1)).toContain('OR')
  })
})

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function cand(over: Partial<Candidate> = {}): Candidate {
  return {
    foodId: 'f1',
    name: 'Chicken breast, grilled',
    brand: null,
    category: 'poultry',
    prepFacet: 'grilled',
    basisConfidence: 'high',
    servingSizeG: 85,
    energyKcal: 165,
    popularityRank: 10,
    completenessScore: 0.9,
    rawBm25: -5,
    ...over,
  }
}

const ctx: ScoringContext = {
  canonicalFoodKey: 'chicken breast, grilled',
  observedBrand: null,
  prepFacet: 'grilled',
  modelCategory: 'poultry',
  estimatedGrams: 170,
}

describe('trigram query construction (issue #11)', () => {
  it('emits OR-of-trigrams so a typo still shares grams with the real name', () => {
    // 'chiken' and the indexed 'chicken' share "chi" and "ken" — the OR query
    // is what lets bm25 rank by shared-trigram count. A single quoted phrase
    // would demand the typo appear verbatim in the corpus, which it never does.
    expect(toTrigramExpression('chiken')).toBe('"chi" OR "hik" OR "ike" OR "ken"')
  })

  it('folds the query the same way the trigram index was built', () => {
    // Both build scripts insert normalizeSearchText(name) into food_fts_trigram,
    // so an unfolded query would compare raw trigrams against folded ones.
    // 'BREEST' folds to 'brist'.
    expect(toTrigramExpression('BREEST')).toBe('"bri" OR "ris" OR "ist"')
  })

  it('dedupes repeated trigrams across tokens', () => {
    // Two identical tokens contribute one set of grams, not two.
    expect(toTrigramExpression('banana banana')).toBe('"ban" OR "ana" OR "nan"')
  })

  it('returns null when nothing reaches three characters', () => {
    expect(toTrigramExpression('ab')).toBeNull()
    expect(toTrigramExpression('***')).toBeNull()
    expect(toTrigramExpression('')).toBeNull()
  })
})

describe('scoring', () => {
  it('treats an untagged prep facet as unknown, not as a conflict', () => {
    expect(prepMatch(cand({ prepFacet: null }), ctx)).toBe(0.5)
    expect(prepMatch(cand({ prepFacet: 'grilled' }), ctx)).toBe(1)
    expect(prepMatch(cand({ prepFacet: 'raw' }), ctx)).toBe(0)
  })

  it('does not hand a lone candidate a free perfect relevance score', () => {
    const norm = normalizeBm25([cand()])
    expect(norm.get('f1')).toBe(0.5)
  })

  it('ranks an exact brand match above a generic row', () => {
    const scored = scoreCandidates(
      [
        cand({ foodId: 'generic', brand: null, rawBm25: -5 }),
        cand({ foodId: 'branded', brand: 'Perdue', rawBm25: -5 }),
      ],
      { ...ctx, observedBrand: 'Perdue' },
    )
    expect(scored[0]?.foodId).toBe('branded')
  })

  it('penalizes a row whose typical portion is nowhere near the estimate', () => {
    const scored = scoreCandidates(
      [
        cand({ foodId: 'cube', servingSizeG: 4, typicalGramsMin: 2, typicalGramsMax: 6 }),
        cand({ foodId: 'breast', servingSizeG: 85, typicalGramsMin: 60, typicalGramsMax: 250 }),
      ],
      ctx,
    )
    expect(scored[0]?.foodId).toBe('breast')
  })

  it('penalizes an incomplete row for untrustworthy unit math', () => {
    const good = scoreCandidates([cand({ foodId: 'a' })], ctx)[0]!
    const bad = scoreCandidates(
      [cand({ foodId: 'b', basisConfidence: 'low', completenessScore: 0.2 })],
      ctx,
    )[0]!
    expect(bad.score).toBeLessThan(good.score)
  })
})

describe('the two-part auto-accept rule', () => {
  const strong = { ...cand({ foodId: 'top' }), score: 0.8, breakdown: {} }
  const near = { ...cand({ foodId: 'near' }), score: 0.75, breakdown: {} }
  const weak = { ...cand({ foodId: 'weak' }), score: 0.4, breakdown: {} }

  it('auto-accepts a strong, clearly-separated top match', () => {
    const out = decideOutcome([strong, weak])
    expect(out.kind).toBe('auto_accept')
  })

  it('refuses to auto-accept a great score beside a near-duplicate', () => {
    // Two branded SKUs of the same product at different pack sizes. Both clear
    // the absolute floor; the user should glance at it.
    const out = decideOutcome([strong, near])
    expect(out.kind).toBe('disambiguate')
  })

  it('refuses to auto-accept a mediocre top score just because nothing else came close', () => {
    // A genuinely novel dish with five equally-bad candidates.
    const out = decideOutcome([{ ...weak, score: 0.45 }, { ...cand({ foodId: 'x' }), score: 0.1, breakdown: {} }])
    expect(out.kind).toBe('disambiguate')
  })

  it('reports a miss on an empty candidate set', () => {
    expect(decideOutcome([]).kind).toBe('miss')
  })

  it('caps the disambiguation sheet at five options', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      ...cand({ foodId: `f${i}` }), score: 0.5 - i * 0.001, breakdown: {},
    }))
    const out = decideOutcome(many)
    expect(out.kind).toBe('disambiguate')
    if (out.kind === 'disambiguate') expect(out.candidates).toHaveLength(5)
  })

  it('uses the documented thresholds', () => {
    expect(AUTO_ACCEPT.minScore).toBe(0.6)
    expect(AUTO_ACCEPT.minGap).toBe(0.12)
  })
})

// ---------------------------------------------------------------------------
// Against a real SQLite database
// ---------------------------------------------------------------------------

describe('resolution against a real corpus', () => {
  let db: DbAdapter

  beforeEach(async () => {
    db = openMemoryDb()
    await db.exec(NUTRITION_SCHEMA)
    await db.exec(NUTRITION_FTS_SCHEMA)

    const foods: Array<[number, string, string, string | null, number, string | null, number]> = [
      [1, 'fdc_sr_legacy', 'Chicken, broilers or fryers, breast, meat only, cooked, grilled', 'grilled', 165, null, 10],
      [2, 'fdc_sr_legacy', 'Chicken, broilers or fryers, breast, meat only, cooked, roasted', 'roasted', 172, null, 20],
      [3, 'fdc_sr_legacy', 'Rice, white, long-grain, regular, cooked', 'boiled', 130, null, 5],
      [4, 'fdc_branded', 'Granola Bar, Chewy', null, 400, '0012345678905', 100],
    ]
    for (const [id, source, name, prep, kcal, barcode, rank] of foods) {
      await db.run(
        `INSERT INTO foods (id, source, name, prep_facet, energy_kcal, barcode, popularity_rank,
                            license, basis_confidence, completeness_score)
         VALUES (?,?,?,?,?,?,?,'CC0','high',0.9)`,
        [id, source, name, prep, kcal, barcode, rank],
      )
      await db.run('INSERT INTO food_fts (rowid, name, brand, synonyms) VALUES (?,?,?,?)', [
        id, name, '', '',
      ])
      // Both build scripts populate the trigram shadow index with the FOLDED
      // name — mirror that here so the typo-fallback tests run against the
      // same shape the real corpus has.
      await db.run('INSERT INTO food_fts_trigram (rowid, name) VALUES (?,?)', [
        id, normalizeSearchText(name),
      ])
    }
  })

  it('finds a food regardless of word order', async () => {
    const r = await resolveByText(db, {
      canonicalFoodKey: 'chicken breast grilled',
      observedBrand: null, prepFacet: 'grilled', modelCategory: null, estimatedGrams: 170,
    })
    expect(r.zeroHit).toBe(false)
    const ids = r.outcome.kind === 'auto_accept'
      ? [r.outcome.match.foodId]
      : r.outcome.kind === 'disambiguate' ? r.outcome.candidates.map((c) => c.foodId) : []
    expect(ids.map(String)).toContain('1')
  })

  it('prefers the grilled row over the roasted one when the model saw grill marks', async () => {
    const r = await resolveByText(db, {
      canonicalFoodKey: 'chicken breast',
      observedBrand: null, prepFacet: 'grilled', modelCategory: null, estimatedGrams: 170,
    })
    const first = r.outcome.kind === 'auto_accept'
      ? r.outcome.match
      : r.outcome.kind === 'disambiguate' ? r.outcome.candidates[0] : null
    expect(String(first?.foodId)).toBe('1')
  })

  it('broadens down the ladder rather than giving up on one absent token', async () => {
    const r = await resolveByText(db, {
      canonicalFoodKey: 'chicken breast, sousvide',
      observedBrand: null, prepFacet: null, modelCategory: null, estimatedGrams: 170,
    })
    expect(r.zeroHit).toBe(false)
    expect(r.ladderStep).toBeGreaterThan(0)
  })

  it('rescues a typo through the trigram shadow index when every FTS rung misses (issue #11)', async () => {
    // 'chiken brest': neither token exists in the corpus, so the exact rung,
    // every drop-a-modifier rung, and the OR rung all return nothing. The
    // trigram rung shares "chi"/"ken"/"bre" with 'chicken … breast …' and
    // surfaces the real rows instead of a miss.
    const r = await resolveByText(db, {
      canonicalFoodKey: 'chiken brest',
      observedBrand: null, prepFacet: null, modelCategory: null, estimatedGrams: 170,
    })
    expect(r.zeroHit).toBe(false)
    // The rescue is recorded one step past the FTS ladder, so the zero-hit
    // instrumentation can tell "trigram saved it" from "first rung hit".
    expect(r.ladderStep).toBe(matchLadder('chiken brest').length)
    const ids = r.outcome.kind === 'auto_accept'
      ? [r.outcome.match.foodId]
      : r.outcome.kind === 'disambiguate' ? r.outcome.candidates.map((c) => c.foodId) : []
    expect(ids.map(String)).toContain('1')
  })

  it('reports an honest zero-hit for a food that is genuinely absent', async () => {
    const r = await resolveByText(db, {
      canonicalFoodKey: 'zzzzqqqx',
      observedBrand: null, prepFacet: null, modelCategory: null, estimatedGrams: 100,
    })
    expect(r.zeroHit).toBe(true)
    expect(r.outcome.kind).toBe('miss')
  })

  it('resolves a barcode deterministically, in either GTIN form', async () => {
    const byEan = await resolveByBarcode(db, '0012345678905')
    const byUpc = await resolveByBarcode(db, '012345678905')
    expect(byEan?.name).toBe('Granola Bar, Chewy')
    expect(byUpc?.foodId).toBe(byEan?.foodId)
  })

  it('returns null for an unknown barcode instead of a wrong row', async () => {
    expect(await resolveByBarcode(db, '9999999999994')).toBeNull()
  })

  it('finds a fold-sensitive food when the index was folded and the query is raw (C1/C2)', async () => {
    // "cheese" is lossy under foldLatin (ee -> i: "chise"), and "cheddar" collapses
    // its doubled consonant ("cheddar" -> "chedar"). Index it exactly the way
    // build.mjs/build-full.mjs do — via normalizeSearchText — and hand
    // resolveByText the RAW, unfolded query, the way handlePipeline does. If
    // matchLadder doesn't fold the query itself, this returns zero rows even
    // though a human would call it an exact match.
    const id = 5
    const name = 'Cheddar Cheese'
    await db.run(
      `INSERT INTO foods (id, source, name, energy_kcal, license, basis_confidence, completeness_score)
       VALUES (?,?,?,?,?,?,?)`,
      [id, 'fdc_sr_legacy', name, 403, 'CC0', 'high', 0.9],
    )
    await db.run('INSERT INTO food_fts (rowid, name, brand, synonyms) VALUES (?,?,?,?)', [
      id, normalizeSearchText(name), '', '',
    ])

    const r = await resolveByText(db, {
      canonicalFoodKey: 'cheddar cheese',
      observedBrand: null, prepFacet: null, modelCategory: null, estimatedGrams: 30,
    })
    expect(r.zeroHit).toBe(false)
    const ids = r.outcome.kind === 'auto_accept'
      ? [r.outcome.match.foodId]
      : r.outcome.kind === 'disambiguate' ? r.outcome.candidates.map((c) => c.foodId) : []
    expect(ids.map(String)).toContain(String(id))
  })

  it('never throws on a hostile query string', async () => {
    for (const q of ['"', '(((', 'a OR OR b', '*', 'NEAR/']) {
      const r = await resolveByText(db, {
        canonicalFoodKey: q, observedBrand: null, prepFacet: null, modelCategory: null, estimatedGrams: 100,
      })
      expect(r).toBeDefined()
    }
  })
})
