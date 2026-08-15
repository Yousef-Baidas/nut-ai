#!/usr/bin/env node
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DbAdapter } from '@nutai/db-adapter'
import { openNodeDb } from '@nutai/db-adapter/node'
import { BadPipelinePayloadError, handleBarcode, handleHealth, handlePipeline, handleSearch } from './handlers.js'
import type { ErrorResponse, PipelineRequest } from './wire.js'

/**
 * The food server.
 *
 * BINDS TO THE TAILSCALE ADDRESS ONLY. There is no auth layer and there is not
 * meant to be one: tailnet membership is the boundary, which is only true while
 * the socket is unreachable from anywhere else. `0.0.0.0` is refused at startup
 * rather than warned about, because a warning in a systemd journal is a warning
 * nobody reads.
 */

const DEFAULT_DB = join(homedir(), 'nut-ai-data/nutrition-full.db')
const DEFAULT_PORT = 7100

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(json)
}

function fail(res: ServerResponse, status: number, error: string, message: string): void {
  const body: ErrorResponse = { error, message }
  send(res, status, body)
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export function createRequestListener(db: DbAdapter) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')

        if (req.method === 'GET' && url.pathname === '/health') {
          send(res, 200, await handleHealth(db))
          return
        }

        if (req.method === 'GET' && url.pathname === '/search') {
          const q = url.searchParams.get('q') ?? ''
          if (q.trim() === '') {
            fail(res, 400, 'bad_query', 'q is required and must not be empty')
            return
          }
          const gramsRaw = url.searchParams.get('grams')
          const grams = gramsRaw == null || gramsRaw === '' ? null : Number(gramsRaw)
          if (grams != null && !Number.isFinite(grams)) {
            fail(res, 400, 'bad_query', 'grams must be a number when present')
            return
          }
          send(res, 200, await handleSearch(db, q, grams))
          return
        }

        if (req.method === 'GET' && url.pathname.startsWith('/barcode/')) {
          const gtin = decodeURIComponent(url.pathname.slice('/barcode/'.length))
          if (gtin.trim() === '') {
            fail(res, 400, 'bad_query', 'a GTIN is required')
            return
          }
          const found = await handleBarcode(db, gtin)
          if (found == null) {
            fail(res, 404, 'not_found', `no food carries the barcode ${gtin}`)
            return
          }
          send(res, 200, found)
          return
        }

        if (req.method === 'POST' && url.pathname === '/pipeline') {
          let body: PipelineRequest
          try {
            body = (await readBody(req)) as PipelineRequest
          } catch {
            fail(res, 400, 'bad_body', 'the request body was not JSON')
            return
          }
          if (body == null || typeof body !== 'object' || body.raw == null) {
            fail(res, 400, 'bad_body', 'raw is required')
            return
          }
          try {
            send(res, 200, await handlePipeline(db, body))
          } catch (err) {
            if (err instanceof BadPipelinePayloadError) {
              fail(res, 400, 'bad_body', err.message)
              return
            }
            throw err
          }
          return
        }

        fail(res, 404, 'no_route', `${req.method ?? 'GET'} ${url.pathname} is not a route`)
      } catch (err) {
        fail(res, 500, 'server_error', err instanceof Error ? err.message : 'unknown failure')
      }
    })()
  }
}

export function startServer({ db, host, port }: { db: DbAdapter; host: string; port: number }): Promise<Server> {
  const server = createServer(createRequestListener(db))
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve(server))
  })
}

async function main(): Promise<void> {
  const dbPath = process.env['NUTAI_DB'] ?? DEFAULT_DB
  const host = process.env['NUTAI_HOST'] ?? ''
  const port = Number(process.env['NUTAI_PORT'] ?? DEFAULT_PORT)

  if (host === '' || host === '0.0.0.0' || host === '::') {
    throw new Error(
      'NUTAI_HOST must be the Tailscale interface address (e.g. 100.96.136.73). ' +
        'Binding a wildcard would put the corpus on every network this machine joins.',
    )
  }
  if (!existsSync(dbPath)) {
    throw new Error(`corpus not found at ${dbPath} — run \`npm run data:build:full\` first`)
  }

  const db = openNodeDb(dbPath, { readonly: true })
  await startServer({ db, host, port })
  console.log(`nutai food-server listening on http://${host}:${port} (corpus ${dbPath})`)
}

if (process.argv[1]?.endsWith('server.js') === true) {
  main().catch((err: unknown) => {
    console.error('food-server refused to start:')
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
