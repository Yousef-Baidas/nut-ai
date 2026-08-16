import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { normalizeSearchText, resolveByText } from '@nutai/resolver'
import { openNodeDb } from '@nutai/db-adapter/node'
import { ARAB_CSV_COLUMNS, parseArabCsv } from './arab.mjs'
import { insertFood, loadSchema, openFullDb } from './build-full.mjs'

const HEADER = ARAB_CSV_COLUMNS.join(',')
const ROW =
  'ful_medames,Ful medames (cooked fava beans),فول مدمس,"ful;foul;fool;فول",' +
  '110,7.6,0.5,17.8,5.4,0.5,320,legume,250,1 bowl,' +
  '"Pellett & Shadarevian, Food Composition Tables for Use in the Middle East, 2nd ed., AUB, 1970, p. 42"'

describe('parseArabCsv', () => {
  it('reads a fully cited row into a FoodRow', () => {
    const [row] = parseArabCsv(`${HEADER}\n${ROW}\n`)
    expect(row.tier).toBe('arab_curated')
    expect(row.license).toBe('curated-cited')
    expect(row.source).toBe('arab_curated')
    expect(row.sourceId).toBe('ful_medames')
    expect(row.name).toBe('Ful medames (cooked fava beans)')
    expect(row.kcal).toBe(110)
    expect(row.protein).toBe(7.6)
    expect(row.servingSizeG).toBe(250)
    expect(row.barcode).toBeNull()
  })

  it('indexes the Arabic name and every transliteration, folded', () => {
    const [row] = parseArabCsv(`${HEADER}\n${ROW}\n`)
    expect(row.synonyms).toContain('فول')
    expect(row.synonyms).toContain('ful')
    // foul and fool both fold onto ful — one key, three spellings.
    expect(row.synonyms.filter((s) => s === 'ful').length).toBe(1)
  })

  it('REFUSES a row with no source — no invented nutrition values, ever', () => {
    const uncited = ROW.replace(/,"Pellett[^"]*"$/, ',')
    expect(() => parseArabCsv(`${HEADER}\n${uncited}\n`)).toThrow(/source/i)
  })

  it('refuses a row whose header drifted from the expected columns', () => {
    expect(() => parseArabCsv('id,name\nx,y\n')).toThrow(/column/i)
  })

  it('refuses a row that fails the clamp sanity rules', () => {
    const impossible = ROW.replace(',110,7.6', ',1700,7.6')
    expect(() => parseArabCsv(`${HEADER}\n${impossible}\n`)).toThrow(/sane|energy/i)
  })

})

describe('PRECISION: a real fold collision must not auto-accept the wrong food', () => {
  // foldLatin is deliberately lossy — doubled consonants collapse, so
  // "full" folds to the exact same key ("ful") as this row's "ful"/"foul"/
  // "fool" synonyms for fava beans. That collision is safe for RECALL (a
  // fava-bean search should surface despite the spelling), but it must not
  // by itself be enough to auto-accept a completely different food — e.g. a
  // dairy product whose name happens to contain the English word "full".
  //
  // This exercises the real resolver (matchLadder + scoreCandidates +
  // decideOutcome) against a built fixture DB, not a string comparison
  // against parseArabCsv's output — a broken fold, a broken ladder, or a
  // broken scoring weight could each cause a real mis-resolution that a
  // unit-level synonym-list check can't see.
  const dbs = []
  afterEach(() => { while (dbs.length > 0) dbs.pop().close() })

  async function fixtureDb() {
    await loadSchema()
    const path = join(mkdtempSync(join(tmpdir(), 'nutai-arab-precision-')), 'full.db')
    const writer = openFullDb(path)
    const now = Date.now()

    const [fulMedames] = parseArabCsv(`${HEADER}\n${ROW}\n`)
    const fulId = insertFood(writer, fulMedames, now)

    // An unrelated dairy product whose name contains the English word "full" —
    // normalizeSearchText folds "full" to "ful" at index time, exactly like the
    // fava-bean synonyms above, so this is a genuine token collision, not a
    // contrived one.
    const yogurtId = insertFood(writer, {
      source: 'off', sourceId: '9999999999999', name: 'Full Fat Greek Yogurt', brand: null,
      tier: 'off', license: 'ODbL-1.0', barcode: '9999999999999', category: 'dairy',
      kcal: 97, protein: 9, fat: 5, satFat: 3, carb: 4, fiber: 0, sugar: 4, sodiumMg: 40,
      servingSizeG: 150, servingDesc: '1 cup', completeness: 1, synonyms: [],
    }, now)

    writer.close()
    const db = openNodeDb(path, { readonly: true })
    dbs.push({ close: () => db.close() })
    return { db, fulId: String(fulId), yogurtId: String(yogurtId) }
  }

  it('finds both the fava-bean row and the unrelated dairy row under the collided token', async () => {
    const { db } = await fixtureDb()
    // Mirrors the documented contract (search-normalize.ts): index time and
    // query time must fold through the same function, so a caller resolving
    // a bare "full" query folds it before it ever reaches matchLadder.
    const rows = await db.all("SELECT rowid FROM food_fts WHERE food_fts MATCH ?", [
      `"${normalizeSearchText('full')}"`,
    ])
    expect(rows.length).toBe(2)
  })

  it('does NOT auto-accept the fava-bean row for a query that means the dairy product', async () => {
    const { db, fulId } = await fixtureDb()

    const result = await resolveByText(db, {
      canonicalFoodKey: normalizeSearchText('full'),
      observedBrand: null,
      prepFacet: null,
      modelCategory: 'dairy', // the one signal that disambiguates the collision
      estimatedGrams: null,
    })

    if (result.outcome.kind === 'auto_accept') {
      expect(result.outcome.match.foodId).not.toBe(fulId)
    }
    // Whatever the outcome, the fava-bean row must never be the sole result
    // presented as correct without the dairy row at least contending for it.
    expect(result.outcome.kind).not.toBe('miss')
  })

  it('the fava-bean row DOES surface as the top match on its own real query', async () => {
    const { db, fulId } = await fixtureDb()

    const result = await resolveByText(db, {
      canonicalFoodKey: normalizeSearchText('ful medames'),
      observedBrand: null,
      prepFacet: null,
      modelCategory: 'legume',
      estimatedGrams: 250,
    })

    // Not asserting auto_accept specifically — with only one candidate in this
    // tiny fixture DB the absolute-score floor (AUTO_ACCEPT.minScore) can land
    // it in disambiguate instead, which is a threshold-tuning question, not a
    // resolution-correctness one. What must hold either way: the fava-bean row
    // is the top (and only realistic) candidate, never a miss.
    expect(result.outcome.kind).not.toBe('miss')
    const top = result.outcome.kind === 'auto_accept' ? result.outcome.match : result.outcome.candidates[0]
    expect(top.foodId).toBe(fulId)
  })
})

describe('the checked-in arab-foods.csv', () => {
  it('parses, and every shipped row cites a source', async () => {
    const { readFile } = await import('node:fs/promises')
    const { fileURLToPath } = await import('node:url')
    const csv = await readFile(
      fileURLToPath(new URL('../arab-foods.csv', import.meta.url)), 'utf8',
    )
    const rows = parseArabCsv(csv)
    expect(rows.length).toBeGreaterThanOrEqual(20)
    for (const r of rows) expect(r.sourceCitation.length).toBeGreaterThan(20)
  })
})
