import { gzipSync } from 'node:zlib'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ingestOff, loadSchema, openFullDb, readCheckpoint } from './build-full.mjs'

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
})
