import { db, localDate, weightHistory } from '../data/repo'

/**
 * The single write path for `exercise_entries` — every Log Exercise screen
 * (Run/Weight lifting, Describe, Manual) funnels through `saveEntry`, and the
 * Run/Weight lifting and Describe paths both need `latestWeightKg`. Two
 * screens each carrying their own copy of the raw INSERT would silently
 * diverge the next time the schema migrates; this is the one copy.
 */

export async function latestWeightKg(): Promise<number> {
  const points = await weightHistory()
  return points[points.length - 1]?.weightKg ?? 80
}

export async function saveEntry(name: string, kcal: number): Promise<void> {
  const now = Date.now()
  const h = await db()
  await h.run(
    `INSERT INTO exercise_entries (local_date, name, kcal, provenance, external_id, logged_at)
     VALUES (?,?,?,'manual',NULL,?)`,
    [localDate(now), name, kcal, now],
  )
}
