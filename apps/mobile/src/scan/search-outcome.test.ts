import { describe, expect, it, vi } from 'vitest'
import type { ScoredCandidate } from '@nutai/resolver'

// '../data/food-server' pulls in '../data/repo', which touches expo-sqlite at
// import time — not available under vitest's node environment. Same mock
// food-server.test.ts uses.
const settings = new Map<string, string>()
vi.mock('../data/repo', () => ({
  setting: async (key: string, fallback = '') => settings.get(key) ?? fallback,
  putSetting: async (key: string, value: string) => { settings.set(key, value) },
}))

const { UNREACHABLE_COPY } = await import('../data/food-server')
const { CLEARED_SEARCH_STATE, searchOutcomeState } = await import('./search-outcome')
import type { FoodServerResult, SearchPayload } from '../data/food-server'

describe('searchOutcomeState', () => {
  it('not_found reads as "no match", never as unreachable', () => {
    const state = searchOutcomeState({ kind: 'not_found' })
    expect(state.outcome).toBe('no match')
    expect(state.unreachable).toBe(false)
    expect(state.results).toEqual([])
  })

  it('server_unreachable with reason "http" shows the server detail, not the PC-is-asleep copy', () => {
    const r: FoodServerResult<SearchPayload> = {
      kind: 'server_unreachable',
      reason: 'http',
      detail: 'the server answered 400 (bad_query)',
    }
    const state = searchOutcomeState(r)
    expect(state.outcome).toBe('the server answered 400 (bad_query)')
    expect(state.unreachable).toBe(false)
  })

  it.each(['timeout', 'network', 'bad_response'] as const)(
    'server_unreachable with reason %s gets UNREACHABLE_COPY and unreachable=true',
    (reason) => {
      const r: FoodServerResult<SearchPayload> = { kind: 'server_unreachable', reason, detail: 'x' }
      const state = searchOutcomeState(r)
      expect(state.outcome).toBe(UNREACHABLE_COPY)
      expect(state.unreachable).toBe(true)
    },
  )

  it('an ok auto_accept surfaces the single match', () => {
    const match = {
      foodId: '1',
      name: 'Chicken',
      brand: null,
      category: null,
      prepFacet: null,
      basisConfidence: 'high',
      servingSizeG: null,
      energyKcal: 165,
      popularityRank: null,
      completenessScore: null,
      rawBm25: 0,
      score: 0.9,
      breakdown: {},
    } as unknown as ScoredCandidate
    const r: FoodServerResult<SearchPayload> = {
      kind: 'ok',
      value: { outcome: { kind: 'auto_accept', match }, ladderStep: 0, zeroHit: false, details: {} },
    }
    const state = searchOutcomeState(r)
    expect(state.results).toEqual([match])
    expect(state.unreachable).toBe(false)
    expect(state.outcome).toContain('auto-accepted')
  })

  it('an ok miss reads as no-match, distinct from a genuine not_found', () => {
    const r: FoodServerResult<SearchPayload> = {
      kind: 'ok',
      value: { outcome: { kind: 'miss' }, ladderStep: 0, zeroHit: true, details: {} },
    }
    const state = searchOutcomeState(r)
    expect(state.results).toEqual([])
    expect(state.unreachable).toBe(false)
  })
})

describe('CLEARED_SEARCH_STATE', () => {
  it('clears busy along with everything else — the sub-2-char early return must not strand the spinner', () => {
    expect(CLEARED_SEARCH_STATE.busy).toBe(false)
    expect(CLEARED_SEARCH_STATE.results).toEqual([])
    expect(CLEARED_SEARCH_STATE.unreachable).toBe(false)
  })
})
