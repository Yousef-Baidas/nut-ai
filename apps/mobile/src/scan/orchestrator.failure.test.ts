import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Issue #27 — the unhandled-rejection hang.
 *
 * `startScan`/`analyze` only guarded `preprocess`. A rejection thrown AFTER
 * preprocess — from the credential read, the provider client, or the local
 * pipeline — used to propagate out of the `void`-fired call with nothing to
 * catch it, leaving `phase.kind` stuck at 'analyzing' forever (the result
 * screen's progress spinner never resolves). Every start*Scan entry point must
 * land on the 'failed' phase instead, no matter where in its body the throw
 * happens.
 */

vi.mock('expo-image-manipulator', () => ({
  ImageManipulator: {
    manipulate: () => ({
      resize: () => {},
      renderAsync: async () => ({
        saveAsync: async () => ({ base64: 'ZmFrZQ==' }),
      }),
    }),
  },
  SaveFormat: { JPEG: 'jpeg' },
}))

vi.mock('../db/expo-adapter', () => ({
  openNutritionDb: async () => ({ get: async () => null, all: async () => [] }),
}))

vi.mock('../data/repo', () => ({
  setting: async (key: string) => (key === 'provider' ? 'openai' : 'gpt-test'),
  putSetting: async () => {},
}))

vi.mock('../inference/credentials', () => ({
  // The repro from the issue: the credential read throws instead of resolving
  // to null. `analyze` used to have no try/catch around this call at all.
  loadCredential: async () => {
    throw new Error('keychain read failed')
  },
}))

vi.mock('../inference/pathA/client', () => ({
  runLabelScan: async () => { throw new Error('should not be reached') },
  runReceiptScan: async () => { throw new Error('should not be reached') },
  runScanWithFallback: async () => { throw new Error('should not be reached') },
  runWebLookup: async () => { throw new Error('should not be reached') },
}))

const { startScan, startLabelScan, startReceiptScan } = await import('./orchestrator')
const { getPhase, reset } = await import('./store')

beforeEach(() => reset())

describe('a rejection after preprocess lands the failed phase, not a hang', () => {
  it('startScan: a throw from the credential read resolves to a failed phase', async () => {
    await startScan('file:///photo.jpg')

    const phase = getPhase()
    expect(phase.kind).toBe('failed')
    if (phase.kind !== 'failed') throw new Error('unreachable')
    expect(phase.canRetry).toBe(true)
    expect(phase.message.length).toBeGreaterThan(0)
  })

  it('startLabelScan: the same throw resolves to a failed phase, not analyzing', async () => {
    await startLabelScan('file:///label.jpg')

    const phase = getPhase()
    expect(phase.kind).toBe('failed')
  })

  it('startReceiptScan: the same throw resolves to a failed phase, not analyzing', async () => {
    await startReceiptScan('file:///receipt.jpg')

    const phase = getPhase()
    expect(phase.kind).toBe('failed')
  })
})
