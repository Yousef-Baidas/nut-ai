import type { ManualEntry } from './rows'

/**
 * Validation for the manual-entry form.
 *
 * Lives in `src/` rather than in the screen because Vitest's include covers
 * `apps/mobile/src/**` and not `apps/mobile/app/**` — logic worth testing goes
 * where it can be tested, and the screen stays thin wiring over it.
 *
 * The rules are deliberately few. This screen is the last resort when nothing
 * else in the app can identify a food, and a form that interrogates a user at
 * that moment is a form they abandon. Name and calories are required because a
 * row without either is not a meal; nothing may be negative; everything else is
 * optional, because a packet that prints only calories is a real packet.
 */

export interface ManualEntryForm {
  name: string
  grams: string
  kcal: string
  protein: string
  carbs: string
  fat: string
}

export type ManualEntryValidation =
  | { ok: true; value: ManualEntry }
  | { ok: false; error: string }

/** A blank optional field is zero. A field with junk in it is an error. */
function optionalNumber(raw: string): number | null {
  const t = raw.trim()
  if (t === '') return 0
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

export function validateManualEntry(form: ManualEntryForm): ManualEntryValidation {
  const name = form.name.trim()
  if (name === '') {
    return { ok: false, error: 'Give it a name — you will need to recognise it in the log.' }
  }

  const kcal = Number(form.kcal.trim())
  if (form.kcal.trim() === '' || !Number.isFinite(kcal)) {
    return { ok: false, error: 'Calories are required. Everything else is optional.' }
  }

  const protein = optionalNumber(form.protein)
  if (protein == null) return { ok: false, error: 'Protein is not a number.' }
  const carbs = optionalNumber(form.carbs)
  if (carbs == null) return { ok: false, error: 'Carbs are not a number.' }
  const fat = optionalNumber(form.fat)
  if (fat == null) return { ok: false, error: 'Fat is not a number.' }

  const gramsRaw = form.grams.trim()
  // No printed weight is the common case, not an error. 100 g is the same
  // fallback the portion sheet uses, so the two screens agree.
  const grams = gramsRaw === '' ? 100 : Number(gramsRaw)
  if (!Number.isFinite(grams)) return { ok: false, error: 'Grams is not a number.' }

  if (kcal < 0 || protein < 0 || carbs < 0 || fat < 0 || grams < 0) {
    return { ok: false, error: 'Numbers cannot be negative.' }
  }

  // A present-but-zero weight is a user mistake worth surfacing, not a silent
  // fallback to 100 g: it would scale every macro to zero and the review
  // screen could never recover from it by editing grams.
  if (grams === 0) {
    return { ok: false, error: 'Grams cannot be zero — leave it blank to default to 100 g.' }
  }

  return { ok: true, value: { name, grams, kcal, protein_g: protein, carbs_g: carbs, fat_g: fat } }
}
