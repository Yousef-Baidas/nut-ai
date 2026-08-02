/**
 * Expo Go stub for `@kingstinct/react-native-healthkit`.
 *
 * WHY THIS EXISTS
 *
 * HealthKit is the only native dependency in this app that Expo Go does not
 * bundle. Everything else the app touches — camera, SQLite, SecureStore,
 * FileSystem, image manipulation — ships inside Expo Go already, so HealthKit
 * is the single thing standing between this repo and running on a device
 * without ever compiling Swift.
 *
 * HOW IT WORKS
 *
 * The module resolves successfully and exports one marker, `__expoGoStub`.
 * `src/health/healthkit.ts` checks for that marker and returns null, which is
 * the same value it returns when the pod is genuinely absent. Every downstream
 * function already handles null: `availability()` reports unavailable,
 * `readToday()` returns empties, `writeMeal()` returns false,
 * `requestPermissions()` returns a structured error.
 *
 * WHY NOT `throw` AT MODULE SCOPE
 *
 * That is what this file used to do, on the theory that `await import(...)`
 * would reject and the existing `catch` would fire. It does not work on device.
 * Metro's dev module loader wraps every module factory in `guardedLoadModule`:
 *
 *     if (!inGuard && global.ErrorUtils) {
 *       try { returnValue = loadModuleImplementation(moduleId, module, hint) }
 *       catch (e) { global.ErrorUtils.reportFatalError(e) }
 *       ...
 *     }
 *
 * A throwing factory is not rethrown to the caller — it is *converted* into
 * `ErrorUtils.reportFatalError`, which LogBox renders as a full-screen red
 * "Uncaught Error", and `metroRequire` then returns undefined. The caller's
 * try/catch never runs. Worse, `load()` is async, so it resumes on a fresh
 * microtask stack where `inGuard` is false — it takes the guarded path every
 * time. No amount of defensive code at the call site can catch this.
 *
 * WHY NOT A SET OF NO-OP EXPORTS
 *
 * A module of silent no-ops would load "successfully" and report zero steps,
 * which is indistinguishable from a real HealthKit permission denial — the UI
 * would claim Health is connected and simply always be empty. The marker keeps
 * the honesty of the original design (the app says Health is unavailable,
 * which is true) without the throw that breaks it.
 *
 * `isHealthDataAvailable` is defined as a safety net only, for any future
 * caller that reaches for the module without checking the marker first. Nothing
 * currently does.
 *
 * TO GO BACK TO A REAL BUILD: drop the alias in metro.config.js. This file is
 * inert unless that alias points at it, and nothing imports it directly.
 */

module.exports = {
  __expoGoStub: true,
  isHealthDataAvailable: () => false,
}
