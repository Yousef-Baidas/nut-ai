import * as ImageManipulator from 'expo-image-manipulator'
import { bandTier, type Band } from '@nutai/confidence'
import {
  LabelPayloadZ,
  ReceiptPayloadZ,
  VISION_WIRE_SCHEMA,
  WebLookupResultZ,
  type IngredientRow,
  type LoggedMeal,
} from '@nutai/core-schema'
import {
  anthropicWireSchema,
  cheapestModel,
  geminiWireSchema,
  openAiWireSchema,
  LABEL_SCAN_PROMPT_VERSION,
  RECEIPT_SCAN_PROMPT_VERSION,
  type ProviderId,
} from '@nutai/prompt'
import { recomputeAfterEdit, validatePayload, type ScanResult } from '@nutai/pipeline'
import { UNREACHABLE_COPY, lookupBarcode, runRemotePipeline } from '../data/food-server'
import { setting } from '../data/repo'
import { loadCredential, type StoredCredential } from '../inference/credentials'
import { runLabelScan, runReceiptScan, runScanWithFallback, runWebLookup } from '../inference/cloud/client'
import { applyWebOption, getPhase, setPhase, setWebLookup } from './store'
import {
  bandReasonFor,
  corpusRowFromResolved,
  resolutionFor,
  rowFromCorpusFood,
  rowFromManualEntry,
  scaleRows,
  type CorpusFoodRow,
  type ManualEntry,
} from './rows'

export type { ManualEntry } from './rows'

/**
 * The scan orchestrator — capture in, ready-to-review meal out.
 *
 * This file is the reason the shutter can navigate IMMEDIATELY: everything
 * here runs behind the result screen's progress states, and every exit is a
 * named phase — never a silent dead end. The sequence:
 *
 *   preparing    resize + EXIF-bake + base64 (local, fast)
 *   identifying  the one model call — the only stage that owns wall-clock time
 *   matching     the deterministic pipeline, run on the PC food server
 *   ready        review screen, editable rows
 *   (background) web-search refinement for items the corpus missed
 *
 * D16 note: the refinement stage transcribes published nutrition facts with a
 * source URL. It replaces AI-estimate rows — the weakest rows on the screen —
 * with cited label data, and never touches a row the database already matched.
 */

/** Kept for retry, so a network blip does not re-run image preprocessing. */
let lastCapture: { photoUri: string; base64: string } | null = null

function wireSchemaFor(provider: ProviderId): Record<string, unknown> {
  if (provider === 'anthropic') return anthropicWireSchema(VISION_WIRE_SCHEMA)
  if (provider === 'openai') return openAiWireSchema(VISION_WIRE_SCHEMA)
  return geminiWireSchema(VISION_WIRE_SCHEMA)
}

async function preprocess(photoUri: string): Promise<string> {
  const ctx = ImageManipulator.ImageManipulator.manipulate(photoUri)
  // Resize BEFORE encoding — the order is what bounds memory, not the format.
  ctx.resize({ width: 1024 })
  const image = await ctx.renderAsync()
  const saved = await image.saveAsync({
    compress: 0.8,
    format: ImageManipulator.SaveFormat.JPEG,
    base64: true,
  })
  if (!saved.base64) throw new Error('preprocess produced no base64')
  return saved.base64
}

export async function startScan(photoUri: string): Promise<void> {
  setPhase({ kind: 'analyzing', photoUri, stage: 'preparing' })

  let base64: string
  try {
    base64 = await preprocess(photoUri)
  } catch {
    setPhase({
      kind: 'failed',
      photoUri,
      message: 'Could not read the photo. Try taking it again.',
      canRetry: false,
    })
    return
  }

  lastCapture = { photoUri, base64 }
  await analyze(photoUri, base64)
}

export async function retryScan(): Promise<void> {
  if (!lastCapture) return
  const { photoUri, base64 } = lastCapture
  setPhase({ kind: 'analyzing', photoUri, stage: 'identifying' })
  await analyze(photoUri, base64)
}

interface AnalyzeOpts {
  /** Prepended context for a Fix Result pass. */
  fixBlock?: string
  /** Prior scan's meta, so the ledger bills one meal for both calls. */
  priorMeta?: { inputTokens: number; outputTokens: number; costUsd: number } | null
  /** Portion fraction to carry across a fix — user answers survive re-analysis. */
  keepFraction?: number
}

