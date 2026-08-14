import type { ScanResult } from '@nutai/pipeline'
import { putSetting, setting } from '../data/repo'
import { availability, requestPermissions, writeMeal } from './healthkit'

/**
 * Meal → Apple Health, behind an explicit toggle.
 *
 * #5's finding: onboarding presented the HealthKit permission sheet and then
 * nothing in the app ever called `readToday` or `writeMeal`. Asking for access
 * to a feature that does not exist is the worst of both worlds — it spends the
 * user's trust and delivers nothing. The ask now happens at the moment the user
 * turns the feature on, and only then.
 *
 * WRITE access is the one authorization fact iOS reports truthfully
 * (`healthkit.ts:109`), so the toggle can be honest about whether it worked.
 * Everything below no-ops silently off iOS, in Expo Go (where Metro aliases the
 * pod to a stub), and after a denial — a Health hiccup must never fail a log.
 */

export const HEALTH_SYNC_KEY = 'health.sync_meals'

export async function healthSyncEnabled(): Promise<boolean> {
  return (await setting(HEALTH_SYNC_KEY)) === '1'
}

export async function enableHealthSync(): Promise<{ enabled: boolean; message: string }> {
  const avail = await availability()
  if (avail !== 'available') {
    return {
      enabled: false,
      message:
        avail === 'not-ios'
          ? 'Apple Health is iOS only.'
          : 'Apple Health is not available in this build. It needs a development build, not Expo Go.',
    }
  }

  const res = await requestPermissions()
  if (!res.canWrite) {
    return {
      enabled: false,
      message: res.error
        ? res.error
        : 'Health did not grant write access. Allow it under Settings → Privacy & Security → Health.',
    }
  }

  await putSetting(HEALTH_SYNC_KEY, '1')
  return { enabled: true, message: 'Meals you log from now on will be written to Health.' }
}

/**
 * Turning it off does NOT revoke the iOS permission — an app cannot, and
 * pretending otherwise would be a lie. It stops us writing, which is the part
 * we control; the Profile screen links to Settings for the rest.
 */
export async function disableHealthSync(): Promise<void> {
  await putSetting(HEALTH_SYNC_KEY, '0')
}

/**
 * Called after a meal is logged, with the row id the log returned.
 *
 * The id doubles as the HKExternalUUID inside `writeMeal`, which is what makes
 * the write idempotent: re-syncing a day cannot duplicate a meal.
 */
export async function syncLoggedMeal(
  result: ScanResult,
  mealId: number,
  now: number,
): Promise<boolean> {
  if (!(await healthSyncEnabled())) return false
  try {
    return await writeMeal({
      id: String(mealId),
      loggedAt: now,
      kcal: result.totals.kcal,
      proteinG: result.totals.protein_g,
      carbsG: result.totals.carbs_g,
      fatG: result.totals.fat_g,
      name: result.meal.ingredients[0]?.displayName ?? 'Meal',
    })
  } catch {
    // A Health failure is not a logging failure. The meal is already in SQLite.
    return false
  }
}
