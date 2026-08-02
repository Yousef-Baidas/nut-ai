import { describe, expect, it, vi } from 'vitest'

/**
 * The contract Metro imposes on the Expo Go HealthKit stub.
 *
 * WHY THIS TEST EXISTS: the stub originally threw at module scope, on the theory
 * that `load()`'s try/catch would swallow it and degrade to a no-Health build.
 * That theory is wrong on device. Metro's dev module loader wraps every module
 * factory in `guardedLoadModule`:
 *
 *     if (!inGuard && global.ErrorUtils) {
 *       try { returnValue = loadModuleImplementation(...) }
 *       catch (e) { global.ErrorUtils.reportFatalError(e) }   // <- swallowed
 *     }
 *
 * A throwing factory is therefore NOT rethrown to the caller — it is converted
 * into `reportFatalError`, which LogBox renders as a full-screen red "Uncaught
 * Error". The caller's catch never runs. And because `load()` is async, it
 * resolves on a fresh microtask stack where `inGuard` is false, so it takes the
 * guarded path every single time.
 *
 * Node does not have `guardedLoadModule`, so a throwing module here just rejects
 * normally and every downstream assertion would pass. That is exactly why the
 * discriminating assertion is "importing the stub does not throw" rather than
 * anything about availability: it is the one property Metro actually cares about
 * and the one Node can still verify.
 */

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))

describe('Expo Go HealthKit stub', () => {
  it('imports without throwing, because a throwing module becomes a LogBox fatal', async () => {
    await expect(import('../../stubs/react-native-healthkit.js')).resolves.toBeDefined()
  })

  it('marks itself so load() can tell it apart from a real pod', async () => {
    const stub = await import('../../stubs/react-native-healthkit.js')
    const mod = (stub as { default?: unknown }).default ?? stub
    expect((mod as { __expoGoStub?: boolean }).__expoGoStub).toBe(true)
  })

  it('degrades to an unavailable Health build instead of crashing', async () => {
    const { availability } = await import('./healthkit')
    await expect(availability()).resolves.toBe('unavailable')
  })
})