async function analyze(photoUri: string, base64: string, opts: AnalyzeOpts = {}): Promise<void> {
  try {
    await analyzeUnguarded(photoUri, base64, opts)
  } catch {
    // ANY unhandled rejection past this point (a throw from settings, the
    // credential store, the network client, or the local pipeline) must still
    // land on a named phase. Leaving `analyzing` on the table is the bug this
    // guard exists to close — an unhandled rejection here used to strand the
    // result screen on its progress spinner forever.
    setPhase({
      kind: 'failed',
      photoUri,
      message: 'Something went wrong analyzing this photo. Try again.',
      canRetry: true,
    })
  }
}

async function analyzeUnguarded(
  photoUri: string,
  base64: string,
  opts: AnalyzeOpts,
): Promise<void> {
  const provider = (await setting('provider')) as ProviderId | 'none' | ''
  if (!provider || provider === 'none') {
    setPhase({
      kind: 'failed',
      photoUri,
      message:
        'Photo scans need an API key. Add one in Profile. Text search and manual entry work without one.',
      canRetry: false,
      failureKind: 'no-key',
    })
    return
  }

  const credential = await loadCredential(provider)
  if (!credential) {
    setPhase({
      kind: 'failed',
      photoUri,
      message: 'Your saved key is missing. Re-enter it in Profile.',
      canRetry: false,
      failureKind: 'key-invalid',
    })
    return
  }

  const model = (await setting('provider_model')) || cheapestModel(provider).id

  setPhase({ kind: 'analyzing', photoUri, stage: 'identifying' })
  const outcome = await runScanWithFallback({
    provider,
    model,
    credential,
    imagesBase64: [base64],
    localSignalsBlock: opts.fixBlock ?? '',
    jsonSchema: wireSchemaFor(provider),
  })

  if (!outcome.ok) {
    setPhase({
      kind: 'failed',
      photoUri,
      message: outcome.error.message,
      canRetry: outcome.error.retryable,
      failureKind: outcome.error.kind,
    })
    return
  }

  setPhase({ kind: 'analyzing', photoUri, stage: 'matching' })

  let result: ScanResult | null = null
  let pipelineUnreachable = false
  let pipelineUnreachableMessage: string | null = null
  const remote = await runRemotePipeline({
    raw: outcome.value.raw,
    path: 'cloud',
    now: Date.now(),
  })
  if (remote.kind === 'ok') {
    result = remote.value.result as ScanResult
  } else {
    // The deterministic stages live on the PC now. Saying "the model answered in
    // a shape we could not use" here would blame the wrong component.
    pipelineUnreachable = remote.kind === 'server_unreachable'
    if (remote.kind === 'server_unreachable') {
      // reason 'http' means the server ANSWERED — a live host that isn't the
      // food server, a 500, or a version-skewed server missing /pipeline. That
      // is not "is the PC on?"; show what it actually said (search-outcome.ts
      // sets the same precedent for /search).
      pipelineUnreachableMessage =
        remote.reason === 'http'
          ? remote.detail
          : `${UNREACHABLE_COPY} The photo was analyzed, but the food database could not be reached to price it. Nothing was logged.`
    }
    result = null
  }

  if (!result) {
    setPhase({
      kind: 'failed',
      photoUri,
      message:
        pipelineUnreachableMessage ??
        'The model answered in a shape we could not use. This one is on us — try once more.',
      canRetry: !pipelineUnreachable,
    })
    return
  }

  if (!result.isFood) {
    setPhase({
      kind: 'failed',
      photoUri,
      message: result.refusalReason || 'That photo does not look like food.',
      canRetry: false,
    })
    return
  }

  if (opts.keepFraction != null && opts.keepFraction !== 1) {
    result.meal.portionEatenFraction = opts.keepFraction
    const re = recomputeAfterEdit(result.meal, result.items.map((i) => i.band))
    result = { ...result, totals: re.totals, mealBand: re.mealBand }
  }

  setPhase({
    kind: 'ready',
    photoUri,
    result,
    bands: result.items.map((i) => i.band),
    meta: {
      provider,
      model,
      inputTokens: outcome.value.inputTokens + (opts.priorMeta?.inputTokens ?? 0),
      outputTokens: outcome.value.outputTokens + (opts.priorMeta?.outputTokens ?? 0),
      costUsd: outcome.value.costUsd + (opts.priorMeta?.costUsd ?? 0),
      promptVersion: outcome.value.promptVersion,
    },
    webLookups: {},
  })

  // Fire-and-forget: refinement upgrades rows underneath the review screen.
  void refineMisses(result, outcome.value.raw, provider, model, credential)
}

