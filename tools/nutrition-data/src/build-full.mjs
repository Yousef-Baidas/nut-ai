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
 * Insert one FoodRow. Returns the new rowid, or null when the row already
 * existed (same source+source_id) or lost the GTIN uniqueness race.
 *
 * `INSERT OR IGNORE` against the unique barcode index is exactly the dedup rule:
 * whichever tier is ingested FIRST owns a GTIN. OFF is ingested before
 * fdc_branded, so OFF wins, as the spec requires.
 */
export function insertFood(db, row, now) {
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO foods
         (source, source_id, name, category, basis, basis_confidence, serving_size_g,
          serving_desc, barcode, energy_kcal, protein_g, fat_g, sat_fat_g, carb_g,
          fiber_g, sugar_g, sodium_mg, completeness_score, tier, license, updated_at)
       VALUES (?,?,?,?, 'per_100g', 'high', ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      row.source, row.sourceId, row.name, row.category ?? null, row.servingSizeG ?? null,
      row.servingDesc ?? null, row.barcode ?? null, row.kcal, row.protein, row.fat,
      row.satFat ?? null, row.carb, row.fiber ?? null, row.sugar ?? null, row.sodiumMg ?? null,
      row.completeness, row.tier, row.license, now,
    )
  if (info.changes === 0) return null

  const id = Number(info.lastInsertRowid)
  const synonyms = row.synonyms.join(' ')
  db.prepare('INSERT INTO food_fts (rowid, name, brand, synonyms) VALUES (?,?,?,?)').run(
    id, normalizeSearchText(row.name), row.brand ?? '', synonyms,
  )
  db.prepare('INSERT INTO food_fts_trigram (rowid, name) VALUES (?,?)').run(id, normalizeSearchText(row.name))
  const insSyn = db.prepare('INSERT INTO food_synonyms (food_id, synonym, synonym_type) VALUES (?,?,?)')
  for (const s of row.synonyms) insSyn.run(id, s, 'source')
  return id
}

/**
 * Stream the OFF dump into `db`.
 *
 * `resume` (default true) starts after the recorded checkpoint line, which is
 * what makes a nine-gigabyte import survive an interruption.
 */
export async function ingestOff({ db, jsonlGzPath, resume = true, limit = Infinity, onProgress = null }) {
  const startLine = resume ? Number(readCheckpoint(db, 'off.line') ?? 0) : 0
  const stats = { read: 0, inserted: 0, rejected: 0, skipped: 0 }
  const now = Date.now()

  const rl = createInterface({
    input: createReadStream(jsonlGzPath).pipe(createGunzip()),
    crlfDelay: Infinity,
  })

  let lineNo = 0
  let sinceCheckpoint = 0
  db.exec('BEGIN')
  try {
    for await (const line of rl) {
      lineNo++
      if (lineNo <= startLine) { stats.skipped++; continue }
      if (stats.read >= limit) break

      stats.read++
      const food = parseOffLine(line)
      if (food == null || !isNutritionallySane(food)) { stats.rejected++ }
      else if (insertFood(db, offFoodToRow(food), now) != null) { stats.inserted++ }

      sinceCheckpoint++
      if (sinceCheckpoint >= CHECKPOINT_EVERY) {
        writeCheckpoint(db, 'off.line', lineNo)
        db.exec('COMMIT')
        db.exec('BEGIN')
        sinceCheckpoint = 0
        if (onProgress) onProgress({ ...stats, line: lineNo })
      }
    }
    writeCheckpoint(db, 'off.line', lineNo)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
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
