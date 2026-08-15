#!/usr/bin/env node
/**
 * The FULL corpus build — PC only, never an app asset.
 *
 * Three tiers land in one file: `off` (Open Food Facts, ODbL), `fdc_branded`
 * (USDA, public domain) and `arab_curated` (a checked-in CSV, every row cited).
 *
 * THE CONSTRAINT THAT SHAPES THIS FILE: the OFF export is ~9 GB gzipped and
 * cannot be held in memory, or read twice, or restarted from zero after a laptop
 * lid closes. So: one gunzip stream, one line at a time, a checkpoint row every
 * CHECKPOINT_EVERY lines, and inserts keyed on (source, source_id) so a rerun
 * over already-imported lines is a no-op rather than a duplicate.
 *
 * Download the artifact first (about 9 GB, resumable with curl -C -):
 *   curl -C - -o ~/nut-ai-data/openfoodfacts-products.jsonl.gz \
 *     https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz
 */

import { createReadStream } from 'node:fs'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createGunzip } from 'node:zlib'
import Database from 'better-sqlite3'
import { normalizeSearchText } from '@nutai/resolver'
import { isNutritionallySane, offFoodToRow, parseOffLine } from './off.mjs'
import { ingestBranded } from './branded.mjs'
import { ingestArab } from './arab.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '../../..')

export const DEFAULT_FULL_OUT = join(homedir(), 'nut-ai-data/nutrition-full.db')
export const DEFAULT_OFF_DUMP = join(homedir(), 'nut-ai-data/openfoodfacts-products.jsonl.gz')

const CHECKPOINT_EVERY = 5000

async function schemaSql() {
  const src = await readFile(join(REPO, 'packages/db-adapter/src/schema.ts'), 'utf8')
  const grab = (name) => {
    const m = new RegExp(`export const ${name} = \`([\\s\\S]*?)\``).exec(src)
    if (!m) throw new Error(`could not extract ${name} from schema.ts`)
    return m[1]
  }
  return { schema: grab('NUTRITION_SCHEMA'), fts: grab('NUTRITION_FTS_SCHEMA') }
}

let SCHEMA_CACHE = null

/**
 * Open (or create) the full corpus. Synchronous on purpose: this is a build
 * script, and better-sqlite3 is synchronous.
 */
