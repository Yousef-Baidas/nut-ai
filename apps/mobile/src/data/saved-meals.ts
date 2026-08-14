import type { DbAdapter } from '@nutai/db-adapter'
import type { IngredientRow } from '@nutai/core-schema'

/**
 * Saved meals.
 *
 * `saved_meals` has existed since the first migration and, until now, nothing
 * ever wrote to it — the screen read an empty table and the backup counted
 * zero rows forever.
 *
 * What gets stored is the CORRECTED ingredient array, snapshots included, not a
 * food name to re-resolve. That is what makes relogging free: zero network
 * requests, zero clarifying chips, and numbers identical to the day they were
 * fixed. It also means a saved meal keeps working after the corpus is rebuilt
 * and after a provider key is removed.
 *
 * Every function takes the handle rather than calling `db()` itself, so the
 * whole module runs against `openMemoryDb()` in tests — the same shape
 * `backup-core.ts` uses.
 */

export interface SavedMealRow {
  id: number
  name: string
  use_count: number
  items_json: string
}

/** A blob we cannot read is an empty meal, never a crash on a list screen. */
export function parseSavedItems(json: string): IngredientRow[] {
  try {
    const parsed: unknown = JSON.parse(json)
    return Array.isArray(parsed) ? (parsed as IngredientRow[]) : []
  } catch {
    return []
  }
}

export async function saveMeal(
  h: DbAdapter,
  name: string,
  items: readonly IngredientRow[],
  now: number,
): Promise<number> {
  const trimmed = name.trim()
  if (trimmed === '') throw new Error('A saved meal needs a name.')
  const r = await h.run(
    `INSERT INTO saved_meals (name, items_json, use_count, last_used_at, created_at)
     VALUES (?,?,0,NULL,?)`,
    [trimmed, JSON.stringify(items), now],
  )
  return Number(r.lastInsertRowId)
}

export async function listSavedMeals(h: DbAdapter): Promise<SavedMealRow[]> {
  return h.all<SavedMealRow>(
    `SELECT id, name, use_count, items_json
       FROM saved_meals
      ORDER BY use_count DESC, last_used_at DESC, id DESC`,
  )
}

/** Relogging is the only thing that moves the counter. Saving is not using. */
export async function touchSavedMeal(h: DbAdapter, id: number, now: number): Promise<void> {
  await h.run(
    'UPDATE saved_meals SET use_count = use_count + 1, last_used_at = ? WHERE id = ?',
    [now, id],
  )
}

export async function deleteSavedMeal(h: DbAdapter, id: number): Promise<void> {
  await h.run('DELETE FROM saved_meals WHERE id = ?', [id])
}
