import { describe, expect, it } from 'vitest'
import { normalizeSearchText } from '@nutai/resolver'
import { ARAB_CSV_COLUMNS, parseArabCsv } from './arab.mjs'

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

  it('PRECISION: an unrelated query, folded the same way the corpus was, must not hit this row', () => {
    // foldLatin is deliberately lossy (ou/oo -> u, ee -> i, doubled consonants
    // collapse) — safe for recall, but this row's indexed synonyms must not
    // coincidentally equal the folded form of a genuinely unrelated dish's name.
    const [row] = parseArabCsv(`${HEADER}\n${ROW}\n`)
    const unrelated = normalizeSearchText('kunafa') // a syrup dessert, not a legume
    expect(row.synonyms).not.toContain(unrelated)
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
