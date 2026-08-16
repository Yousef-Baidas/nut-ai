import { ExerciseEstimateZ } from '@nutai/core-schema'
import { cheapestModel, type ProviderId } from '@nutai/prompt'
import { setting } from '../data/repo'
import { loadCredential } from '../inference/credentials'
import { runExerciseEstimate } from '../inference/cloud/client'
import { latestWeightKg, saveEntry } from './entries'

/** Either a saved entry, or a user-facing reason it wasn't. */
export type DescribeOutcome = { ok: true } | { ok: false; message: string }

/**
 * Describe-exercise — the model-owned path, guarded against the stuck-spinner
 * shape from issue #27.
 *
 * `DescribeScreen` used to set `busy=true` and await this chain with no
 * try/catch: a throw from `setting`, `loadCredential`, `runExerciseEstimate`
 * or `saveEntry` propagated out of the fire-and-forget `add()` call with
 * nothing to catch it, stranding the screen on its spinner forever — the same
 * defect shape as the scan orchestrator's unhandled rejection. This function
 * owns the whole chain and always resolves to an outcome, never throws, so the
 * screen only has to flip `busy` back to false and show a message.
 */
export async function describeExercise(desc: string): Promise<DescribeOutcome> {
  try {
    const provider = (await setting('provider')) as ProviderId | 'none' | ''
    const credential = provider && provider !== 'none' ? await loadCredential(provider) : null
    if (!credential || !provider || provider === 'none') {
      return {
        ok: false,
        message:
          'Describing a workout needs an API key — add one in Profile, or use Run, Weight lifting or Manual instead.',
      }
    }

    const model = (await setting('provider_model')) || cheapestModel(provider).id
    const kg = await latestWeightKg()
    const outcome = await runExerciseEstimate(provider, { model, description: desc, weightKg: kg }, credential)
    const parsed = outcome.ok ? ExerciseEstimateZ.safeParse(outcome.raw) : null

    if (!parsed?.success) {
      return {
        ok: false,
        message: outcome.ok
          ? 'Could not turn that into an estimate — try adding a duration.'
          : (outcome.error?.message ?? 'The estimate failed.'),
      }
    }

    const e = parsed.data
    await saveEntry(
      e.duration_min ? `${e.label} — ${Math.round(e.duration_min)} min` : e.label,
      Math.round(e.calories_kcal),
    )
    return { ok: true }
  } catch {
    // ANY unhandled rejection past this point — settings, the credential
    // store, the network client, schema parsing, or the save — must still
    // resolve to an outcome. Leaving this uncaught used to strand the
    // Describe screen's spinner forever.
    return { ok: false, message: 'Something went wrong estimating this workout. Try again.' }
  }
}
