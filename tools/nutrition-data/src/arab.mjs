/**
 * The curated Arab-foods tier.
 *
 * THE RULE: a row without a citable published source does not ship. This module
 * throws on an uncited row rather than skipping it, because a silent skip is how
 * a table quietly loses its most-wanted dishes; a throw makes the CSV editor fix
 * the row they just added.
 *
 * Growing this tier is CONTENT WORK, not code work: add lines to
 * tools/nutrition-data/arab-foods.csv, each carrying its own citation, and
 * rebuild. No code change is needed to go from 20 rows to 300.
 */

import { readFile } from 'node:fs/promises'
import { isNutritionallySane } from './off.mjs'
import { normalizeSearchText } from '@nutai/resolver'

export const ARAB_CSV_COLUMNS = [
  'id', 'name_en', 'name_ar', 'synonyms', 'kcal_100g', 'protein_g', 'fat_g',
  'carb_g', 'fiber_g', 'sugar_g', 'sodium_mg', 'category', 'serving_size_g',
  'serving_desc', 'source',
]

function parseCsvLine(line) {
  const out = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++ } else { inQuotes = false }
      } else cur += ch
    } else if (ch === '"') inQuotes = true
    else if (ch === ',') { out.push(cur); cur = '' }
    else cur += ch
  }
  out.push(cur)
  return out
}

function num(v) {
  if (v == null || v.trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export function parseArabCsv(text) {
  const lines = text.split('\n').filter((l) => l.trim() !== '')
  const header = parseCsvLine(lines[0]).map((h) => h.trim())
  const missing = ARAB_CSV_COLUMNS.filter((c) => !header.includes(c))
  if (missing.length > 0) {
    throw new Error(`arab-foods.csv: missing column(s) ${missing.join(', ')}`)
  }

  const rows = []
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i])
    const r = {}
    header.forEach((h, idx) => { r[h] = (cells[idx] ?? '').trim() })

    if (r.source === '') {
      throw new Error(
        `arab-foods.csv line ${i + 1} (${r.id}): empty source. Every row must cite the ` +
          `published food-composition table it came from. No invented values ship.`,
      )
    }

    const food = {
      kcal: num(r.kcal_100g), protein: num(r.protein_g), fat: num(r.fat_g),
      carb: num(r.carb_g), fiber: num(r.fiber_g), sugar: num(r.sugar_g),
      sodiumMg: num(r.sodium_mg),
    }
    if (!isNutritionallySane(food)) {
      throw new Error(`arab-foods.csv line ${i + 1} (${r.id}): values are not sane (energy/macro check failed)`)
    }

    const rawSynonyms = [r.name_ar, ...r.synonyms.split(';')]
      .map((s) => s.trim())
      .filter((s) => s !== '')
    const synonyms = [...new Set(rawSynonyms.map((s) => normalizeSearchText(s)).filter((s) => s !== ''))]

    rows.push({
      source: 'arab_curated',
      sourceId: r.id,
      name: r.name_en,
      brand: null,
      tier: 'arab_curated',
      license: 'curated-cited',
      barcode: null,
      category: r.category === '' ? null : r.category,
      kcal: food.kcal, protein: food.protein, fat: food.fat, satFat: null,
      carb: food.carb, fiber: food.fiber, sugar: food.sugar, sodiumMg: food.sodiumMg,
      servingSizeG: num(r.serving_size_g),
      servingDesc: r.serving_desc === '' ? null : r.serving_desc,
      completeness: [food.kcal, food.protein, food.fat, food.carb].filter((v) => v != null).length / 4,
      synonyms,
      sourceCitation: r.source,
    })
  }
  return rows
}

/** Insert every CSV row, using the shared writer so FTS and synonyms stay in sync. */
export async function ingestArab({ db, csvPath, insertFood }) {
  const rows = parseArabCsv(await readFile(csvPath, 'utf8'))
  const now = Date.now()
  let inserted = 0
  db.exec('BEGIN')
  try {
    for (const row of rows) {
      const id = insertFood(db, row, now)
      if (id != null) {
        inserted++
        db.prepare('INSERT INTO food_micros (food_id, nutrient_code, amount) VALUES (?,?,?)')
          .run(id, 'citation_present', 1)
      }
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return { read: rows.length, inserted }
}
