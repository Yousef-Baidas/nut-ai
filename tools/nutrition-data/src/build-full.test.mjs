import { gzipSync } from 'node:zlib'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  backfillPortions,
  ingestOff,
  insertFood,
  loadSchema,
  openFullDb,
  readCheckpoint,
  writeManifestSummary,
} from './build-full.mjs'

const LINES = [
  { code: '6281006012011', product_name: 'Almarai Fresh Laban', brands: 'Almarai',
    nutriments: { 'energy-kcal_100g': 40, proteins_100g: 3.2, fat_100g: 1.5, carbohydrates_100g: 4.6 } },
  { code: '5000112637922', product_name: 'Cola Zero', brands: 'Coca-Cola',
    nutriments: { 'energy-kcal_100g': 0.3, proteins_100g: 0, fat_100g: 0, carbohydrates_100g: 0 } },
  // Impossible density — must be filtered out, not imported.
  { code: '1111111111111', product_name: 'Broken kJ row', brands: 'X',
    nutriments: { 'energy-kcal_100g': 1700, proteins_100g: 5, fat_100g: 5, carbohydrates_100g: 5 } },
  // No fat figure — dropped rather than zero-filled.
  { code: '2222222222222', product_name: 'Incomplete', brands: 'Y',
    nutriments: { 'energy-kcal_100g': 100, proteins_100g: 5, carbohydrates_100g: 5 } },
]

const dbs = []
async function fixture() {
  await loadSchema()
  const dir = mkdtempSync(join(tmpdir(), 'nutai-off-'))
  const gz = join(dir, 'off.jsonl.gz')
  writeFileSync(gz, gzipSync(LINES.map((l) => JSON.stringify(l)).join('\n') + '\n'))
  const db = openFullDb(join(dir, 'full.db'))
  dbs.push(db)
  return { gz, db }
}

afterEach(() => { while (dbs.length > 0) dbs.pop().close() })

describe('ingestOff', () => {
  it('imports only the sane, complete rows', async () => {
    const { gz, db } = await fixture()
    const stats = await ingestOff({ db, jsonlGzPath: gz })

    expect(stats.read).toBe(4)
    expect(stats.inserted).toBe(2)
    expect(stats.rejected).toBe(2)
    expect(db.prepare('SELECT COUNT(*) c FROM foods').get().c).toBe(2)
    expect(db.prepare("SELECT COUNT(*) c FROM foods WHERE tier = 'off'").get().c).toBe(2)
    expect(db.prepare('SELECT COUNT(*) c FROM foods WHERE barcode IS NOT NULL').get().c).toBe(2)
  })

  it('indexes every imported row for FTS search', async () => {
    const { gz, db } = await fixture()
    await ingestOff({ db, jsonlGzPath: gz })
    const hits = db.prepare("SELECT rowid FROM food_fts WHERE food_fts MATCH '\"laban\"'").all()
    expect(hits.length).toBe(1)
  })

  it('is idempotent — a second run inserts nothing new', async () => {
    const { gz, db } = await fixture()
    await ingestOff({ db, jsonlGzPath: gz })
    const again = await ingestOff({ db, jsonlGzPath: gz, resume: false })
    expect(again.inserted).toBe(0)
    expect(db.prepare('SELECT COUNT(*) c FROM foods').get().c).toBe(2)
  })

  it('records a checkpoint and resumes from it', async () => {
    const { gz, db } = await fixture()
    await ingestOff({ db, jsonlGzPath: gz })
    expect(Number(readCheckpoint(db, 'off.line'))).toBe(4)

    const resumed = await ingestOff({ db, jsonlGzPath: gz })
    expect(resumed.read).toBe(0)
    expect(resumed.skipped).toBe(4)
  })

  it('does not drop a line when a limited run is resumed (limit/checkpoint off-by-one)', async () => {
    const { gz, db } = await fixture()
    // Line 1 (Almarai) is sane and gets inserted; the limit stops right there.
    const first = await ingestOff({ db, jsonlGzPath: gz, limit: 1 })
    expect(first.read).toBe(1)
    expect(first.inserted).toBe(1)
    // The bug incremented the line counter for the NEXT (unread) line before
    // checking the limit, so the checkpoint recorded 2 instead of 1 and line 2
    // (Cola Zero, also sane) was silently skipped on resume.
    expect(Number(readCheckpoint(db, 'off.line'))).toBe(1)

    const second = await ingestOff({ db, jsonlGzPath: gz })
    expect(second.read).toBe(3)
    expect(second.skipped).toBe(1)
    expect(db.prepare('SELECT COUNT(*) c FROM foods').get().c).toBe(2)
    expect(db.prepare("SELECT name FROM foods WHERE barcode = '5000112637922'").get().name).toBe('Cola Zero')
  })

  it('reports INSERT OR IGNORE collisions as ignored, not rejected, so read == inserted+rejected+ignored', async () => {
    const { gz, db } = await fixture()
    await ingestOff({ db, jsonlGzPath: gz })
    const again = await ingestOff({ db, jsonlGzPath: gz, resume: false })
    expect(again.read).toBe(4)
    expect(again.inserted).toBe(0)
    expect(again.ignored).toBe(2)
    expect(again.rejected).toBe(2)
    expect(again.read).toBe(again.inserted + again.rejected + again.ignored)
  })

  it('resets the checkpoint when the dump file is a different export (size/mtime changed)', async () => {
    const { gz, db } = await fixture()
    await ingestOff({ db, jsonlGzPath: gz, limit: 1 })
    expect(Number(readCheckpoint(db, 'off.line'))).toBe(1)

    // Simulate a newer weekly OFF dump landing at the same path: different
    // bytes, so a different size (and, on any real filesystem, a different
    // mtime) — this must NOT resume from the stale line-1 checkpoint.
    const newerLines = [
      ...LINES,
      { code: '3333333333333', product_name: 'New Product', brands: 'Z',
        nutriments: { 'energy-kcal_100g': 50, proteins_100g: 5, fat_100g: 5, carbohydrates_100g: 5 } },
    ]
    writeFileSync(gz, gzipSync(newerLines.map((l) => JSON.stringify(l)).join('\n') + '\n'))

    const resumed = await ingestOff({ db, jsonlGzPath: gz })
    expect(resumed.read).toBe(newerLines.length)
    expect(resumed.skipped).toBe(0)
  })

  it('writes the brand via brand_id so a barcode hit resolves to it', async () => {
    const { gz, db } = await fixture()
    await ingestOff({ db, jsonlGzPath: gz })
    const row = db
      .prepare(
        `SELECT b.canonical_name AS brand FROM foods f
         JOIN brands b ON b.id = f.brand_id
         WHERE f.barcode = ?`,
      )
      .get('6281006012011')
    expect(row.brand).toBe('Almarai')
  })
})

