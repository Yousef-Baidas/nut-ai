import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('expo-image-manipulator', () => ({
  ImageManipulator: { manipulate: () => { throw new Error('no image work here') } },
  SaveFormat: { JPEG: 'jpeg' },
}))

const lookupBarcode = vi.fn()
const runRemotePipeline = vi.fn()

vi.mock('../data/food-server', () => ({
  lookupBarcode: (...args: unknown[]) => lookupBarcode(...args),
  runRemotePipeline: (...args: unknown[]) => runRemotePipeline(...args),
  UNREACHABLE_COPY: 'Food database unreachable — is the PC on?',
}))

vi.mock('../data/repo', () => ({ setting: async () => '', putSetting: async () => {} }))
vi.mock('../inference/credentials', () => ({ loadCredential: async () => null }))
vi.mock('../inference/pathA/client', () => {
  const boom = () => { throw new Error('a keyless path must never call a provider') }
  return { runLabelScan: boom, runReceiptScan: boom, runScanWithFallback: boom, runWebLookup: boom }
})

const { startBarcodeScan } = await import('./orchestrator')
const { getPhase, reset } = await import('./store')

beforeEach(() => { reset(); lookupBarcode.mockReset(); runRemotePipeline.mockReset() })

describe('barcode scan against the food server', () => {
  it('logs the food when the server has the GTIN', async () => {
    lookupBarcode.mockResolvedValue({
      kind: 'ok',
      value: {
        food: { foodId: '2', name: 'Almarai Fresh Laban', brand: 'Almarai', energyKcal: 40,
          proteinG: 3.2, fatG: 1.5, carbG: 4.6, fiberG: null, sugarG: 4.6, sodiumMg: 50,
          servingSizeG: 200, servingDesc: '200 ml', license: 'ODbL-1.0', source: 'off' },
        portions: [],
      },
    })

    await startBarcodeScan('6281006012011')
    const phase = getPhase()
    expect(phase.kind).toBe('ready')
    if (phase.kind !== 'ready') throw new Error('unreachable')
    expect(phase.result.meal.ingredients[0]!.displayName).toBe('Almarai Fresh Laban')
    expect(phase.result.meal.ingredients[0]!.grams).toBe(200)
  })

  it('says the server is unreachable instead of claiming the barcode is unknown', async () => {
    lookupBarcode.mockResolvedValue({ kind: 'server_unreachable', reason: 'timeout', detail: 'no answer in 4000 ms' })

    await startBarcodeScan('6281006012011')
    const phase = getPhase()
    expect(phase.kind).toBe('failed')
    if (phase.kind !== 'failed') throw new Error('unreachable')
    expect(phase.message).toContain('Food database unreachable')
    expect(phase.canRetry).toBe(false)
  })

  it('keeps the honest miss copy when the server answers 404 and there is no key', async () => {
    lookupBarcode.mockResolvedValue({ kind: 'not_found' })

    await startBarcodeScan('0000000000000')
    const phase = getPhase()
    expect(phase.kind).toBe('failed')
    if (phase.kind !== 'failed') throw new Error('unreachable')
    expect(phase.message).toContain('not in your food database')
    expect(phase.message).not.toContain('unreachable')
  })

  it('never spins forever — every branch leaves analyzing', async () => {
    lookupBarcode.mockResolvedValue({ kind: 'server_unreachable', reason: 'network', detail: 'down' })
    await startBarcodeScan('6281006012011')
    expect(getPhase().kind).not.toBe('analyzing')
  })
})
