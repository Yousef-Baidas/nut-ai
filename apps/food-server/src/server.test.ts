import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DbAdapter } from '@nutai/db-adapter'
import { buildFixtureDb } from './fixture.js'
import { startServer } from './server.js'
import type { BarcodeResponse, ErrorResponse, HealthResponse, SearchResponse } from './wire.js'

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
})
