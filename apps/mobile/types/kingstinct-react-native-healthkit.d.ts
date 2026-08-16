/**
 * Ambient types for '@kingstinct/react-native-healthkit'.
 *
 * The package itself is NOT installed: commit 9111415 removed it (Expo Go
 * cannot load the pod), and Metro aliases the specifier to
 * stubs/react-native-healthkit.js. The dynamic import in
 * src/health/healthkit.ts still names the real package so a dev build that
 * does install it works unchanged — this file declares only the v14 surface
 * that module consumes, so `tsc --noEmit` can check the call sites with the
 * package absent. If the real package is ever reinstalled, delete this file
 * and let its own declarations take over.
 */
declare module '@kingstinct/react-native-healthkit' {
  export interface QuantitySample {
    quantity?: number
  }

  export function isHealthDataAvailable(): boolean

  export function requestAuthorization(options: {
    toRead: readonly string[]
    toShare: readonly string[]
  }): Promise<unknown>

  export function authorizationStatusFor(identifier: string): number | string

  export function queryQuantitySamples(
    identifier: string,
    options?: unknown,
  ): Promise<QuantitySample[]>

  export function saveCorrelationSample(
    type: string,
    samples: unknown,
    start: Date,
    end: Date,
    metadata?: unknown,
  ): Promise<unknown>
}
