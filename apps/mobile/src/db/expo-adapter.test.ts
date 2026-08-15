import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * NPE root-cause fix (fix-live-defects-plan/npe-root-cause.md).
 *
 * expo-sqlite dedupes `openDatabaseAsync(name)` calls onto ONE shared native
 * connection, but does not refcount teardown: when ANY orphaned JS handle for
 * that filename is garbage-collected, expo-sqlite tears down the shared native
 * connection out from under every other handle, poisoning every subsequent
 * `prepareAsync` in the process. The fix is to hold exactly one JS handle per
 * filename for the life of the process, by memoizing the open *promise* (not
 * the resolved value, so concurrent first callers never race into opening the
 * file twice).
 */

let openCount = 0

vi.mock('expo-sqlite', () => {
  return {
    openDatabaseAsync: vi.fn(async (name: string) => {
      openCount++
      return {
        __name: name,
        execAsync: vi.fn(async () => {}),
        getAllAsync: vi.fn(async () => []),
        getFirstAsync: vi.fn(async () => null),
        runAsync: vi.fn(async () => ({ changes: 0, lastInsertRowId: 0 })),
        withTransactionAsync: vi.fn(async (fn: () => Promise<void>) => fn()),
        closeAsync: vi.fn(async () => {}),
      }
    }),
    importDatabaseFromAssetAsync: vi.fn(async () => {}),
  }
})

vi.mock('../../assets/nutrition.db', () => ({ default: 'nutrition-db-asset' }))

beforeEach(() => {
  vi.resetModules()
  openCount = 0
})

describe('openUserDb', () => {
  it('returns the same instance on every call', async () => {
    const { openUserDb } = await import('./expo-adapter')
    const a = await openUserDb()
    const b = await openUserDb()
    expect(a).toBe(b)
    expect(openCount).toBe(1)
  })

  it('memoizes the in-flight promise so concurrent first callers never open twice', async () => {
    const { openUserDb } = await import('./expo-adapter')
    const [a, b] = await Promise.all([openUserDb(), openUserDb()])
    expect(a).toBe(b)
    expect(openCount).toBe(1)
  })
})

describe('openNutritionDb', () => {
  it('returns the same instance on every call', async () => {
    const { openNutritionDb } = await import('./expo-adapter')
    const a = await openNutritionDb()
    const b = await openNutritionDb()
    expect(a).toBe(b)
    expect(openCount).toBe(1)
  })

  it('memoizes the in-flight promise so concurrent first callers never open twice', async () => {
    const { openNutritionDb } = await import('./expo-adapter')
    const [a, b] = await Promise.all([openNutritionDb(), openNutritionDb()])
    expect(a).toBe(b)
    expect(openCount).toBe(1)
  })
})

describe('openUserDb vs openNutritionDb', () => {
  it('are distinct instances backed by distinct filenames', async () => {
    const { openUserDb, openNutritionDb } = await import('./expo-adapter')
    const user = await openUserDb()
    const nutrition = await openNutritionDb()
    expect(user).not.toBe(nutrition)
    expect(openCount).toBe(2)
  })
})
