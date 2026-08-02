import { LB_PER_KG } from '@nutai/goals'

/**
 * The display boundary for body measurements.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: kilograms and centimetres are the only
 * representations ever stored. `user_profile.height_cm`, `weights.weight_kg` and
 * every goal computation are metric. Imperial is a skin applied at render time
 * and removed again at input time — it never reaches the database.
 *
 * Before this file, three screens each did their own `kg * 2.20462` inline with
 * a hardcoded "lbs" label and no reference to the user's actual preference, so
 * choosing kg during onboarding changed nothing outside onboarding itself.
 *
 * `@nutai/goals` is the one place allowed to think in pounds, and only for rate:
 * the kcal-per-pound-of-body-mass model it derives from is defined that way. That
 * is why `formatRate` takes lb/week and converts outward, rather than the goals
 * package being made unit-aware.
 */

export type UnitSystem = 'imperial' | 'metric'

export const CM_PER_IN = 2.54
const IN_PER_FT = 12

/** What the weight unit is called in this system. */
export function weightUnitLabel(units: UnitSystem): string {
  return units === 'metric' ? 'kg' : 'lbs'
}

/** Stored kilograms -> the number to put in front of the user. */
export function displayWeight(kg: number, units: UnitSystem): number {
  return units === 'metric' ? kg : kg * LB_PER_KG
}

/** A number the user typed or scrolled to -> kilograms to store. */
export function storedWeightKg(value: number, units: UnitSystem): number {
  return units === 'metric' ? value : value / LB_PER_KG
}

/**
 * A weight with its unit, or an em dash.
 *
 * Null is a real and common state — no weigh-in yet, no goal set — and it must
 * render as "—" rather than "NaN lbs", which is what the inline `.toFixed(1)`
 * calls this replaces would produce.
 */
export function formatWeight(kg: number | null | undefined, units: UnitSystem): string {
  if (kg == null || !Number.isFinite(kg)) return '—'
  return `${displayWeight(kg, units).toFixed(1)} ${weightUnitLabel(units)}`
}

/**
 * A signed weight change. Direction is always explicit — "+1.2 kg" not "1.2 kg" —
 * because a change row without a sign is ambiguous at a glance.
 */
export function formatWeightDelta(kg: number | null | undefined, units: UnitSystem): string {
  if (kg == null || !Number.isFinite(kg)) return '—'
  const shown = displayWeight(kg, units)
  return `${shown > 0 ? '+' : ''}${shown.toFixed(1)} ${weightUnitLabel(units)}`
}

/**
 * True when a change is too small to be worth showing a direction for.
 *
 * Judged on the DISPLAYED number, not the stored one: if it renders as 0.0 it
 * must not also render an arrow claiming a direction.
 */
export function isNegligibleDelta(kg: number | null | undefined, units: UnitSystem): boolean {
  if (kg == null || !Number.isFinite(kg)) return true
  return Math.abs(displayWeight(kg, units)) < 0.05
}

/**
 * Rate of change. Input is lb/week because that is what `@nutai/goals` reports.
 *
 * Two decimals, not one: a sustainable metric rate is around 0.25 kg/wk, and one
 * decimal would round most real rates to 0.2 or 0.3 and make the number look
 * like it was not moving.
 */
export function formatRate(lbPerWeek: number | null | undefined, units: UnitSystem): string {
  if (lbPerWeek == null || !Number.isFinite(lbPerWeek)) return '—'
  const shown = units === 'metric' ? lbPerWeek / LB_PER_KG : lbPerWeek
  const label = units === 'metric' ? 'kg/wk' : 'lb/wk'
  return `${shown > 0 ? '+' : ''}${shown.toFixed(2)} ${label}`
}

/**
 * Height.
 *
 * Whole centimetres in metric — nobody tracks their height to a millimetre, and
 * a decimal there reads as false precision.
 *
 * The feet/inches path rounds inches FIRST and then carries, because rounding
 * after the split produces 5'12" for anything just under six foot.
 */
export function formatHeight(cm: number | null | undefined, units: UnitSystem): string {
  if (cm == null || !Number.isFinite(cm)) return '—'
  if (units === 'metric') return `${Math.round(cm)} cm`

  const totalInches = Math.round(cm / CM_PER_IN)
  const feet = Math.floor(totalInches / IN_PER_FT)
  const inches = totalInches % IN_PER_FT
  return `${feet}'${inches}"`
}
