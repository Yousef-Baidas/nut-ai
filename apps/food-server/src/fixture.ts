import { NUTRITION_FTS_SCHEMA, NUTRITION_SCHEMA, type DbAdapter } from '@nutai/db-adapter'
import { openMemoryDb } from '@nutai/db-adapter/node'
import { normalizeSearchText } from '@nutai/resolver'

/**
 * A four-row corpus with one Arab dish, one branded GTIN row and two generics.
 *
 * Small on purpose: these tests are about the SERVER, and a test that needs the
 * 9 GB import to run is a test nobody runs.
 */
const ROWS = [
  { id: 1, source: 'arab_curated', tier: 'arab_curated', license: 'curated-cited', name: 'Ful medames (cooked fava beans)',
    barcode: null, kcal: 110, protein: 7.6, fat: 0.5, carb: 17.8, synonyms: 'فول ful mdms mudammas' },
  { id: 2, source: 'off', tier: 'off', license: 'ODbL-1.0', name: 'Almarai Fresh Laban',
    barcode: '6281006012011', kcal: 40, protein: 3.2, fat: 1.5, carb: 4.6, synonyms: 'laban almarai' },
  { id: 3, source: 'fdc_sr_legacy', tier: 'generic', license: 'CC0-1.0', name: 'Chicken, broilers or fryers, breast, meat only, cooked, roasted',
    barcode: null, kcal: 165, protein: 31, fat: 3.6, carb: 0, synonyms: '' },
  { id: 4, source: 'fdc_sr_legacy', tier: 'generic', license: 'CC0-1.0', name: 'Rice, white, long-grain, regular, cooked',
    barcode: null, kcal: 130, protein: 2.7, fat: 0.3, carb: 28, synonyms: '' },
]

export async function buildFixtureDb(): Promise<DbAdapter> {
  const db = openMemoryDb()
  await db.exec(NUTRITION_SCHEMA)
  await db.exec(NUTRITION_FTS_SCHEMA)

  for (const r of ROWS) {
    await db.run(
      `INSERT INTO foods (id, source, source_id, name, tier, license, barcode, energy_kcal,
                          protein_g, fat_g, carb_g, completeness_score, popularity_rank, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,0)`,
      [r.id, r.source, String(r.id), r.name, r.tier, r.license, r.barcode, r.kcal, r.protein, r.fat, r.carb, r.id],
    )
    await db.run('INSERT INTO food_fts (rowid, name, brand, synonyms) VALUES (?,?,?,?)', [
      r.id, normalizeSearchText(r.name), '', normalizeSearchText(r.synonyms),
    ])
  }

  await db.run(
    `INSERT INTO food_portions (food_id, measure_unit, modifier, amount, gram_weight, is_fndds_default)
     VALUES (1, 'bowl', 'medium', 1, 250, 1)`,
  )
  await db.run(
    `INSERT INTO food_portions (food_id, measure_unit, modifier, amount, gram_weight, is_fndds_default)
     VALUES (2, 'glass', '', 1, 200, 1)`,
  )
  await db.run("INSERT INTO build_manifest (key, value) VALUES ('built_at', '2026-08-16T00:00:00.000Z')")
  await db.run("INSERT INTO build_manifest (key, value) VALUES ('tiers', 'off,fdc_branded,arab_curated')")
  return db
}
