#!/usr/bin/env node
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync } from 'node:fs'
import { isIP } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { InferencePath } from '@nutai/confidence'
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
const INFERENCE_PATHS: readonly InferencePath[] = ['cloud', 'local']

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return
  const json = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(json)
}

function fail(res: ServerResponse, status: number, error: string, message: string): void {
  const body: ErrorResponse = { error, message }
  send(res, status, body)
}

/**
 * A /pipeline payload is one VisionPayload — kilobytes. The cap exists so a
 * runaway client (or anything else that finds the tailnet socket) cannot make
 * the server buffer an arbitrarily large body into memory.
 */
const MAX_BODY_BYTES = 1024 * 1024

export class BodyTooLargeError extends Error {}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    total += (chunk as Buffer).length
    if (total > MAX_BODY_BYTES) throw new BodyTooLargeError(`body exceeds ${MAX_BODY_BYTES} bytes`)
    chunks.push(chunk as Buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function isInferencePath(v: unknown): v is InferencePath {
  return typeof v === 'string' && (INFERENCE_PATHS as readonly string[]).includes(v)
}

export function createRequestListener(db: DbAdapter) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')

        if (url.pathname === '/health') {
          if (req.method !== 'GET') {
            fail(res, 405, 'method_not_allowed', `${req.method ?? ''} /health is not supported; use GET`)
            return
          }
          send(res, 200, await handleHealth(db))
          return
        }

        if (url.pathname === '/search') {
          if (req.method !== 'GET') {
            fail(res, 405, 'method_not_allowed', `${req.method ?? ''} /search is not supported; use GET`)
            return
          }
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

        if (url.pathname.startsWith('/barcode/')) {
          if (req.method !== 'GET') {
            fail(res, 405, 'method_not_allowed', `${req.method ?? ''} /barcode is not supported; use GET`)
            return
          }
          let gtin: string
          try {
            gtin = decodeURIComponent(url.pathname.slice('/barcode/'.length))
          } catch {
            fail(res, 400, 'bad_query', 'the barcode path segment is not a valid URI escape')
            return
          }
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

        if (url.pathname === '/pipeline') {
          if (req.method !== 'POST') {
            fail(res, 405, 'method_not_allowed', `${req.method ?? ''} /pipeline is not supported; use POST`)
            return
          }
          let body: PipelineRequest
          try {
            body = (await readBody(req)) as PipelineRequest
          } catch (err) {
            if (err instanceof BodyTooLargeError) {
              fail(res, 413, 'body_too_large', `the request body may not exceed ${MAX_BODY_BYTES} bytes`)
              return
            }
            fail(res, 400, 'bad_body', 'the request body was not JSON')
            return
          }
          if (body == null || typeof body !== 'object' || body.raw == null) {
            fail(res, 400, 'bad_body', 'raw is required')
            return
          }
          if (typeof body.now !== 'number' || !Number.isFinite(body.now)) {
            fail(res, 400, 'bad_body', 'now is required and must be a finite number (epoch millis)')
            return
          }
          if (!isInferencePath(body.path)) {
            fail(res, 400, 'bad_body', `path must be one of ${INFERENCE_PATHS.join(', ')}`)
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
        // The detail goes to the journal, not the wire: tailnet or not, an
        // internal error string is the server's business, and the client's
        // four-outcome model only needs to know the server answered unhappily.
        console.error('food-server request failed:', err)
        fail(res, 500, 'server_error', 'internal error — see the server journal')
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

export interface BindConfig {
  host: string
  port: number
  dbPath: string
}

/**
 * Parse and validate the bind configuration from the environment.
 *
 * ALLOWLIST, not a denylist. A denylist of wildcard SPELLINGS ("0.0.0.0", "::")
 * is a losing game: Node's own address resolution treats "0", "0.0" and "0x0" as
 * legacy numbers-and-dots notation for 0.0.0.0, and "::0" is the IPv6 unspecified
 * address under a different spelling than "::" — none of those strings equal the
 * denylist entries, so a `host === '0.0.0.0'` check lets every one of them
 * through. `node:net`'s `isIP` parses without touching DNS at all, so requiring
 * `isIP(host) === 4` rejects all of the above in one move, because none of them
 * IS a literal IPv4 address — and it rejects every IPv6 spelling too, which is
 * fine, because Tailscale hands this app an IPv4 address (`tailscale ip -4`) and
 * there's no support burden in refusing to guess when a caller hands it IPv6
 * instead.
 */
export function resolveBindConfig(env: Readonly<Record<string, string | undefined>>): BindConfig {
  const rawHost = env['NUTAI_HOST'] ?? ''
  const host = rawHost.trim()
  const dbPath = env['NUTAI_DB'] ?? DEFAULT_DB
  const port = Number(env['NUTAI_PORT'] ?? DEFAULT_PORT)

  if (isIP(host) !== 4 || host === '0.0.0.0') {
    throw new Error(
      `NUTAI_HOST must be a literal IPv4 Tailscale address (e.g. 100.96.136.73); got ${JSON.stringify(rawHost)}. ` +
        'Binding a wildcard would put the corpus on every network this machine joins.',
    )
  }

  return { host, port, dbPath }
}

export function assertCorpusExists(dbPath: string): void {
  if (!existsSync(dbPath)) {
    throw new Error(`corpus not found at ${dbPath} — run \`npm run data:build:full\` first`)
  }
}

/**
 * The backstop that survives any bug in `resolveBindConfig` or in Node's own
 * `listen()` resolution: after the socket is actually bound, refuse to keep
 * running unless the OS reports back a non-wildcard address. This is the last
 * line, not the first — `resolveBindConfig` is still what should catch a bad
 * config, but a check that only runs once, after the fact, is worth having
 * precisely because it does not trust the earlier one.
 */
function assertBoundAddressIsNotWildcard(server: Server): void {
  const bound = server.address()
  const address = bound == null || typeof bound === 'string' ? null : bound.address
  if (address == null || address === '0.0.0.0' || address === '::' || address === '::ffff:0.0.0.0') {
    throw new Error(`refusing to continue: bound to wildcard address ${JSON.stringify(address)}`)
  }
}

async function main(): Promise<void> {
  const { host, port, dbPath } = resolveBindConfig(process.env)
  assertCorpusExists(dbPath)

  const db = openNodeDb(dbPath, { readonly: true })
  const server = await startServer({ db, host, port })

  try {
    assertBoundAddressIsNotWildcard(server)
  } catch (err) {
    server.close()
    throw err
  }

  console.log(`nutai food-server listening on http://${host}:${port} (corpus ${dbPath})`)
}

const isMainModule = process.argv[1] != null && fileURLToPath(import.meta.url) === process.argv[1]

if (isMainModule) {
  main().catch((err: unknown) => {
    console.error('food-server refused to start:')
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
