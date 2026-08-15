import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ingestBranded } from './branded.mjs'
import { ingestOff, insertFood, loadSchema, openFullDb } from './build-full.mjs'
import { gzipSync } from 'node:zlib'

const dbs = []
afterEach(() => { while (dbs.length > 0) dbs.pop().close() })

function brandedDir() {
  const dir = mkdtempSync(join(tmpdir(), 'nutai-fdc-'))
  mkdirSync(join(dir, 'branded'))
  writeFileSync(join(dir, 'branded/branded_food.csv'),
    'fdc_id,brand_owner,gtin_upc,ingredients,serving_size,serving_size_unit,branded_food_category\n' +
    '900001,Almarai,6281006012011,milk,200,ml,Dairy\n' +
    '900002,Poppins,0009800895007,sugar,30,g,Sweets\n')
  writeFileSync(join(dir, 'branded/food.csv'),
    'fdc_id,data_type,description,food_category_id,publication_date\n' +
    '900001,branded_food,ALMARAI FRESH LABAN,1,2024-01-01\n' +
    '900002,branded_food,POPPINS CANDY,2,2024-01-01\n')
  writeFileSync(join(dir, 'branded/food_nutrient.csv'),
    'id,fdc_id,nutrient_id,amount\n' +
    '1,900001,1008,40\n2,900001,1003,3.2\n3,900001,1004,1.5\n4,900001,1005,4.6\n' +
    '5,900002,1008,390\n6,900002,1003,0\n7,900002,1004,0\n8,900002,1005,97\n')
  return dir
}

async function db() {
  await loadSchema()
  const d = openFullDb(join(mkdtempSync(join(tmpdir(), 'nutai-b-')), 'full.db'))
  dbs.push(d)
  return d
}

describe('ingestBranded', () => {
  it('imports branded rows with their GTIN, tier and public-domain licence', async () => {
    const d = await db()
    const stats = await ingestBranded({ db: d, dir: brandedDir(), insertFood })
    expect(stats.inserted).toBe(2)
    const row = d.prepare("SELECT * FROM foods WHERE barcode = '0009800895007'").get()
    expect(row.tier).toBe('fdc_branded')
    expect(row.license).toBe('CC0-1.0')
    expect(row.source).toBe('fdc_branded')
  })

  it('lets the OFF row win on a shared GTIN', async () => {
    const d = await db()
    const dir = mkdtempSync(join(tmpdir(), 'nutai-offgz-'))
    const gz = join(dir, 'off.jsonl.gz')
    writeFileSync(gz, gzipSync(JSON.stringify({
      code: '6281006012011', product_name: 'Almarai Fresh Laban', brands: 'Almarai',
      nutriments: { 'energy-kcal_100g': 40, proteins_100g: 3.2, fat_100g: 1.5, carbohydrates_100g: 4.6 },
    }) + '\n'))

    await ingestOff({ db: d, jsonlGzPath: gz })
    const stats = await ingestBranded({ db: d, dir: brandedDir(), insertFood })

    expect(stats.inserted).toBe(1)
    expect(stats.dedupedToOff).toBe(1)
    const rows = d.prepare("SELECT tier FROM foods WHERE barcode = '6281006012011'").all()
    expect(rows.length).toBe(1)
    expect(rows[0].tier).toBe('off')
  })
})
