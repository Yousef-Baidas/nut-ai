import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The Health sync wiring.
 *
 * #5's premise: the app asked for HealthKit permission during onboarding and
 * then never called readToday or writeMeal from anywhere. Either drop the ask
 * or build the feature — this is the feature, behind an explicit toggle.
 *
 * Every assertion here is about the WIRING, because that is what was missing.
 * The HealthKit calls themselves are mocked: they are iOS-native, they cannot
 * run under Node, and `healthkit.ts` already degrades to no-ops without a pod.
 */

const settings = new Map<string, string>()

vi.mock('../data/repo', () => ({
  setting: async (key: string, fallback = '') => settings.get(key) ?? fallback,
  putSetting: async (key: string, value: string) => { settings.set(key, value) },
}))

const requestPermissions = vi.fn()
const writeMeal = vi.fn()
const availability = vi.fn()

vi.mock('./healthkit', () => ({
  availability: (...a: unknown[]) => availability(...a),
  requestPermissions: (...a: unknown[]) => requestPermissions(...a),
  writeMeal: (...a: unknown[]) => writeMeal(...a),
}))

const { HEALTH_SYNC_KEY, disableHealthSync, enableHealthSync, healthSyncEnabled, syncLoggedMeal } =
  await import('./meal-sync')

const NOW = 1_754_100_000_000

function scanResult(kcal: number) {
  return {
    isFood: true,
    refusalReason: null,
    items: [],
    meal: {
      id: 'meal_1',
      loggedAt: new Date(NOW).toISOString(),
      ingredients: [{ displayName: 'Rice and chicken' }],
      portionEatenFraction: 1,
      engineId: 'saved-meal',
      promptVersion: null,
      schemaVersion: null,
      clampFlags: [],
    },
    totals: { kcal, protein_g: 34, fat_g: 6, carbs_g: 56, fiber_g: 1, sugar_g: 0, sodium_mg: 120 },
    mealBand: { halfPct: 0.05, tier: 'tight', reasons: [] },
    questions: [],
    clampFlags: [],
    zeroHitCount: 0,
  } as never
}

beforeEach(() => {
  settings.clear()
  requestPermissions.mockReset()
  writeMeal.mockReset()
  availability.mockReset()
  availability.mockResolvedValue('available')
  requestPermissions.mockResolvedValue({ prompted: true, canWrite: true, error: null })
  writeMeal.mockResolvedValue(true)
})

describe('healthSyncEnabled', () => {
  it('is off until someone turns it on — no eager permission ask anywhere', async () => {
    expect(await healthSyncEnabled()).toBe(false)
    expect(requestPermissions).not.toHaveBeenCalled()
  })
})

describe('enableHealthSync', () => {
  it('asks for permission exactly when the user enables the toggle', async () => {
    const r = await enableHealthSync()
    expect(requestPermissions).toHaveBeenCalledTimes(1)
    expect(r.enabled).toBe(true)
    expect(settings.get(HEALTH_SYNC_KEY)).toBe('1')
  })

  it('stays off when write access was refused — iOS does report writes', async () => {
    requestPermissions.mockResolvedValue({ prompted: true, canWrite: false, error: null })
    const r = await enableHealthSync()
    expect(r.enabled).toBe(false)
    expect(settings.get(HEALTH_SYNC_KEY)).toBeUndefined()
    expect(r.message).toMatch(/Health/)
  })

  it('stays off, without a prompt, where Health does not exist', async () => {
    availability.mockResolvedValue('not-ios')
    const r = await enableHealthSync()
    expect(requestPermissions).not.toHaveBeenCalled()
    expect(r.enabled).toBe(false)
  })

  it('stays off in Expo Go, where the pod is a stub', async () => {
    availability.mockResolvedValue('unavailable')
    const r = await enableHealthSync()
    expect(requestPermissions).not.toHaveBeenCalled()
    expect(r.enabled).toBe(false)
  })
})

describe('syncLoggedMeal', () => {
  it('writes one correlation per logged meal when the toggle is on', async () => {
    await enableHealthSync()
    expect(await syncLoggedMeal(scanResult(450), 77, NOW)).toBe(true)
    expect(writeMeal).toHaveBeenCalledTimes(1)
    expect(writeMeal).toHaveBeenCalledWith({
      id: '77',
      loggedAt: NOW,
      kcal: 450,
      proteinG: 34,
      carbsG: 56,
      fatG: 6,
      name: 'Rice and chicken',
    })
  })

  it('does nothing at all when the toggle is off', async () => {
    expect(await syncLoggedMeal(scanResult(450), 77, NOW)).toBe(false)
    expect(writeMeal).not.toHaveBeenCalled()
  })

  it('swallows a failed write — a Health hiccup must never fail a log', async () => {
    await enableHealthSync()
    writeMeal.mockRejectedValue(new Error('no pod'))
    await expect(syncLoggedMeal(scanResult(450), 77, NOW)).resolves.toBe(false)
  })
})

describe('disableHealthSync', () => {
  it('turns it off without touching HealthKit — iOS revocation lives in Settings', async () => {
    await enableHealthSync()
    writeMeal.mockClear()
    await disableHealthSync()
    expect(await healthSyncEnabled()).toBe(false)
    expect(await syncLoggedMeal(scanResult(450), 77, NOW)).toBe(false)
    expect(writeMeal).not.toHaveBeenCalled()
  })
})
