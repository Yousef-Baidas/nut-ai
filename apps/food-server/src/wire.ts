import type { PipelineDeps, ScanResult } from '@nutai/pipeline'
import type { ResolutionOutcome, ResolvedFood } from '@nutai/resolver'

/**
 * The wire contract between the phone and the PC.
 *
 * `schemaVersion` exists so a phone built against v1 talking to a server built
 * against v2 says so out loud instead of rendering nonsense. The client warns and
 * still tries — a mismatch is usually additive — but the hint is in the payload,
 * not in a guess.
 */
export const SCHEMA_VERSION = 1

export interface HealthResponse {
  ok: true
  schemaVersion: number
  foods: number
  portions: number
  barcodes: number
  builtAt: string | null
  tiers: string[]
}

export interface PortionRow {
  measure_unit: string | null
  modifier: string | null
  amount: number | null
  gram_weight: number
  is_fndds_default: number
}

export interface FoodDetail {
  food: ResolvedFood
  portions: PortionRow[]
}

/**
 * The resolver's own outcome, VERBATIM, plus the hydration the phone needs.
 *
 * `outcome` is exactly what `resolveByText` returned — parity.test.ts asserts
 * that by calling both and comparing. `details` is additive: full nutrition and
 * portion rows for the candidates in the outcome, so tapping a result can log it
 * without a second round trip and without the phone holding a corpus.
 */
export interface SearchResponse {
  schemaVersion: number
  outcome: ResolutionOutcome
  ladderStep: number
  zeroHit: boolean
  details: Record<string, FoodDetail>
}

export interface BarcodeResponse {
  schemaVersion: number
  food: ResolvedFood
  portions: PortionRow[]
}

export interface PipelineRequest {
  raw: unknown
  path: PipelineDeps['path']
  barcode?: string
  now: number
}

export interface PipelineResponse {
  schemaVersion: number
  result: ScanResult
}

export interface ErrorResponse {
  error: string
  message: string
}