export function openFullDb(path) {
  if (SCHEMA_CACHE == null) throw new Error('call await loadSchema() before openFullDb()')
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.exec(SCHEMA_CACHE.schema)
  db.exec(SCHEMA_CACHE.fts)
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_foods_source_row ON foods(source, source_id);`)
  return db
}

export async function loadSchema() {
  if (SCHEMA_CACHE == null) SCHEMA_CACHE = await schemaSql()
  return SCHEMA_CACHE
}

export function readCheckpoint(db, key) {
  const row = db.prepare('SELECT value FROM build_manifest WHERE key = ?').get(key)
  return row == null ? null : row.value
}

export function writeCheckpoint(db, key, value) {
  db.prepare('INSERT OR REPLACE INTO build_manifest (key, value) VALUES (?,?)').run(key, String(value))
}

/**
 * Look up (or create) the brand row and return its id, or null for an
 * unbranded product. `foods.brand_id` is the schema's real home for brand
 * (schema.ts:33,44) — writing it only into food_fts left every barcode hit
 * brand-less, since loadFood/resolveByBarcode read brand off `brands` via
 * `brand_id`, never off the FTS row.
 */
function resolveBrandId(db, brandName) {
  if (brandName == null) return null
  const name = brandName.trim()
  if (name === '') return null
  const existing = db.prepare('SELECT id FROM brands WHERE canonical_name = ?').get(name)
  if (existing != null) return existing.id
  const info = db.prepare('INSERT INTO brands (canonical_name) VALUES (?)').run(name)
  return Number(info.lastInsertRowid)
}

/**
 * Insert one FoodRow. Returns the new rowid, or null when the row already
 * existed (same source+source_id) or lost the GTIN uniqueness race.
 *
 * `INSERT OR IGNORE` against the unique barcode index is exactly the dedup rule:
 * whichever tier is ingested FIRST owns a GTIN. OFF is ingested before
 * fdc_branded, so OFF wins, as the spec requires.
 */
export function insertFood(db, row, now) {
  const brandId = resolveBrandId(db, row.brand)
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO foods
         (source, source_id, name, brand_id, category, basis, basis_confidence, serving_size_g,
          serving_desc, barcode, energy_kcal, protein_g, fat_g, sat_fat_g, carb_g,
          fiber_g, sugar_g, sodium_mg, completeness_score, tier, license, updated_at)
       VALUES (?,?,?,?,?, 'per_100g', 'high', ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      row.source, row.sourceId, row.name, brandId, row.category ?? null, row.servingSizeG ?? null,
      row.servingDesc ?? null, row.barcode ?? null, row.kcal, row.protein, row.fat,
      row.satFat ?? null, row.carb, row.fiber ?? null, row.sugar ?? null, row.sodiumMg ?? null,
      row.completeness, row.tier, row.license, now,
    )
  if (info.changes === 0) return null

  const id = Number(info.lastInsertRowid)
  const synonyms = row.synonyms.join(' ')
  const normalizedBrand = row.brand != null ? normalizeSearchText(row.brand) : ''
  db.prepare('INSERT INTO food_fts (rowid, name, brand, synonyms) VALUES (?,?,?,?)').run(
    id, normalizeSearchText(row.name), normalizedBrand, synonyms,
  )
  db.prepare('INSERT INTO food_fts_trigram (rowid, name) VALUES (?,?)').run(id, normalizeSearchText(row.name))
  const insSyn = db.prepare('INSERT INTO food_synonyms (food_id, synonym, synonym_type) VALUES (?,?,?)')
  for (const s of row.synonyms) insSyn.run(id, s, 'source')
  return id
}

/**
 * A cheap identity for the dump file — size plus mtime, not a hash, because
 * hashing a 9 GB file just to decide whether to resume defeats the point of
 * resuming. Good enough to catch "this is a different weekly export" without
 * reading the file twice.
 */
async function dumpIdentity(jsonlGzPath) {
  const st = await stat(jsonlGzPath)
  return `${st.size}:${Math.trunc(st.mtimeMs)}`
}

/**
 * Stream the OFF dump into `db`.
 *
 * `resume` (default true) starts after the recorded checkpoint line, which is
 * what makes a nine-gigabyte import survive an interruption. The checkpoint is
 * only honored when the dump's identity (size+mtime) still matches what was
 * recorded — resuming a stale line number against a newer weekly export would
 * silently skip its first N lines, since line N of the new file is a different
 * product than line N of the old one.
 */
export async function ingestOff({ db, jsonlGzPath, resume = true, limit = Infinity, onProgress = null }) {
  const identity = await dumpIdentity(jsonlGzPath)
  const storedIdentity = readCheckpoint(db, 'off.dump')
  const dumpChanged = storedIdentity != null && storedIdentity !== identity
  const startLine = resume && !dumpChanged ? Number(readCheckpoint(db, 'off.line') ?? 0) : 0
  const stats = { read: 0, inserted: 0, rejected: 0, ignored: 0, skipped: 0 }
  const now = Date.now()

  const fileStream = createReadStream(jsonlGzPath)
  const gunzip = createGunzip()
  const rl = createInterface({ input: fileStream.pipe(gunzip), crlfDelay: Infinity })

  let lineNo = 0
  let sinceCheckpoint = 0
  db.exec('BEGIN')
  try {
    for await (const line of rl) {
      // Checked BEFORE bumping lineNo, so a limit-triggered break never counts
      // the unread next line as "done" — otherwise the checkpoint records a
      // line that was never parsed, and a resumed run drops it forever.
      if (stats.read >= limit) break
      lineNo++
      if (lineNo <= startLine) { stats.skipped++; continue }

      stats.read++
      const food = parseOffLine(line)
      if (food == null || !isNutritionallySane(food)) {
        stats.rejected++
      } else if (insertFood(db, offFoodToRow(food), now) != null) {
        stats.inserted++
      } else {
        // Sane and complete, but an INSERT OR IGNORE collision on
        // (source, source_id) or barcode — already imported, not rejected.
        stats.ignored++
      }

      sinceCheckpoint++
      if (sinceCheckpoint >= CHECKPOINT_EVERY) {
        writeCheckpoint(db, 'off.line', lineNo)
        writeCheckpoint(db, 'off.dump', identity)
        db.exec('COMMIT')
        db.exec('BEGIN')
        sinceCheckpoint = 0
        if (onProgress) onProgress({ ...stats, line: lineNo })
      }
    }
    writeCheckpoint(db, 'off.line', lineNo)
    writeCheckpoint(db, 'off.dump', identity)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  } finally {
    rl.close()
    gunzip.destroy()
    fileStream.destroy()
  }

  return stats
}

async function main() {
  const out = process.env.OUT ?? DEFAULT_FULL_OUT
  const dump = process.env.OFF_DUMP ?? DEFAULT_OFF_DUMP

  await mkdir(dirname(out), { recursive: true })
  try {
    await stat(dump)
  } catch {
    throw new Error(
      `OFF dump not found at ${dump}\n` +
        `  curl -C - -o ${dump} \\\n` +
        `    https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz`,
    )
  }

  await loadSchema()
  const db = openFullDb(out)
  console.log(`nutai-nutrition-data — full build into ${out}`)
  const stats = await ingestOff({
    db,
    jsonlGzPath: dump,
    onProgress: (p) => console.log(`  off: line ${p.line}, ${p.inserted} kept, ${p.rejected} rejected`),
  })
  console.log(`  off: ${stats.inserted} kept, ${stats.rejected} rejected, ${stats.skipped} skipped`)

  const brandedDir = process.env.FDC_BRANDED_DIR ?? join(homedir(), 'nut-ai-data/fdc')
  let branded = { read: 0, inserted: 0, rejected: 0, dedupedToOff: 0 }
  try {
    await stat(join(brandedDir, 'branded/branded_food.csv'))
    branded = await ingestBranded({ db, dir: brandedDir, insertFood })
    console.log(`  fdc_branded: ${branded.inserted} kept, ${branded.dedupedToOff} lost the GTIN to an OFF row`)
  } catch {
    console.log('  fdc_branded: skipped (set FDC_BRANDED_DIR to the unpacked USDA branded release)')
  }

  const arab = await ingestArab({ db, csvPath: join(REPO, 'tools/nutrition-data/arab-foods.csv'), insertFood })
  console.log(`  arab_curated: ${arab.inserted} rows, all cited`)

  writeCheckpoint(db, 'tiers', 'off,fdc_branded,arab_curated')
  writeCheckpoint(db, 'licenses', 'ODbL-1.0 (Open Food Facts) | CC0-1.0 (USDA FDC) | curated-cited (arab_curated)')
  writeCheckpoint(db, 'dedup_rule', 'same GTIN: the off row wins over fdc_branded')
  writeCheckpoint(db, 'schema_version', '1')
  writeCheckpoint(db, 'built_at', new Date().toISOString())
  db.close()
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('\nFULL BUILD FAILED\n')
    console.error(err.message)
    process.exit(1)
  })
}
