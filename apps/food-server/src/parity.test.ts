import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DbAdapter } from '@nutai/db-adapter'
import { normalizeSearchText, resolveByText } from '@nutai/resolver'
import { buildFixtureDb } from './fixture.js'
import { handleSearch } from './handlers.js'

/**
 * The anti-drift test the spec asks for by name: call the resolver directly,
 * call the endpoint handler, compare. If the server ever starts massaging the
 * outcome — re-ranking, truncating, renaming a field — this fails.
 */
let db: DbAdapter
beforeEach(async () => { db = await buildFixtureDb() })
afterEach(async () => { await db.close() })

const QUERIES = ['ful', 'فول', 'chicken breast', 'rice white cooked', 'xyzzyx']

describe('search parity with resolveByText', () => {
  it.each(QUERIES)('returns the resolver outcome verbatim for %s', async (q) => {
    const direct = await resolveByText(db, {
      canonicalFoodKey: normalizeSearchText(q),
      observedBrand: null,
      prepFacet: null,
      modelCategory: null,
      estimatedGrams: 150,
    })
    const served = await handleSearch(db, q, 150)

    expect(served.outcome).toEqual(direct.outcome)
    expect(served.ladderStep).toBe(direct.ladderStep)
    expect(served.zeroHit).toBe(direct.zeroHit)
  })

  it('survives a JSON round trip without changing shape', async () => {
    const served = await handleSearch(db, 'ful', 150)
    expect(JSON.parse(JSON.stringify(served))).toEqual(served)
  })
})