/** How many corpus misses we will pay to look up per scan. */
const MAX_LOOKUPS_PER_SCAN = 2

/**
 * Background refinement: every item the corpus missed gets one shot at being
 * upgraded from "AI estimate" to "transcribed from the brand's published
 * nutrition facts". One option auto-applies; several become a question card.
 */
async function refineMisses(
  result: ScanResult,
  rawPayload: unknown,
  provider: ProviderId,
  model: string,
  credential: StoredCredential,
): Promise<void> {
  const payload = validatePayload(rawPayload)
  // Two triggers: the corpus missed entirely, or the model saw a BRAND (a logo
  // counts — golden arches on the wrapper). A branded item that matched some
  // generic corpus row still deserves the brand's own published numbers.
  const misses = result.items
    .map((item, index) => ({ item, index }))
    .filter(
      ({ item, index }) =>
        item.resolution === 'miss' || payload?.items[index]?.brand != null,
    )
    .slice(0, MAX_LOOKUPS_PER_SCAN)

  await Promise.all(
    misses.map(async ({ item, index }) => {
      const rowId = item.row.id
      setWebLookup(rowId, { status: 'running' })

      const source = payload?.items[index]
      const lookup = await runWebLookup(
        provider,
        {
          model,
          itemName: source?.name ?? item.row.displayName,
          brand: source?.brand ?? null,
          visualContext: source?.legible_label_text ?? null,
        },
        credential,
      )

      if (!lookup.ok) {
        setWebLookup(rowId, { status: 'failed' })
        return
      }
      const parsed = WebLookupResultZ.safeParse(lookup.raw)
      if (!parsed.success || !parsed.data.found || parsed.data.options.length === 0) {
        setWebLookup(rowId, { status: 'failed' })
        return
      }

      setWebLookup(rowId, { status: 'done', result: parsed.data })
      // Unambiguous single match: apply it. The row visibly upgrades from
      // amber AI-estimate to a cited source — that is the payoff moment.
      if (parsed.data.options.length === 1 && !parsed.data.question) {
        applyWebOption(rowId, parsed.data.options[0]!, parsed.data.source_url)
      }
    }),
  )
}

/**
 * Fix Result — free-text correction with a minimal-delta contract.
 *
 * The re-analysis is seeded with the CURRENT ingredient state (including every
 * edit the user already made), and the instruction is explicit that items the
 * correction does not implicate must come back byte-identical. This is what
 * prevents the incumbent's canonical failure: re-analysis that deletes the
 * corrections you already made. Cost is merged so the ledger bills one meal.
 */
export async function fixScan(note: string): Promise<void> {
  const phase = getPhase()
  if (phase.kind !== 'ready' || !lastCapture) return

  const rows = phase.result.meal.ingredients
    .map((r) => `- ${r.displayName}: ${Math.round(r.grams)} g`)
    .join('\n')
  const fixBlock = [
    'FIX REQUEST — the user reviewed your previous analysis of this exact photo and asked for a correction.',
    'The currently accepted analysis:',
    rows,
    `The user's correction: "${note.trim()}"`,
    'Re-emit the FULL JSON payload with ONLY the changes the correction requires.',
    'Every item and gram figure the correction does not implicate must return IDENTICAL to the accepted analysis above — do not re-estimate what the user did not question.',
  ].join('\n')

  const keepFraction = phase.result.meal.portionEatenFraction
  const priorMeta = phase.meta
  const photoUri = phase.photoUri ?? lastCapture.photoUri

  setPhase({ kind: 'analyzing', photoUri, stage: 'identifying' })
  await analyze(photoUri, lastCapture.base64, { fixBlock, priorMeta, keepFraction })
}

// ---------------------------------------------------------------------------
// Barcode and label — the zero-and-near-zero-cost paths
// ---------------------------------------------------------------------------

/**
 * Build a ready phase from rows whose numbers came off a package — a barcode
 * row or a transcribed label. No model grams, no repair questions: the printed
 * serving IS the portion, and the only remaining uncertainty is label rounding.
 */
