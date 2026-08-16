/**
 * The USDA branded tier — ~400k products, every one with a GTIN, public domain.
 *
 * Each CSV is read off disk one line at a time via a readline stream — never
 * slurped whole — because the branded release is ~2 GB unpacked and the
 * nutrient file alone is tens of millions of rows. What changed: the per-food
 * metadata and nutrient lookups no longer accumulate in a JS Map. The 2026
 * release is ~2M products (954 MB branded_food.csv, 1.5 GB food_nutrient.csv),
 * which overflowed Node's heap even at --max-old-space-size=16384 ("Ineffective
 * mark-compacts near heap limit") — O(release) objects living on the V8 heap
 * simply does not fit.
 *
 * Instead, the join happens in the SAME better-sqlite3 handle the ingest is
 * given (`db`), via two TEMP tables:
 *   - `fdc_meta`     one row per branded_food.csv product (+ food.csv's
 *                    description, matched in by a second streaming pass).
 *   - `fdc_nutrient` one row per (fdc_id, nutrient_id, amount) triple, but
 *                    ONLY for the 8 nutrient_ids this ingest cares about
 *                    (`N` below) — food_nutrient.csv carries dozens of
 *                    nutrients per food, and the other rows would just be
 *                    disk weight with no reader.
 * Both are populated by streaming the CSVs exactly as before, batched into
 * ~5000-row transactions (same shape as the OFF ingest's CHECKPOINT_EVERY in
 * build-full.mjs) so peak memory is O(batch), not O(release) — the temp
 * tables themselves spill to SQLite's temp store on disk, not the JS heap.
 *
 * The final pass pivots `fdc_nutrient` into columns per food with a grouped
 * `MAX(CASE WHEN nutrient_id = ... THEN amount END)` join against `fdc_meta`
 * (a pivot, not per-nutrient-id sub-selects, so it's one pass over the join
 * rather than 8). better-sqlite3 forbids writing to the DB while a statement
 * on the same connection is mid-iteration, and `insertFood` writes — so this
 * cannot be driven with `stmt.iterate()`. Instead the join is read in PAGES
 * with `.all()` (which fully materializes and closes the statement before the
 * loop below does any writing), bookmarked by `fdc_meta.rowid` rather than
 * OFFSET — OFFSET pagination re-scans skipped rows on every page and goes
 * quadratic over 2M rows, while a `rowid > ?` bookmark is a single index
 * seek per page.
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

const BATCH_SIZE = 5000
const LOG_EVERY = 250000

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

/**
 * Stream a CSV line by line, calling `onRow` for each data row inside batched
 * transactions of BATCH_SIZE — the same shape as the OFF ingest's
 * checkpointing in build-full.mjs, minus the resumability (a branded ingest
 * failure is expected to be re-run from scratch; the CSVs aren't 9 GB).
 * `label` names the CSV for progress logging.
 */
