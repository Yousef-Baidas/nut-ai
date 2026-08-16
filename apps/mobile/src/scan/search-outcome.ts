import type { ScoredCandidate } from '@nutai/resolver'
import { UNREACHABLE_COPY, type FoodDetail, type FoodServerResult, type SearchPayload } from '../data/food-server'

export interface SearchOutcomeState {
  results: ScoredCandidate[]
  details: Record<string, FoodDetail>
  outcome: string
  unreachable: boolean
}

/**
 * The whole result of a `/search` round trip, decided in one place and unit
 * tested here instead of inline inside a component effect.
 *
 * Two failure classes read very differently to a user and must never collapse
 * into one message:
 *
 * - `not_found` — the PC answered fine; nothing in the corpus matched. Not
 *   "unreachable".
 * - `server_unreachable` with `reason: 'timeout' | 'network' | 'bad_response'`
 *   — genuinely couldn't reach or trust the PC. Gets `UNREACHABLE_COPY`.
 * - `server_unreachable` with `reason: 'http'` — the server answered a 4xx to
 *   a malformed request of ours (e.g. `bad_query`, `apps/food-server/src/
 *   server.ts:72,78`). That is a client bug against a healthy server, not
 *   "is the PC on?" — it renders the server's own detail message and does
 *   NOT flip `unreachable`, so it never blames the user's PC for our bug.
 */
export function searchOutcomeState(r: FoodServerResult<SearchPayload>): SearchOutcomeState {
  if (r.kind === 'not_found') {
    return { results: [], details: {}, outcome: 'no match', unreachable: false }
  }
  if (r.kind === 'server_unreachable') {
    if (r.reason === 'http') {
      return { results: [], details: {}, outcome: r.detail, unreachable: false }
    }
    return { results: [], details: {}, outcome: UNREACHABLE_COPY, unreachable: true }
  }
  const o = r.value.outcome
  if (o.kind === 'auto_accept') {
    return {
      results: [o.match],
      details: r.value.details,
      outcome: `auto-accepted (score ${o.match.score.toFixed(2)})`,
      unreachable: false,
    }
  }
  if (o.kind === 'disambiguate') {
    return {
      results: o.candidates,
      details: r.value.details,
      outcome: `${o.candidates.length} candidates — tap the right one`,
      unreachable: false,
    }
  }
  return {
    results: [],
    details: r.value.details,
    outcome: 'no match — nothing in the corpus matched',
    unreachable: false,
  }
}

/**
 * What a query too short to search resets every field to — including `busy`.
 *
 * Regression fixture: clearing the query field while a search request was in
 * flight used to leave `busy` stuck true forever. The effect's early return
 * cleared results/details/outcome/unreachable but never called `setBusy(false)`,
 * and by the time the in-flight response landed the `alive` guard threw its
 * result away — an `ActivityIndicator` spinning under an empty box, forever.
 */
export const CLEARED_SEARCH_STATE: SearchOutcomeState & { busy: boolean } = {
  results: [],
  details: {},
  outcome: '',
  unreachable: false,
  busy: false,
}
