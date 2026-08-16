import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_VERSION as PAYLOAD_SCHEMA_VERSION, type Item, type VisionPayload } from '@nutai/core-schema'
import type { DbAdapter } from '@nutai/db-adapter'
import { buildFixtureDb } from './fixture.js'
import { startServer } from './server.js'
import type { BarcodeResponse, ErrorResponse, HealthResponse, PipelineResponse, SearchResponse } from './wire.js'

/** A payload that clears Zod validation, borrowed from the pipeline package's own e2e fixture shape. */
function validRawPayload(): VisionPayload {
  const item: Item = {
    name: 'Grilled chicken breast',
    brand: null,
    canonical_food_key: 'chicken breast, grilled',
    food_form: 'flat',
    qualitative_size: 'medium',
    weight_basis: 'cooked',
    model_gram_estimate: 170,
    identification_confidence: 0.9,
    portion_confidence: 0.6,
    uncertainty_reason: 'none',
    visible_reference_objects: [],
    container: null,
    cooking_method_cues: ['grill_marks'],
    is_beverage: false,
    beverage_category: null,
    legible_label_text: null,
    stated_assumptions: [],
    clarifying_questions: [],
    fallback_macros_at_estimate: {
      calories_kcal: 280, protein_g: 53, carbs_g: 0, fat_g: 6, fiber_g: 0, sodium_mg: 130,
    },
  }
  return {
    schema_version: PAYLOAD_SCHEMA_VERSION,
    is_food: true,
    refusal_reason: null,
    items: [item],
    meal_overall: {
      identification_confidence: 0.9,
      portion_confidence: 0.6,
      assumptions: [],
      clarifying_questions: [],
    },
  }
}

let db: DbAdapter
let server: Server
let base: string

beforeEach(async () => {
  db = await buildFixtureDb()
  server = await startServer({ db, host: '127.0.0.1', port: 0 })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await db.close()
})

describe('routes', () => {
  it('GET /health returns the corpus summary', async () => {
    const res = await fetch(`${base}/health`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = (await res.json()) as HealthResponse
    expect(body.ok).toBe(true)
    expect(body.foods).toBe(4)
  })

  it('GET /search returns an outcome', async () => {
    const res = await fetch(`${base}/search?q=${encodeURIComponent('فول')}&grams=250`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as SearchResponse
    expect(body.outcome.kind).not.toBe('miss')
  })

  it('GET /search with an empty q is a 400 with a message, not a 500', async () => {
    const res = await fetch(`${base}/search?q=`)
    expect(res.status).toBe(400)
    const body = (await res.json()) as ErrorResponse
    expect(body.error).toBe('bad_query')
    expect(typeof body.message).toBe('string')
  })

  it('GET /barcode/<gtin> returns the food', async () => {
    const res = await fetch(`${base}/barcode/6281006012011`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as BarcodeResponse
    expect(body.food.name).toBe('Almarai Fresh Laban')
  })

  it('GET /barcode/<unknown> is a 404 with a JSON body', async () => {
    const res = await fetch(`${base}/barcode/0000000000000`)
    expect(res.status).toBe(404)
    const body = (await res.json()) as ErrorResponse
    expect(body.error).toBe('not_found')
  })

  it('an unknown route is a 404, not a hang', async () => {
    const res = await fetch(`${base}/nope`)
    expect(res.status).toBe(404)
  })

  it('POST /search is a 405, not a 404 (the route exists, the verb does not)', async () => {
    const res = await fetch(`${base}/search?q=ful`, { method: 'POST' })
    expect(res.status).toBe(405)
  })

  it('GET /barcode/%25 (an invalid URI escape) is a 400, not a 500', async () => {
    const res = await fetch(`${base}/barcode/%`)
    expect(res.status).toBe(400)
    const body = (await res.json()) as ErrorResponse
    expect(body.error).toBe('bad_query')
  })
})

describe('POST /pipeline', () => {
  it('runs the deterministic pipeline and returns a ScanResult', async () => {
    const res = await fetch(`${base}/pipeline`, {
      method: 'POST',
      body: JSON.stringify({ raw: validRawPayload(), path: 'cloud', now: Date.now() }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as PipelineResponse
    expect(body.schemaVersion).toBe(1)
    expect(body.result.isFood).toBe(true)
    expect(body.result.items).toHaveLength(1)
  })

  it('a Zod-invalid raw payload is a 400, not a 500', async () => {
    const res = await fetch(`${base}/pipeline`, {
      method: 'POST',
      body: JSON.stringify({ raw: { not: 'a valid payload' }, path: 'cloud', now: Date.now() }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as ErrorResponse
    expect(body.error).toBe('bad_body')
  })

  it('a missing now is a 400', async () => {
    const res = await fetch(`${base}/pipeline`, {
      method: 'POST',
      body: JSON.stringify({ raw: validRawPayload(), path: 'cloud' }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as ErrorResponse
    expect(body.error).toBe('bad_body')
  })

  it('a non-numeric now is a 400, not a 500 from an invalid Date', async () => {
    const res = await fetch(`${base}/pipeline`, {
      method: 'POST',
      body: JSON.stringify({ raw: validRawPayload(), path: 'cloud', now: 'yesterday' }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as ErrorResponse
    expect(body.error).toBe('bad_body')
  })

  it('a path outside the InferencePath union is a 400, not silently accepted', async () => {
    const res = await fetch(`${base}/pipeline`, {
      method: 'POST',
      body: JSON.stringify({ raw: validRawPayload(), path: 'quantum', now: Date.now() }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as ErrorResponse
    expect(body.error).toBe('bad_body')
  })
})
