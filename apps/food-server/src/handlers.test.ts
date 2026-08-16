import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DbAdapter } from '@nutai/db-adapter'
import { buildFixtureDb } from './fixture.js'
import { handleBarcode, handleHealth, handleSearch } from './handlers.js'
import { SCHEMA_VERSION } from './wire.js'

let db: DbAdapter

beforeEach(async () => { db = await buildFixtureDb() })
afterEach(async () => { await db.close() })

describe('handleHealth', () => {
  it('reports the counts the app prints as its corpus line', async () => {
    const h = await handleHealth(db)
    expect(h.ok).toBe(true)
    expect(h.schemaVersion).toBe(SCHEMA_VERSION)
    expect(h.foods).toBe(4)
    expect(h.portions).toBe(2)
    expect(h.barcodes).toBe(1)
    expect(h.builtAt).toBe('2026-08-16T00:00:00.000Z')
    expect(h.tiers).toEqual(['arab_curated', 'generic', 'off'])
  })

  it('prefers the build_manifest counts.<tier> rows over a live table scan, when present', async () => {
    // Values deliberately DISAGREE with the live `foods` table (4 rows) — the
    // only way this test can distinguish "read the manifest" from "scanned the
    // table and got the right answer by coincidence".
    await db.run("INSERT INTO build_manifest (key, value) VALUES ('counts.off', '10')")
    await db.run("INSERT INTO build_manifest (key, value) VALUES ('counts.arab_curated', '5')")

    const h = await handleHealth(db)
    expect(h.foods).toBe(15)
    expect(h.tiers).toEqual(['arab_curated', 'off'])
  })

  it('prefers the build_manifest portion_count/barcode_count rows over a live table scan, when present', async () => {
    // Same disagree-on-purpose trick as the tier-counts test above: the live
    // fixture has 2 portions and 1 barcode, so a value that only matches
    // 99/42 proves the manifest row was read, not recomputed.
    await db.run("INSERT INTO build_manifest (key, value) VALUES ('portion_count', '99')")
    await db.run("INSERT INTO build_manifest (key, value) VALUES ('barcode_count', '42')")

    const h = await handleHealth(db)
    expect(h.portions).toBe(99)
    expect(h.barcodes).toBe(42)
  })
})

describe('handleSearch', () => {
  it('finds an Arab dish by its Arabic name', async () => {
    const r = await handleSearch(db, 'فول', 250)
    expect(r.outcome.kind).not.toBe('miss')
    const ids = r.outcome.kind === 'auto_accept'
      ? [r.outcome.match.foodId]
      : r.outcome.kind === 'disambiguate' ? r.outcome.candidates.map((c) => c.foodId) : []
    expect(ids).toContain('1')
  })

  it('finds the same dish by either transliteration', async () => {
    for (const q of ['ful', 'foul', 'fool']) {
      const r = await handleSearch(db, q, 250)
      const ids = r.outcome.kind === 'auto_accept'
        ? [r.outcome.match.foodId]
        : r.outcome.kind === 'disambiguate' ? r.outcome.candidates.map((c) => c.foodId) : []
      expect(ids, `query ${q}`).toContain('1')
    }
  })

  it('hydrates every candidate with full nutrition and its portions', async () => {
    const r = await handleSearch(db, 'ful', 250)
    const detail = r.details['1']
    expect(detail).toBeDefined()
    expect(detail!.food.proteinG).toBe(7.6)
    expect(detail!.food.carbG).toBe(17.8)
    expect(detail!.portions[0]!.gram_weight).toBe(250)
  })

  it('returns a miss outcome, not an error, for a word nothing matches', async () => {
    const r = await handleSearch(db, 'xyzzyx', 100)
    expect(r.outcome.kind).toBe('miss')
    expect(r.details).toEqual({})
  })
})

describe('handleBarcode', () => {
  it('returns the food and its portions for a stored GTIN', async () => {
    const r = await handleBarcode(db, '6281006012011')
    expect(r).not.toBeNull()
    expect(r!.food.name).toBe('Almarai Fresh Laban')
    expect(r!.food.energyKcal).toBe(40)
    expect(r!.portions[0]!.gram_weight).toBe(200)
  })

  it('returns null for a GTIN nothing carries', async () => {
    expect(await handleBarcode(db, '0000000000000')).toBeNull()
  })
})