function readyFromRows(
  rows: IngredientRow[],
  photoUri: string | null,
  engineId: string,
  promptVersion: string | null,
  webLookups: Record<string, import('./store').WebLookupState> = {},
): void {
  const meal: LoggedMeal = {
    id: `meal_${Date.now()}`,
    loggedAt: new Date().toISOString(),
    ingredients: rows,
    portionEatenFraction: 1,
    engineId,
    promptVersion,
    schemaVersion: null,
    clampFlags: [],
  }
  const bands: Band[] = rows.map((r) => ({
    halfPct: r.bandHalfPct,
    // Derived, mirroring the same threshold function the engine bands use
    // (`bandTier` in @nutai/confidence) — 0 half-width is 'none', never a
    // hardcoded 'tight' that overstates a zero-width manual-entry band or
    // understates a wide relogged vision-model band.
    tier: bandTier(r.bandHalfPct),
    reasons: [bandReasonFor(r.origin, r.dbSource)],
  }))
  const { totals, mealBand } = recomputeAfterEdit(meal, bands)
  const result: ScanResult = {
    isFood: true,
    refusalReason: null,
    items: rows.map((row, i) => ({
      row,
      band: bands[i]!,
      resolution: resolutionFor(row.origin),
      gramPathway: row.gramPathway,
    })),
    meal,
    totals,
    mealBand,
    questions: [],
    clampFlags: [],
    zeroHitCount: 0,
  }
  setPhase({ kind: 'ready', photoUri, result, bands, meta: null, webLookups })
}

/**
 * Barcode: a food-server GTIN hit costs no model call — one LAN request to the
 * PC. A miss falls to one web search when a key exists, and to a clear pointer
 * at the label scanner when it does not; the server being unreachable is its
 * own named outcome, distinct from a genuine miss.
 */
export async function startBarcodeScan(gtin: string): Promise<void> {
  try {
    await startBarcodeScanUnguarded(gtin)
  } catch {
    // canRetry:false, deliberately, like every other failure branch in this
    // function (below): "Try again" always calls retryScan(), which re-runs
    // the PHOTO pipeline (analyze) against lastCapture — a barcode scan never
    // sets lastCapture, so that would either no-op or, worse, re-present an
    // unrelated earlier photo as this barcode's result. canRetry:false routes
    // the screen to Search / Enter-by-hand instead.
    setPhase({
      kind: 'failed',
      photoUri: '',
      message: 'Something went wrong looking up this barcode. Try again.',
      canRetry: false,
    })
  }
}

async function startBarcodeScanUnguarded(gtin: string): Promise<void> {
  setPhase({ kind: 'analyzing', photoUri: '', stage: 'matching' })

  const found = await lookupBarcode(gtin)

  if (found.kind === 'server_unreachable') {
    // reason 'http' means the server ANSWERED — a live host that isn't the
    // food server, a 500, or a version-skewed server missing /barcode. Show
    // what it actually said instead of blaming the PC being off (same
    // precedent as search-outcome.ts:33-36 for the search screen).
    setPhase({
      kind: 'failed',
      photoUri: '',
      message:
        found.reason === 'http'
          ? found.detail
          : `${UNREACHABLE_COPY} Nothing was looked up. Search by name once it is back, or enter this food by hand.`,
      canRetry: false,
    })
    return
  }

  if (found.kind === 'ok' && found.value.food.energyKcal != null) {
    const food = found.value.food
    const grams = food.servingSizeG ?? 100
    readyFromRows(
      [
        {
          ...rowFromCorpusFood(corpusRowFromResolved(food), grams, Date.now()),
          origin: 'barcode',
          gramPathway: 'packaged_exact',
        },
      ],
      null,
      'barcode-local',
      null,
    )
    return
  }

  // Not in the corpus. One web search, if we have the means.
  const provider = (await setting('provider')) as ProviderId | 'none' | ''
  const credential = provider && provider !== 'none' ? await loadCredential(provider) : null
  if (!credential || !provider || provider === 'none') {
    setPhase({
      kind: 'failed',
      photoUri: '',
      message:
        'This barcode is not in your food database. Search for the food by name, or enter it by hand. (Label reading needs an API key.)',
      canRetry: false,
    })
    return
  }

  const model = (await setting('provider_model')) || cheapestModel(provider).id
  const lookup = await runWebLookup(
    provider,
    { model, itemName: `the packaged food product with barcode (GTIN/UPC/EAN) ${gtin}`, brand: null },
    credential,
  )
  const parsed = lookup.ok ? WebLookupResultZ.safeParse(lookup.raw) : null
  const opt = parsed?.success && parsed.data.found ? parsed.data.options[0] : undefined
  if (!opt) {
    setPhase({
      kind: 'failed',
      photoUri: '',
      message:
        'Could not find this barcode in your food database or online. Search for the food by name, or enter it by hand.',
      canRetry: false,
    })
    return
  }

  const grams = opt.serving_g ?? 100
  const per100 = grams > 0 ? 100 / grams : 0
  readyFromRows(
    [
      {
        id: `row_${Date.now()}`,
        displayName: opt.label,
        sourceFoodId: null,
        grams,
        nutrientSnapshot: {
          kcal: opt.calories_kcal * per100,
          protein_g: opt.protein_g * per100,
          fat_g: opt.fat_g * per100,
          carbs_g: opt.carbs_g * per100,
          fiber_g: opt.fiber_g == null ? null : opt.fiber_g * per100,
          sugar_g: null,
          sodium_mg: opt.sodium_mg == null ? null : opt.sodium_mg * per100,
        },
        origin: 'web_lookup',
        sourceUrl: parsed!.success ? parsed!.data.source_url : null,
        gramPathway: 'packaged_exact',
        bandHalfPct: 0.1,
        isEstimate: false,
        assumptions: [],
      },
    ],
    null,
    'barcode-web',
    null,
  )
}

