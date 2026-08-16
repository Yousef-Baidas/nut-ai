import { UNREACHABLE_COPY, type FoodServerResult, type Health } from './food-server'

/** A server address must parse as an absolute http(s) URL, not just a non-empty string. */
export function isValidServerUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

export interface ServerTestResult {
  /** Whether the address was actually written to settings. */
  persisted: boolean
  status: string
}

/**
 * The whole "Save and test" button, minus React — testable without rendering
 * a screen.
 *
 * Two failure modes this exists to close off:
 *
 * 1. A scheme-less typo (`100.96.136.73:7100`, missing `http://`) used to be
 *    persisted BEFORE it was tested, bricking food search app-wide and then
 *    reporting the brick as "is the PC on?" — as if the PC, not the typo, were
 *    at fault. `isValidServerUrl` runs first; nothing is saved on a bad address.
 * 2. A rejecting `setFoodServerUrl` (or `fetchHealth`, though that one already
 *    resolves rather than throws) used to leave the caller's `busy` flag
 *    stranded true — an unhandled rejection outside any try/catch. This
 *    function never throws; every path resolves to a `ServerTestResult`.
 */
export async function runServerTest(
  url: string,
  deps: {
    setFoodServerUrl: (url: string) => Promise<void>
    fetchHealth: () => Promise<FoodServerResult<Health>>
  },
): Promise<ServerTestResult> {
  if (!isValidServerUrl(url)) {
    return { persisted: false, status: 'That is not a valid address' }
  }
  try {
    await deps.setFoodServerUrl(url)
  } catch (err) {
    return { persisted: false, status: err instanceof Error ? err.message : 'Could not save that address' }
  }
  const r = await deps.fetchHealth()
  if (r.kind !== 'ok') return { persisted: true, status: UNREACHABLE_COPY }
  return {
    persisted: true,
    status:
      `${r.value.foods.toLocaleString()} foods · ${r.value.barcodes.toLocaleString()} barcodes` +
      (r.value.schemaMismatch ? ' · the server and app versions may differ' : ''),
  }
}
