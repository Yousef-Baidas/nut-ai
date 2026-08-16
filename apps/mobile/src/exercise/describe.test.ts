import { describe, expect, it, vi } from 'vitest'

/**
 * Task 3 — the Describe-exercise screen had the same stuck-spinner shape as
 * issue #27 (fixed for the scan orchestrator in 806e85b). `DescribeScreen`
 * awaited setting/loadCredential/runExerciseEstimate/saveEntry with no
 * try/catch; a rejection anywhere in that chain propagated out of the
 * fire-and-forget `add()` call, leaving `busy` stuck at true forever. This
 * guards the extracted `describeExercise` chain so a rejection always
 * resolves to `{ ok: false, message }` instead of throwing, and
 * characterizes every other branch of the chain.
 */

let provider: string = 'openai'
const credential: unknown = { apiKey: 'sk-test' }
let credentialThrows = false
let runOutcome: unknown = {
  ok: true,
  raw: { label: 'Leg day', calories_kcal: 250, duration_min: 30 },
}
const saveEntryCalls: Array<[string, number]> = []

vi.mock('../data/repo', () => ({
  setting: async (key: string) => (key === 'provider' ? provider : 'gpt-test'),
}))

vi.mock('../inference/credentials', () => ({
  loadCredential: async () => {
    if (credentialThrows) throw new Error('keychain read failed')
    return credential
  },
}))

vi.mock('../inference/pathA/client', () => ({
  runExerciseEstimate: async () => runOutcome,
}))

vi.mock('./entries', () => ({
  latestWeightKg: async () => 80,
  saveEntry: async (name: string, kcal: number) => {
    saveEntryCalls.push([name, kcal])
  },
}))

const { describeExercise } = await import('./describe')

describe('describeExercise', () => {
  it('a throw from the credential read resolves to ok:false with the catch-all message, not a rejection', async () => {
    provider = 'openai'
    credentialThrows = true

    const outcome = await describeExercise('leg day, 30 mins')

    expect(outcome).toEqual({
      ok: false,
      message: 'Something went wrong estimating this workout. Try again.',
    })
    credentialThrows = false
  })

  it('no provider configured resolves to ok:false with the needs-an-API-key message, without calling the estimate client', async () => {
    provider = 'none'

    const outcome = await describeExercise('leg day, 30 mins')

    expect(outcome).toEqual({
      ok: false,
      message:
        'Describing a workout needs an API key — add one in Profile, or use Run, Weight lifting or Manual instead.',
    })
    provider = 'openai'
  })

  it('a raw response that fails schema validation resolves to ok:false with the unparseable message', async () => {
    runOutcome = { ok: true, raw: { nonsense: true } }

    const outcome = await describeExercise('leg day, 30 mins')

    expect(outcome).toEqual({
      ok: false,
      message: 'Could not turn that into an estimate — try adding a duration.',
    })
  })

  it('a client-side failure resolves to ok:false carrying the client error message', async () => {
    runOutcome = { ok: false, error: { message: 'quota exhausted' } }

    const outcome = await describeExercise('leg day, 30 mins')

    expect(outcome).toEqual({ ok: false, message: 'quota exhausted' })
  })

  it('a client-side failure with no error message falls back to a generic estimate-failed message', async () => {
    runOutcome = { ok: false, error: undefined }

    const outcome = await describeExercise('leg day, 30 mins')

    expect(outcome).toEqual({ ok: false, message: 'The estimate failed.' })
  })

  it('a valid estimate saves the entry and resolves to ok:true', async () => {
    saveEntryCalls.length = 0
    runOutcome = { ok: true, raw: { label: 'Leg day', calories_kcal: 250.4, duration_min: 30.6 } }

    const outcome = await describeExercise('leg day, 30 mins')

    expect(outcome).toEqual({ ok: true })
    expect(saveEntryCalls).toEqual([['Leg day — 31 min', 250]])
  })
})