/**
 * Label scanner: photograph the printed panel, transcribe it, log it as a
 * packaged_exact row. A label with no printed gram weight fails LOUDLY — a
 * guessed serving weight under a 'packaged_exact' pathway would be a lie in
 * the one place the app promises exactness.
 */
export async function startLabelScan(photoUri: string): Promise<void> {
  setPhase({ kind: 'analyzing', photoUri, stage: 'preparing' })

  let base64: string
  try {
    base64 = await preprocess(photoUri)
  } catch {
    setPhase({ kind: 'failed', photoUri, message: 'Could not read the photo. Try taking it again.', canRetry: false })
    return
  }
  lastCapture = { photoUri, base64 }

  try {
    await startLabelScanUnguarded(photoUri, base64)
  } catch {
    // canRetry:false: "Try again" always calls retryScan(), which re-runs the
    // GENERIC photo pipeline (analyze) against lastCapture, not another label
    // read. Even though lastCapture does hold this same photo here, retrying
    // would silently analyze it as a regular food photo and present that as
    // the label result — the wrong pipeline, not just a wrong photo.
    setPhase({
      kind: 'failed',
      photoUri,
      message: 'Something went wrong reading this label. Try again.',
      canRetry: false,
    })
  }
}

async function startLabelScanUnguarded(photoUri: string, base64: string): Promise<void> {
  const provider = (await setting('provider')) as ProviderId | 'none' | ''
  const credential = provider && provider !== 'none' ? await loadCredential(provider) : null
  if (!credential || !provider || provider === 'none') {
    setPhase({
      kind: 'failed',
      photoUri,
      message: 'Reading a label needs an API key. Add one in Profile — or find the product by barcode or search instead.',
      canRetry: false,
      failureKind: 'no-key',
    })
    return
  }

  const model = (await setting('provider_model')) || cheapestModel(provider).id
  setPhase({ kind: 'analyzing', photoUri, stage: 'identifying' })

  const outcome = await runLabelScan(provider, { model, imageBase64: base64 }, credential)
  if (!outcome.ok) {
    setPhase({
      kind: 'failed',
      photoUri,
      message: outcome.error?.message ?? 'The label could not be read.',
      canRetry: outcome.error?.retryable ?? false,
      failureKind: outcome.error?.kind,
    })
    return
  }

  const parsed = LabelPayloadZ.safeParse(outcome.raw)
  if (!parsed.success || parsed.data.per_serving.calories_kcal <= 0) {
    setPhase({
      kind: 'failed',
      photoUri,
      message: 'That does not look like a legible nutrition label. Get the whole panel in frame, flat and well lit.',
      canRetry: true,
    })
    return
  }
  if (parsed.data.serving_g == null) {
    setPhase({
      kind: 'failed',
      photoUri,
      message: 'The label was read, but it prints no gram weight for the serving — without it the numbers cannot be scaled honestly. Include the serving-size line in the photo if it has one.',
      canRetry: true,
    })
    return
  }

  const label = parsed.data
  const grams = label.serving_g!
  const per100 = 100 / grams
  const p = label.per_serving
  readyFromRows(
    [
      {
        id: `row_${Date.now()}`,
        displayName: label.product_name ?? 'Labeled item',
        sourceFoodId: null,
        grams,
        nutrientSnapshot: {
          kcal: p.calories_kcal * per100,
          protein_g: p.protein_g * per100,
          fat_g: p.fat_g * per100,
          carbs_g: p.carbs_g * per100,
          fiber_g: p.fiber_g == null ? null : p.fiber_g * per100,
          sugar_g: p.sugar_g == null ? null : p.sugar_g * per100,
          sodium_mg: p.sodium_mg == null ? null : p.sodium_mg * per100,
        },
        origin: 'label_ocr',
        gramPathway: 'packaged_exact',
        bandHalfPct: 0.05,
        isEstimate: false,
        assumptions: [],
      },
    ],
    photoUri,
    'label-scan',
    LABEL_SCAN_PROMPT_VERSION,
  )
}

