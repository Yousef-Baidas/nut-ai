import { beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate, type DbAdapter } from '@nutai/db-adapter'
import { openMemoryDb } from '@nutai/db-adapter/node'
import type { OnboardingAnswers } from './store'

/**
 * Issue #27 — `db.close()` on `user.db`.
 *
 * expo-sqlite dedupes `openDatabaseAsync('user.db')` calls onto ONE shared
 * connection per filename. `persistOnboarding` used to close it after writing,
 * which does not just close ITS handle — it tears down the shared connection for
 * the whole process, so the very next `prepareAsync` anywhere (Today screen,
 * settings, a scan) throws. This pins that the adapter stays usable for a query
 * issued AFTER `persistOnboarding` returns.
 */

let db: DbAdapter
const NOW = 1_754_100_000_000

vi.mock('../db/expo-adapter', () => ({
  openUserDb: async () => db,
}))

vi.mock('expo-sqlite/kv-store', () => ({
  default: { setItem: async () => {} },
}))

const { persistOnboarding } = await import('./persist')

const ANSWERS: OnboardingAnswers = {
  sex: 'male',
  workoutsPerWeek: '3-5',
  birthYear: 1994,
  birthMonth: 6,
  birthDay: 15,
  heightCm: 178,
  weightKg: 80,
  units: 'metric',
  worksWithProfessional: false,
  goal: 'lose',
  desiredWeightKg: 75,
  blocker: 'consistency',
  dietStyle: 'balanced',
  accomplish: 'healthier',
  rolloverCalories: false,
  healthConnected: false,
  provider: 'none',
  providerModel: null,
}

const TARGET = {
  bmr: 1750,
  tdee: 2400,
  dailyDelta: 500,
  targetRaw: 1900,
  target: 1900,
  floor: 1500,
  floorApplied: false,
  floorExplanation: null,
  warnings: [],
}

const MACROS = { protein_g: 160, fat_g: 60, carbs_g: 180, carbsFloored: false }

describe('persistOnboarding leaves the DB usable afterward', () => {
  beforeEach(async () => {
    db = openMemoryDb()
    await db.exec('PRAGMA foreign_keys = ON;')
    await migrate(db, NOW)
  })

  it('does not close the shared connection — a query after persist still succeeds', async () => {
    await persistOnboarding(ANSWERS, TARGET, MACROS)

    // The bug: persist used to call db.close(), which for better-sqlite3 (and,
    // per the issue, for expo-sqlite's deduped connection) makes every
    // subsequent statement throw. A plain follow-up query is the whole test.
    const row = await db.get<{ sex: string }>('SELECT sex FROM user_profile WHERE id = 1')
    expect(row?.sex).toBe('male')
  })

  it('writes the settings the scan orchestrator reads, on the same live connection', async () => {
    await persistOnboarding(ANSWERS, TARGET, MACROS)

    const provider = await db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'provider'")
    expect(provider?.value).toBe('none')
  })
})
