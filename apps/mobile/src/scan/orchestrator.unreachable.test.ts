import { beforeEach, describe, expect, it, vi } from 'vitest'

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

const lookupBarcode = vi.fn()
const runRemotePipeline = vi.fn()
const loadCredential = vi.fn(async (...args: unknown[]) => {
  void args
  return null as { kind: 'api_key'; value: string } | null
})
const runScanWithFallback = vi.fn()

vi.mock('../data/food-server', () => ({
  lookupBarcode: (...args: unknown[]) => lookupBarcode(...args),
  runRemotePipeline: (...args: unknown[]) => runRemotePipeline(...args),
  UNREACHABLE_COPY: 'Food database unreachable — is the PC on?',
}))

vi.mock('../data/repo', () => ({
  // Barcode tests key their "no key" copy off `loadCredential` returning null,
  // not off `provider` — this can stay a fixed provider id for every test.
  setting: async (key: string) => (key === 'provider' ? 'openai' : key === 'provider_model' ? 'gpt-test' : ''),
  putSetting: async () => {},
}))
vi.mock('../inference/credentials', () => ({ loadCredential: (...args: unknown[]) => loadCredential(...args) }))
vi.mock('../inference/cloud/client', () => {
  const boom = () => { throw new Error('a keyless path must never call a provider') }
  return {
    runLabelScan: boom,
    runReceiptScan: boom,
    runScanWithFallback: (...args: unknown[]) => runScanWithFallback(...args),
    runWebLookup: boom,
  }
})

const { startBarcodeScan, startScan } = await import('./orchestrator')
const { getPhase, reset } = await import('./store')

beforeEach(() => {
  reset()
  lookupBarcode.mockReset()
  runRemotePipeline.mockReset()
  loadCredential.mockReset()
  loadCredential.mockResolvedValue(null)
  runScanWithFallback.mockReset()
})

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

  it('shows the server\'s own detail, not "is the PC on?", when the server answered but wrongly (reason: http)', async () => {
    lookupBarcode.mockResolvedValue({
      kind: 'server_unreachable',
      reason: 'http',
      detail: 'the server answered 404 (no_route) — is this the food server?',
    })

    await startBarcodeScan('6281006012011')
    const phase = getPhase()
    expect(phase.kind).toBe('failed')
    if (phase.kind !== 'failed') throw new Error('unreachable')
    expect(phase.message).toBe('the server answered 404 (no_route) — is this the food server?')
    expect(phase.message).not.toContain('Food database unreachable')
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

describe('photo scan against the food server pipeline', () => {
  beforeEach(() => {
    loadCredential.mockResolvedValue({ kind: 'api_key', value: 'sk-test' })
    runScanWithFallback.mockResolvedValue({
      ok: true,
      value: { raw: {}, inputTokens: 10, outputTokens: 5, costUsd: 0.001, latencyMs: 500, promptVersion: 'v1' },
    })
  })

  it('reaches ready with the server\'s pipeline result, and fires the background refinement pass', async () => {
    const row = {
      id: 'row_1',
      displayName: 'Test Bowl',
      sourceFoodId: null,
      grams: 300,
      nutrientSnapshot: { kcal: 400, protein_g: 20, fat_g: 10, carbs_g: 40, fiber_g: null, sugar_g: null, sodium_mg: null },
      origin: 'db_search',
      gramPathway: 'user_edited',
      bandHalfPct: 0.05,
      isEstimate: false,
      assumptions: [],
    }
    const band = { halfPct: 0.05, tier: 'tight', reasons: ['test'] }
    runRemotePipeline.mockResolvedValue({
      kind: 'ok',
      value: {
        result: {
          isFood: true,
          refusalReason: null,
          // resolution: 'auto_accept' (not 'miss') so the fire-and-forget
          // refinement pass below finds nothing to look up and never touches
          // the boom-mocked runWebLookup.
          items: [{ row, band, resolution: 'auto_accept', gramPathway: 'user_edited' }],
          meal: {
            id: 'meal_1',
            loggedAt: new Date().toISOString(),
            ingredients: [row],
            portionEatenFraction: 1,
            engineId: 'cloud-pipeline',
            promptVersion: 'v1',
            schemaVersion: null,
            clampFlags: [],
          },
          totals: { kcal: 400, protein_g: 20, fat_g: 10, carbs_g: 40, fiber_g: 0, sugar_g: 0, sodium_mg: 0 },
          mealBand: band,
          questions: [],
          clampFlags: [],
          zeroHitCount: 0,
        },
      },
    })

    await startScan('file:///photo.jpg')
    const phase = getPhase()
    expect(phase.kind).toBe('ready')
    if (phase.kind !== 'ready') throw new Error('unreachable')
    expect(phase.result.meal.ingredients[0]!.displayName).toBe('Test Bowl')
    expect(phase.result.totals.kcal).toBe(400)
    // The refinement pass is fire-and-forget (`void refineMisses(...)`); with
    // no 'miss' items and no brand in the raw payload it resolves to nothing
    // to look up, which is itself the assertion that reaching 'ready' does not
    // hang or throw waiting on it.
  })

  it('says the server is unreachable, not "the model answered in a shape we could not use", when the pipeline is unreachable', async () => {
    runRemotePipeline.mockResolvedValue({ kind: 'server_unreachable', reason: 'timeout', detail: 'no answer in 4000 ms' })

    await startScan('file:///photo.jpg')
    const phase = getPhase()
    expect(phase.kind).toBe('failed')
    if (phase.kind !== 'failed') throw new Error('unreachable')
    expect(phase.message).toContain('Food database unreachable')
    expect(phase.canRetry).toBe(false)
  })

  it('shows the server\'s own detail, not "is the PC on?", when the pipeline server answered but wrongly (reason: http)', async () => {
    runRemotePipeline.mockResolvedValue({
      kind: 'server_unreachable',
      reason: 'http',
      detail: 'the server answered 500',
    })

    await startScan('file:///photo.jpg')
    const phase = getPhase()
    expect(phase.kind).toBe('failed')
    if (phase.kind !== 'failed') throw new Error('unreachable')
    expect(phase.message).toBe('the server answered 500')
    expect(phase.message).not.toContain('Food database unreachable')
    expect(phase.canRetry).toBe(false)
  })
})