/**
 * Receipt mode — the meal you didn't photograph.
 *
 * The model transcribes merchant + line items off the paper; every NUMBER then
 * comes from one web lookup per item with the merchant as the brand. Items the
 * lookup cannot resolve are dropped and named in the failure copy rather than
 * logged as zeros — a silent zero-calorie Big Mac is worse than an honest gap.
 */
const MAX_RECEIPT_ITEMS = 8

export async function startReceiptScan(photoUri: string): Promise<void> {
  setPhase({ kind: 'analyzing', photoUri, stage: 'preparing' })

  let base64: string
  try {
    base64 = await preprocess(photoUri)
  } catch {
    setPhase({ kind: 'failed', photoUri, message: 'Could not read the photo. Try taking it again.', canRetry: false })
    return
  }
  lastCapture = { photoUri, base64 }

  try {
    await startReceiptScanUnguarded(photoUri, base64)
  } catch {
    // canRetry:false, same reasoning as the label catch above: retryScan()
    // would re-run the generic photo pipeline against this receipt photo, not
    // another receipt read — the wrong pipeline, presented as if it were a
    // successful retry.
    setPhase({
      kind: 'failed',
      photoUri,
      message: 'Something went wrong reading this receipt. Try again.',
      canRetry: false,
    })
  }
}

async function startReceiptScanUnguarded(photoUri: string, base64: string): Promise<void> {
  const provider = (await setting('provider')) as ProviderId | 'none' | ''
  const credential = provider && provider !== 'none' ? await loadCredential(provider) : null
  if (!credential || !provider || provider === 'none') {
    setPhase({
      kind: 'failed',
      photoUri,
      message: 'Reading a receipt needs an API key. Add one in Profile.',
      canRetry: false,
      failureKind: 'no-key',
    })
    return
  }
  const model = (await setting('provider_model')) || cheapestModel(provider).id

  setPhase({ kind: 'analyzing', photoUri, stage: 'identifying' })
  const outcome = await runReceiptScan(provider, { model, imageBase64: base64 }, credential)
  if (!outcome.ok) {
    setPhase({
      kind: 'failed',
      photoUri,
      message: outcome.error?.message ?? 'The receipt could not be read.',
      canRetry: outcome.error?.retryable ?? false,
      failureKind: outcome.error?.kind,
    })
    return
  }

  const receipt = ReceiptPayloadZ.safeParse(outcome.raw)
  if (!receipt.success || receipt.data.items.length === 0) {
    setPhase({
      kind: 'failed',
      photoUri,
      message: 'No food lines found on that receipt. Get the itemized part flat and in focus.',
      canRetry: true,
    })
    return
  }

  setPhase({ kind: 'analyzing', photoUri, stage: 'matching' })
  const merchant = receipt.data.merchant
  const items = receipt.data.items.slice(0, MAX_RECEIPT_ITEMS)

  const looked = await Promise.all(
    items.map(async (item) => ({
      item,
      lookup: await runWebLookup(
        provider,
        { model, itemName: item.name, brand: merchant },
        credential,
      ),
    })),
  )

  const rows: IngredientRow[] = []
  const webLookups: Record<string, import('./store').WebLookupState> = {}
  const unresolved: string[] = []

  for (const { item, lookup } of looked) {
    const parsed = lookup.ok ? WebLookupResultZ.safeParse(lookup.raw) : null
    const data = parsed?.success && parsed.data.found && parsed.data.options.length > 0 ? parsed.data : null
    if (!data) {
      unresolved.push(item.name)
      continue
    }
    const opt = data.options[0]!
    const grams = (opt.serving_g ?? 100) * item.quantity
    const per100 = grams > 0 ? (100 * item.quantity) / grams : 0
    const rowId = `row_${Date.now()}_${rows.length}`
    rows.push({
      id: rowId,
      displayName: item.quantity > 1 ? `${opt.label} × ${item.quantity}` : opt.label,
      sourceFoodId: null,
      grams,
      nutrientSnapshot: {
        kcal: opt.calories_kcal * per100,
        protein_g: opt.protein_g * per100,
        carbs_g: opt.carbs_g * per100,
        fat_g: opt.fat_g * per100,
        fiber_g: opt.fiber_g == null ? null : opt.fiber_g * per100,
        sugar_g: null,
        sodium_mg: opt.sodium_mg == null ? null : opt.sodium_mg * per100,
      },
      origin: 'web_lookup',
      sourceUrl: data.source_url,
      gramPathway: 'packaged_exact',
      bandHalfPct: 0.1,
      isEstimate: false,
      assumptions: [],
    })
    // Several menu variants → the question card renders under the row.
    if (data.options.length > 1) {
      webLookups[rowId] = { status: 'done', result: data }
    }
  }

  if (rows.length === 0) {
    setPhase({
      kind: 'failed',
      photoUri,
      message: `Read the receipt but could not find nutrition for: ${unresolved.join(', ')}. Add them by search instead.`,
      canRetry: false,
    })
    return
  }

  readyFromRows(rows, photoUri, 'receipt-scan', RECEIPT_SCAN_PROMPT_VERSION, webLookups)
}