describe('writeManifestSummary', () => {
  it('writes per-tier row counts and the branded-dedup count into build_manifest, not just stdout', async () => {
    const { gz, db } = await fixture()
    await ingestOff({ db, jsonlGzPath: gz }) // 2 off rows (see LINES fixture above)

    const now = Date.now()
    insertFood(db, {
      source: 'arab_curated', sourceId: 'ful_medames', name: 'Ful medames', brand: null,
      tier: 'arab_curated', license: 'curated-cited', barcode: null, category: 'legume',
      kcal: 110, protein: 7.6, fat: 0.5, satFat: null, carb: 17.8, fiber: 5.4, sugar: 0.5,
      sodiumMg: 320, servingSizeG: 250, servingDesc: '1 bowl', completeness: 1, synonyms: ['ful'],
    }, now)

    writeManifestSummary(db, { branded: { dedupedToOff: 3 } })

    expect(Number(readCheckpoint(db, 'counts.off'))).toBe(2)
    expect(Number(readCheckpoint(db, 'counts.arab_curated'))).toBe(1)
    expect(readCheckpoint(db, 'counts.fdc_branded')).toBeNull() // none ingested in this fixture
    expect(Number(readCheckpoint(db, 'dedup.branded_lost_to_off'))).toBe(3)
  })

  it('writes portion_count and barcode_count so /health need not COUNT(*) per request', async () => {
    const { gz, db } = await fixture()
    await ingestOff({ db, jsonlGzPath: gz }) // 2 off rows, both carry a barcode

    insertFood(db, {
      source: 'arab_curated', sourceId: 'ful_medames', name: 'Ful medames', brand: null,
      tier: 'arab_curated', license: 'curated-cited', barcode: null, category: 'legume',
      kcal: 110, protein: 7.6, fat: 0.5, satFat: null, carb: 17.8, fiber: 5.4, sugar: 0.5,
      sodiumMg: 320, servingSizeG: 250, servingDesc: '1 bowl', completeness: 1, synonyms: ['ful'],
    }, Date.now())

    backfillPortions(db)
    writeManifestSummary(db, { branded: { dedupedToOff: 0 } })

    expect(Number(readCheckpoint(db, 'portion_count'))).toBe(1) // only the arab row has a serving_size_g
    expect(Number(readCheckpoint(db, 'barcode_count'))).toBe(2) // the two off rows
  })
})

describe('backfillPortions', () => {
  it('derives one serving portion per food with a serving_size_g, and none for foods without one', async () => {
    const { db } = await fixture()
    const now = Date.now()
    insertFood(db, {
      source: 'off', sourceId: 'p1', name: 'Yogurt Cup', brand: null, tier: 'off',
      license: 'ODbL-1.0', barcode: '1234567890123', category: 'dairy',
      kcal: 90, protein: 5, fat: 3, satFat: null, carb: 8, fiber: 0, sugar: 8,
      sodiumMg: 60, servingSizeG: 150, servingDesc: '1 cup', completeness: 1, synonyms: [],
    }, now)
    insertFood(db, {
      source: 'off', sourceId: 'p2', name: 'No Serving Size', brand: null, tier: 'off',
      license: 'ODbL-1.0', barcode: '9999999999999', category: 'dairy',
      kcal: 50, protein: 1, fat: 1, satFat: null, carb: 5, fiber: 0, sugar: 2,
      sodiumMg: 10, servingSizeG: null, servingDesc: null, completeness: 1, synonyms: [],
    }, now)

    const inserted = backfillPortions(db)
    expect(inserted).toBe(1)

    const rows = db.prepare('SELECT food_id, measure_unit, modifier, gram_weight FROM food_portions').all()
    expect(rows).toHaveLength(1)
    expect(rows[0].measure_unit).toBe('serving')
    expect(rows[0].modifier).toBe('1 cup')
    expect(rows[0].gram_weight).toBe(150)
  })

  it('is idempotent: re-running does not duplicate rows', async () => {
    const { db } = await fixture()
    insertFood(db, {
      source: 'off', sourceId: 'p1', name: 'Yogurt Cup', brand: null, tier: 'off',
      license: 'ODbL-1.0', barcode: '1234567890123', category: 'dairy',
      kcal: 90, protein: 5, fat: 3, satFat: null, carb: 8, fiber: 0, sugar: 8,
      sodiumMg: 60, servingSizeG: 150, servingDesc: '1 cup', completeness: 1, synonyms: [],
    }, Date.now())

    backfillPortions(db)
    backfillPortions(db)

    const count = db.prepare('SELECT COUNT(*) c FROM food_portions').get().c
    expect(count).toBe(1)
  })
})