async function readCsv(db, path, label, onRow) {
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
  let header = null
  let count = 0
  let sinceCommit = 0
  db.exec('BEGIN')
  try {
    for await (const line of rl) {
      if (line.trim() === '') continue
      const cells = parseCsvLine(line)
      if (!header) { header = cells.map((h) => h.trim()); continue }
      const row = {}
      header.forEach((h, i) => { row[h] = cells[i] })
      onRow(row)
      count++
      sinceCommit++
      if (sinceCommit >= BATCH_SIZE) {
        db.exec('COMMIT')
        db.exec('BEGIN')
        sinceCommit = 0
      }
      if (count % LOG_EVERY === 0) console.log(`  branded: ${label} ${count} rows`)
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  } finally {
    rl.close()
  }
  console.log(`  branded: ${label} ${count} rows (done)`)
  return count
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

function dropTempTables(db) {
  db.exec('DROP TABLE IF EXISTS fdc_meta')
  db.exec('DROP TABLE IF EXISTS fdc_nutrient')
}

export async function ingestBranded({ db, dir, insertFood }) {
  const base = join(dir, 'branded')

  dropTempTables(db)
  db.exec(`
    CREATE TEMP TABLE fdc_meta (
      fdc_id TEXT PRIMARY KEY,
      brand_owner TEXT,
      gtin TEXT,
      serving_size TEXT,
      serving_unit TEXT,
      category TEXT,
      description TEXT
    )
  `)
  db.exec(`
    CREATE TEMP TABLE fdc_nutrient (
      fdc_id TEXT,
      nutrient_id INTEGER,
      amount REAL
    )
  `)

  try {
    const insMeta = db.prepare(
      `INSERT OR REPLACE INTO fdc_meta (fdc_id, brand_owner, gtin, serving_size, serving_unit, category, description)
       VALUES (?,?,?,?,?,?,'')`,
    )
    await readCsv(db, join(base, 'branded_food.csv'), 'meta', (r) => {
      insMeta.run(
        r.fdc_id,
        (r.brand_owner ?? '').trim(),
        (r.gtin_upc ?? '').trim(),
        (r.serving_size ?? '').trim(),
        (r.serving_size_unit ?? '').trim().toLowerCase(),
        (r.branded_food_category ?? '').trim(),
      )
    })

    const updDesc = db.prepare('UPDATE fdc_meta SET description = ? WHERE fdc_id = ?')
    await readCsv(db, join(base, 'food.csv'), 'description', (r) => {
      updDesc.run((r.description ?? '').trim(), r.fdc_id)
    })

    const nutrientIds = new Set(Object.values(N))
    const insNutrient = db.prepare('INSERT INTO fdc_nutrient (fdc_id, nutrient_id, amount) VALUES (?,?,?)')
    await readCsv(db, join(base, 'food_nutrient.csv'), 'nutrients', (r) => {
      const id = Number(r.nutrient_id)
      if (!nutrientIds.has(id)) return
      insNutrient.run(r.fdc_id, id, num(r.amount))
    })

    console.log('  branded: indexing nutrients')
    db.exec('CREATE INDEX temp_fdc_nutrient_fdcid ON fdc_nutrient(fdc_id)')

    const now = Date.now()
    const stats = { read: 0, inserted: 0, rejected: 0, dedupedToOff: 0, alreadyImported: 0 }

    const pageStmt = db.prepare(`
      SELECT
        m.rowid AS _rowid,
        m.fdc_id AS fdcId, m.brand_owner AS brandOwner, m.gtin AS gtin,
        m.serving_size AS servingSize, m.serving_unit AS servingUnit,
        m.category AS category, m.description AS description,
        MAX(CASE WHEN n.nutrient_id = ${N.energy_kcal} THEN n.amount END) AS kcal,
        MAX(CASE WHEN n.nutrient_id = ${N.protein_g} THEN n.amount END) AS protein,
        MAX(CASE WHEN n.nutrient_id = ${N.fat_g} THEN n.amount END) AS fat,
        MAX(CASE WHEN n.nutrient_id = ${N.carb_g} THEN n.amount END) AS carb,
        MAX(CASE WHEN n.nutrient_id = ${N.fiber_g} THEN n.amount END) AS fiber,
        MAX(CASE WHEN n.nutrient_id = ${N.sugar_g} THEN n.amount END) AS sugar,
        MAX(CASE WHEN n.nutrient_id = ${N.sodium_mg} THEN n.amount END) AS sodiumMg,
        MAX(CASE WHEN n.nutrient_id = ${N.sat_fat_g} THEN n.amount END) AS satFat
      FROM fdc_meta m
      LEFT JOIN fdc_nutrient n ON n.fdc_id = m.fdc_id
      WHERE m.rowid > ?
      GROUP BY m.rowid
      ORDER BY m.rowid
      LIMIT ?
    `)

    let lastRowid = 0
    let joined = 0
    for (;;) {
      // .all() fully materializes and closes this statement before any write
      // below runs — that's what makes writing from insertFood() safe here.
      // stmt.iterate() would keep a live cursor on this same connection, and
      // better-sqlite3 forbids mutating the DB while that cursor is open.
      const page = pageStmt.all(lastRowid, BATCH_SIZE)
      if (page.length === 0) break

      db.exec('BEGIN')
      try {
        for (const r of page) {
          lastRowid = r._rowid
          joined++
          stats.read++
          if (r.description === '') { stats.rejected++; continue }

          const meta = {
            fdcId: r.fdcId, brandOwner: r.brandOwner, gtin: r.gtin,
            servingSize: r.servingSize, servingUnit: r.servingUnit,
            category: r.category, description: r.description,
          }
          const nutrients = {
            [N.energy_kcal]: r.kcal, [N.protein_g]: r.protein, [N.fat_g]: r.fat, [N.carb_g]: r.carb,
            [N.fiber_g]: r.fiber, [N.sugar_g]: r.sugar, [N.sodium_mg]: r.sodiumMg, [N.sat_fat_g]: r.satFat,
          }
          const row = brandedRowFromCsv(meta, nutrients)
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

      if (joined % LOG_EVERY < BATCH_SIZE) {
        console.log(`  branded: joined ${joined}, inserted ${stats.inserted}, rejected ${stats.rejected}`)
      }
    }

    console.log(`  branded: joined ${joined}, inserted ${stats.inserted}, rejected ${stats.rejected}`)
    return stats
  } finally {
    dropTempTables(db)
  }
}
