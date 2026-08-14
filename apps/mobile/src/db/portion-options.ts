import type { DbAdapter } from '@nutai/db-adapter'

/**
 * Household measures for the portion sheet.
 *
 * Deliberately NOT the same mapping as `portions.ts`. The gram ladder needs
 * four classified keys and drops anything it cannot classify, because a wrong
 * per_unit weight silently scales an estimate. A human picking a portion needs
 * the opposite: the free text as USDA wrote it, because "1 cup, sliced" is
 * self-explanatory to a reader and unclassifiable to a ladder.
 *
 * The 285 foods with no portion rows at all are not a failure case — the sheet
 * offers DEFAULT_PORTION_GRAMS and a free-form gram field, which is the same
 * affordance every other food gets.
 */

export interface PortionSourceRow {
  measure_unit: string | null
  modifier: string | null
  amount: number | null
  gram_weight: number
  is_fndds_default: number
}

export interface PortionOption {
  /** What the user reads, e.g. "1 cup, sliced". */
  label: string
  grams: number
}

/** What a food with no portion rows is offered. Also the sheet's fallback. */
export const DEFAULT_PORTION_GRAMS = 100

/** USDA's placeholder for "this row has no real unit". Never shown to a user. */
const PLACEHOLDER_UNITS = new Set(['undetermined', 'quantity not specified', ''])

function labelFor(row: PortionSourceRow): string | null {
  const unit = (row.measure_unit ?? '').trim().toLowerCase()
  const measure = PLACEHOLDER_UNITS.has(unit) ? '' : (row.measure_unit ?? '').trim()
  const modifier = (row.modifier ?? '').trim()
  const words = [measure, modifier].filter((w) => w !== '').join(', ')
  if (words === '') return null
  // The amount stays visible: "3 piece" must never read as one piece.
  const amount = row.amount == null || !Number.isFinite(row.amount) ? 1 : row.amount
  return `${Number(amount.toFixed(2))} ${words}`
}

export function toPortionOptions(rows: readonly PortionSourceRow[]): PortionOption[] {
  const out: PortionOption[] = []
  const seen = new Set<string>()
  // FNDDS defaults first — USDA's own idea of a serving is the best default.
  const ordered = [...rows].sort((a, b) => b.is_fndds_default - a.is_fndds_default)
  for (const row of ordered) {
    if (!Number.isFinite(row.gram_weight) || row.gram_weight <= 0) continue
    const label = labelFor(row)
    if (label == null) continue
    const key = `${label}|${row.gram_weight}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ label, grams: row.gram_weight })
  }
  return out
}

export async function portionOptionsFor(db: DbAdapter, foodId: string): Promise<PortionOption[]> {
  try {
    const rows = await db.all<PortionSourceRow>(
      `SELECT measure_unit, modifier, amount, gram_weight, is_fndds_default
         FROM food_portions
        WHERE food_id = ? AND gram_weight > 0`,
      [foodId],
    )
    return toPortionOptions(rows)
  } catch {
    // A corpus that did not ship is not worth a crash — the sheet still works.
    return []
  }
}
