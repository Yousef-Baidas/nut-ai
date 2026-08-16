#!/usr/bin/env node
/**
 * Standalone portions/manifest backfill against an EXISTING full-corpus
 * database — no rebuild, no re-download.
 *
 * build-full.mjs never wrote `food_portions` before this fix wave (see
 * backfillPortions's own doc comment), so the corpus already sitting at
 * ~/nut-ai-data/nutrition-full.db from the real 1.5h full build has zero
 * portion rows and no portion_count/barcode_count manifest keys. Rebuilding
 * it from scratch (OFF + branded + arab, ~1.23M rows) just to pick up a
 * portions pass would waste that build; this script runs ONLY the backfill
 * pass against the DB that's already there.
 *
 * Usage:
 *   node tools/nutrition-data/src/backfill-portions.mjs [path-to-db]
 * Defaults to ~/nut-ai-data/nutrition-full.db (DEFAULT_FULL_OUT), same as
 * build-full.mjs itself. Safe to run against a DB the food-server is
 * currently reading (better-sqlite3 is a separate process; SQLite's own
 * locking handles the write) — restarting the service afterwards is not
 * required for correctness, only to pick up the new manifest keys, since
 * /health computes portion count live too when the manifest key is absent
 * (it isn't, after this runs).
 */

import {
  DEFAULT_FULL_OUT,
  backfillPortions,
  loadSchema,
  openFullDb,
  writeCheckpoint,
  writePortionBarcodeCounts,
} from './build-full.mjs'

const dbPath = process.argv[2] ?? DEFAULT_FULL_OUT

console.log(`Backfilling portions + manifest counts against ${dbPath}\n`)

await loadSchema()
const db = openFullDb(dbPath)
const inserted = backfillPortions(db)
const { portionCount, barcodeCount } = writePortionBarcodeCounts(db)
writeCheckpoint(db, 'backfill_portions_at', new Date().toISOString())
db.close()

console.log(`  portions inserted: ${inserted}`)
console.log(`  manifest portion_count: ${portionCount}`)
console.log(`  manifest barcode_count: ${barcodeCount}`)