/**
 * Free-text "Other" answer on a question card: one more search, seeded with
 * what the user typed.
 */
export async function lookupOther(rowId: string, typed: string): Promise<void> {
  const provider = (await setting('provider')) as ProviderId | 'none' | ''
  if (!provider || provider === 'none') return
  const credential = await loadCredential(provider)
  if (!credential) return
  const model = (await setting('provider_model')) || cheapestModel(provider).id

  setWebLookup(rowId, { status: 'running' })
  const lookup = await runWebLookup(provider, { model, itemName: typed, brand: null }, credential)
  if (!lookup.ok) {
    setWebLookup(rowId, { status: 'failed' })
    return
  }
  const parsed = WebLookupResultZ.safeParse(lookup.raw)
  if (!parsed.success || !parsed.data.found || parsed.data.options.length === 0) {
    setWebLookup(rowId, { status: 'failed' })
    return
  }
  setWebLookup(rowId, { status: 'done', result: parsed.data })
  if (parsed.data.options.length === 1) {
    applyWebOption(rowId, parsed.data.options[0]!, parsed.data.source_url)
  }
}

// ---------------------------------------------------------------------------
// The keyless paths — search, manual entry, saved meals
// ---------------------------------------------------------------------------

/**
 * Log a food the user found by text search.
 *
 * Takes the row rather than an id: the corpus is on the PC now, so the screen
 * already holds the full nutrition the search returned and a second lookup would
 * be a second chance to fail. `null` means the server did not hand back details
 * for that candidate — the caller says so rather than opening an empty review.
 */
export function startSearchLog(food: CorpusFoodRow | null, grams: number): boolean {
  if (food == null) return false
  readyFromRows([rowFromCorpusFood(food, grams, Date.now())], null, 'search-log', null)
  return true
}

/** Log a food the user typed by hand. No database read, no network, no key. */
export function startManualLog(entry: ManualEntry): void {
  readyFromRows([rowFromManualEntry(entry, Date.now())], null, 'manual-entry', null)
}

/**
 * Relog a saved meal, at `factor` of its saved size.
 *
 * The saved rows already carry their own snapshots, which is the whole point of
 * storing the corrected ingredient array instead of a name to re-analyze:
 * relogging costs zero network requests and asks zero questions.
 */
export function startSavedMealLog(rows: readonly IngredientRow[], factor: number): void {
  readyFromRows(scaleRows(rows, factor, Date.now()), null, 'saved-meal', null)
}
