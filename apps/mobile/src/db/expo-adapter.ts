import type { DbAdapter, RunResult, SqlValue } from '@nutai/db-adapter'
import * as SQLite from 'expo-sqlite'

/**
 * The expo-sqlite implementation of the shared DbAdapter interface.
 *
 * This file lives in apps/mobile and NOT in @nutai/db-adapter, deliberately.
 * `packages/*` must stay importable under bare Node with zero React Native
 * surface (docs/inherited-design.md II §4.1) so the eval harness can run the real pipeline; an
 * `import 'expo-sqlite'` in that package would fail the node-purity gate. This
 * app is the only place allowed to hold React Native imports.
 *
 * The Node implementation lives at @nutai/db-adapter/node. Both satisfy the same
 * interface, which is what makes "it worked in the harness" mean something on
 * device.
 */
class ExpoDbAdapter implements DbAdapter {
  constructor(private readonly db: SQLite.SQLiteDatabase) {}

  async all<T = Record<string, SqlValue>>(sql: string, params: readonly SqlValue[] = []): Promise<T[]> {
    return (await this.db.getAllAsync(sql, params as SQLite.SQLiteBindValue[])) as T[]
  }

  async get<T = Record<string, SqlValue>>(sql: string, params: readonly SqlValue[] = []): Promise<T | null> {
    return ((await this.db.getFirstAsync(sql, params as SQLite.SQLiteBindValue[])) as T | null) ?? null
  }

  async run(sql: string, params: readonly SqlValue[] = []): Promise<RunResult> {
    const r = await this.db.runAsync(sql, params as SQLite.SQLiteBindValue[])
    return { changes: r.changes, lastInsertRowId: r.lastInsertRowId }
  }

  async exec(sql: string): Promise<void> {
    await this.db.execAsync(sql)
  }

  async transaction<T>(fn: (tx: DbAdapter) => Promise<T>): Promise<T> {
    let result!: T
    await this.db.withTransactionAsync(async () => {
      result = await fn(this)
    })
    return result
  }

  async close(): Promise<void> {
    await this.db.closeAsync()
  }
}

/**
 * One adapter per database filename, for the life of the process.
 *
 * expo-sqlite dedupes `openDatabaseAsync(name)` calls onto a single shared
 * native connection per filename, but its teardown is not refcounted: when
 * ANY JS handle for that filename is garbage-collected, expo-sqlite releases
 * the shared native connection out from under every other handle, poisoning
 * every subsequent `prepareAsync` in the process (see
 * .superpowers/sdd/fix-live-defects-plan/npe-root-cause.md). Memoizing the
 * open *promise* — not the resolved value — means exactly one JS handle ever
 * exists per filename and no orphan handle can ever be collected, and it also
 * means concurrent first callers share the same in-flight open rather than
 * racing to open the file twice.
 */
const OPEN = new Map<string, Promise<DbAdapter>>()
function openOnce(name: string, open: () => Promise<DbAdapter>): Promise<DbAdapter> {
  let p = OPEN.get(name)
  if (!p) {
    p = open()
    OPEN.set(name, p)
  }
  return p
}

/** The writable user database. */
export function openUserDb(): Promise<DbAdapter> {
  return openOnce('user.db', async () => {
    const db = await SQLite.openDatabaseAsync('user.db')
    await db.execAsync('PRAGMA foreign_keys = ON;')
    return new ExpoDbAdapter(db)
  })
}
