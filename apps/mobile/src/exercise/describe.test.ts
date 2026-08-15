import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Task 3 — the Describe-exercise screen had the same stuck-spinner shape as
 * issue #27 (fixed for the scan orchestrator in 806e85b). `DescribeScreen`
 * awaited setting/loadCredential/runExerciseEstimate/saveEntry with no
 * try/catch; a rejection anywhere in that chain propagated out of the
 * fire-and-forget `add()` call, leaving `busy` stuck at true forever. This
 * guards the extracted `describeExercise` chain so a rejection always
 * resolves to `{ ok: false, message }` instead of throwing.
 */

vi.mock('../data/repo', () => ({
  setting: async (key: string) => (key === 'provider' ? 'openai' : 'gpt-test'),
  db: async () => ({ run: async () => {} }),
  localDate: () => '2026-08-15',
  weightHistory: async () => [{ weightKg: 80 }],
}))

vi.mock('../inference/credentials', () => ({
  // The repro: the credential read throws instead of resolving to null or a
  // credential. The old inline code had no try/catch around this call.
  loadCredential: async () => {
    throw new Error('keychain read failed')
  },
}))

vi.mock('../inference/pathA/client', () => ({
  runExerciseEstimate: async () => {
    throw new Error('should not be reached')
  },
}))

const { describeExercise } = await import('./describe')

beforeEach(() => vi.clearAllMocks())

describe('describeExercise never throws — a rejection resolves to a failed outcome', () => {
  it('a throw from the credential read resolves to ok:false with a message, not a rejection', async () => {
    const outcome = await describeExercise('leg day, 30 mins')

    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.message.length).toBeGreaterThan(0)
  })
})
