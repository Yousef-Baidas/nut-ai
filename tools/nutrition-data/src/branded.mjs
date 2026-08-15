/**
 * The USDA branded tier — ~400k products, every one with a GTIN, public domain.
 *
 * Each CSV is read off disk one line at a time via a readline stream — never
 * slurped whole — because the branded release is ~2 GB unpacked and the
 * nutrient file alone is tens of millions of rows. The per-food metadata and
 * nutrient lookups this builds (`meta`, `nutrients`) DO accumulate in memory
 * across the whole branded release, which is fine at USDA branded's size but
 * is not the technique to reach for on something OFF-sized.
 *
 * DEDUP: `insertFood` (build-full.mjs) resolves a shared GTIN by tier rank —
 * `off` outranks `fdc_branded` regardless of which ingest runs first, so a
 * rebuild against a resident database still gets OFF-wins. A `null` return
 * here means one of two different things, which the stats below keep apart:
 * the barcode was already owned by an equal-or-higher tier (`dedupedToOff`),
 * or this exact fdc_id was already imported by a prior run of THIS ingest
 * (`alreadyImported`) — the second is normal rebuild idempotency, not a loss.
 */

import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { isNutritionallySane } from './off.mjs'
import { normalizeSearchText } from '@nutai/resolver'

const N = { energy_kcal: 1008, protein_g: 1003, fat_g: 1004, carb_g: 1005, fiber_g: 1079, sugar_g: 2000, sodium_mg: 1093, sat_fat_g: 1258 }

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

async function readCsv(path, onRow) {
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
  let header = null
  for await (const line of rl) {
    if (line.trim() === '') continue
    const cells = parseCsvLine(line)
    if (!header) { header = cells.map((h) => h.trim()); continue }
    const row = {}
    header.forEach((h, i) => { row[h] = cells[i] })
    onRow(row)
  }
}

function num(v) {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export function brandedRowFromCsv(meta, nutrients) {
  const food = {
    kcal: nutrients[N.energy_kcal] ?? null,
    protein: nutrients[N.protein_g] ?? null,
    fat: nutrients[N.fat_g] ?? null,
    carb: nutrients[N.carb_g] ?? null,
    fiber: nutrients[N.fiber_g] ?? null,
    sugar: nutrients[N.sugar_g] ?? null,
    sodiumMg: nutrients[N.sodium_mg] ?? null,
  }
  if (food.kcal == null || food.protein == null || food.fat == null || food.carb == null) return null
  if (!isNutritionallySane(food)) return null

  const synonyms = [meta.brandOwner, meta.category].filter((s) => s != null && s !== '')
  return {
    source: 'fdc_branded',
    sourceId: meta.fdcId,
    name: meta.description,
    brand: meta.brandOwner === '' ? null : meta.brandOwner,
    tier: 'fdc_branded',
    license: 'CC0-1.0',
    barcode: meta.gtin === '' ? null : meta.gtin,
    category: meta.category === '' ? null : meta.category,
    kcal: food.kcal, protein: food.protein, fat: food.fat,
    satFat: nutrients[N.sat_fat_g] ?? null,
    carb: food.carb, fiber: food.fiber, sugar: food.sugar, sodiumMg: food.sodiumMg,
    servingSizeG: meta.servingUnit === 'g' || meta.servingUnit === 'ml' ? num(meta.servingSize) : null,
    servingDesc: meta.servingSize === '' ? null : `${meta.servingSize} ${meta.servingUnit}`.trim(),
    completeness: 1,
    synonyms: [...new Set(synonyms.map((s) => normalizeSearchText(s)).filter((s) => s !== ''))],
  }
}

export async function ingestBranded({ db, dir, insertFood }) {
  const base = join(dir, 'branded')
  const meta = new Map()

  await readCsv(join(base, 'branded_food.csv'), (r) => {
    meta.set(r.fdc_id, {
      fdcId: r.fdc_id,
      brandOwner: (r.brand_owner ?? '').trim(),
      gtin: (r.gtin_upc ?? '').trim(),
      servingSize: (r.serving_size ?? '').trim(),
      servingUnit: (r.serving_size_unit ?? '').trim().toLowerCase(),
      category: (r.branded_food_category ?? '').trim(),
      description: '',
    })
  })

  await readCsv(join(base, 'food.csv'), (r) => {
    const m = meta.get(r.fdc_id)
    if (m) m.description = (r.description ?? '').trim()
  })

  const nutrients = new Map()
  await readCsv(join(base, 'food_nutrient.csv'), (r) => {
    if (!meta.has(r.fdc_id)) return
    const id = Number(r.nutrient_id)
    if (!Object.values(N).includes(id)) return
    let byId = nutrients.get(r.fdc_id)
    if (!byId) { byId = {}; nutrients.set(r.fdc_id, byId) }
    byId[id] = num(r.amount)
  })

  const now = Date.now()
  const stats = { read: 0, inserted: 0, rejected: 0, dedupedToOff: 0, alreadyImported: 0 }
  db.exec('BEGIN')
  try {
    for (const [fdcId, m] of meta) {
      stats.read++
      if (m.description === '') { stats.rejected++; continue }
      const row = brandedRowFromCsv(m, nutrients.get(fdcId) ?? {})
      if (row == null) { stats.rejected++; continue }

      // Recorded BEFORE the insert attempt, because insertFood may itself
      // delete the resident row (when THIS row's tier would win) before it
      // returns — by which point "was there already an owner" is unanswerable.
      const hadBarcodeOwner =
        row.barcode != null && db.prepare('SELECT 1 FROM foods WHERE barcode = ?').get(row.barcode) != null

      if (insertFood(db, row, now) != null) stats.inserted++
      else if (hadBarcodeOwner) stats.dedupedToOff++
      else stats.alreadyImported++
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return stats
}
