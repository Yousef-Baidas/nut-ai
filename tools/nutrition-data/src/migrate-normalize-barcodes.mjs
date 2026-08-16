#!/usr/bin/env node
/**
 * One-off repair for a full corpus built before insertFood normalized barcodes
 * (docs/ratified-spec.md would call the old state a lookup-poisoning defect:
 * `resolveByBarcode` queries the canonical 13-digit GTIN, but the DB stored the
 * sources' raw strings — FDC zero-padded to 14, OFF at 8/12/13 — so no scan
 * could ever hit). Rewrites every barcode to `normalizeGtin` form, in place.
 *
 * Collision rule: when two rows normalize to the same GTIN, the higher-ranked
 * tier keeps it (same order as build-full's TIER_RANK: off > fdc_branded >
 * arab_curated) and the loser's barcode becomes NULL. Deliberately weaker than
 * the build's rule, which deletes the losing row outright: a migration should
 * not destroy food rows (they stay reachable by text search); the next full
 * rebuild applies the strict rule.
 *
 * Usage: node tools/nutrition-data/src/migrate-normalize-barcodes.mjs [db-path]
 * Stop the food server first — this writes to the file it holds open.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { normalizeGtin } from '@nutai/resolver'

const TIER_RANK = { off: 2, fdc_branded: 1, arab_curated: 0 }

const dbPath = process.argv[2] ?? join(homedir(), 'nut-ai-data', 'nutrition-full.db')
const db = new Database(dbPath)
db.pragma('journal_mode = WAL')

const rows = db.prepare('SELECT id, tier, barcode FROM foods WHERE barcode IS NOT NULL').all()
console.log(`${rows.length} barcoded rows in ${dbPath}`)

// Group by normalized GTIN first: the unique index on foods(barcode) means the
// winner/loser decision must be settled before any UPDATE runs.
const byGtin = new Map()
let invalid = 0
for (const r of rows) {
  const norm = normalizeGtin(String(r.barcode))
  if (norm == null) {
    invalid++
    r.norm = null
    continue
  }
  r.norm = norm
  const group = byGtin.get(norm)
  if (group) group.push(r)
  else byGtin.set(norm, [r])
}

let unchanged = 0
let rewritten = 0
let collisionsNulled = 0

const setBarcode = db.prepare('UPDATE foods SET barcode = ? WHERE id = ?')

db.transaction(() => {
  // Pass 1: NULL every row that is invalid or loses its group, freeing the
  // unique index for pass 2's rewrites.
  for (const r of rows) if (r.norm == null) setBarcode.run(null, r.id)

  const winners = []
  for (const [norm, group] of byGtin) {
    group.sort((a, b) => (TIER_RANK[b.tier] ?? -1) - (TIER_RANK[a.tier] ?? -1) || a.id - b.id)
    const [winner, ...losers] = group
    winners.push({ id: winner.id, norm, already: winner.barcode === norm })
    for (const l of losers) {
      setBarcode.run(null, l.id)
      collisionsNulled++
    }
  }

  // Pass 2: rewrite the winners.
  for (const w of winners) {
    if (w.already) {
      unchanged++
      continue
    }
    setBarcode.run(w.norm, w.id)
    rewritten++
  }

  const remaining = db.prepare('SELECT COUNT(*) c FROM foods WHERE barcode IS NOT NULL').get().c
  db.prepare("UPDATE build_manifest SET value = ? WHERE key = 'barcode_count'").run(String(remaining))
})()

const remaining = db.prepare('SELECT COUNT(*) c FROM foods WHERE barcode IS NOT NULL').get().c
console.log(
  `done: ${rewritten} rewritten, ${unchanged} already canonical, ` +
    `${invalid} invalid -> NULL, ${collisionsNulled} collision losers -> NULL; ` +
    `${remaining} barcoded rows remain`,
)
db.close()
