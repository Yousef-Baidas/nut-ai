import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertCorpusExists, resolveBindConfig } from './server.js'

/**
 * `NUTAI_HOST=0` used to boot fine and bind `0.0.0.0` — Node's own address
 * resolution treats "0", "0.0" and "0x0" as legacy numbers-and-dots notation
 * for the wildcard, and "::0" is the IPv6 unspecified address under a
 * different spelling than "::". A denylist of literal wildcard strings misses
 * all four. `resolveBindConfig` is the allowlist fix — extracted out of
 * `main()` specifically so this whole bypass class can be asserted here
 * without booting a real socket.
 */
describe('resolveBindConfig', () => {
  const WILDCARD_SPELLINGS = ['0', '0.0', '0x0', '::0', '[::]', '0.0.0.0', '::']

  it.each(WILDCARD_SPELLINGS)('rejects the wildcard spelled %s', (host) => {
    expect(() => resolveBindConfig({ NUTAI_HOST: host })).toThrow(/literal IPv4/)
  })

  it('rejects an empty host', () => {
    expect(() => resolveBindConfig({ NUTAI_HOST: '' })).toThrow(/literal IPv4/)
    expect(() => resolveBindConfig({})).toThrow(/literal IPv4/)
  })

  it('rejects whitespace-only host', () => {
    expect(() => resolveBindConfig({ NUTAI_HOST: '   ' })).toThrow(/literal IPv4/)
  })

  it('accepts a literal tailnet IPv4 address', () => {
    const config = resolveBindConfig({ NUTAI_HOST: '100.96.136.73' })
    expect(config.host).toBe('100.96.136.73')
  })

  it('trims surrounding whitespace on an otherwise-valid host', () => {
    const config = resolveBindConfig({ NUTAI_HOST: '  100.96.136.73  ' })
    expect(config.host).toBe('100.96.136.73')
  })

  it('rejects any IPv6 literal, even a legitimate non-wildcard one', () => {
    expect(() => resolveBindConfig({ NUTAI_HOST: 'fd7a:115c:a1e0::1' })).toThrow(/literal IPv4/)
  })

  it('defaults the port to 7100 and the db path to the home-dir corpus', () => {
    const config = resolveBindConfig({ NUTAI_HOST: '100.96.136.73' })
    expect(config.port).toBe(7100)
    expect(config.dbPath).toContain('nut-ai-data/nutrition-full.db')
  })

  it('reads NUTAI_PORT and NUTAI_DB when set', () => {
    const config = resolveBindConfig({ NUTAI_HOST: '100.96.136.73', NUTAI_PORT: '9999', NUTAI_DB: '/tmp/x.db' })
    expect(config.port).toBe(9999)
    expect(config.dbPath).toBe('/tmp/x.db')
  })
})

describe('assertCorpusExists', () => {
  let dir: string

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('throws a legible error when the corpus file is missing', () => {
    expect(() => assertCorpusExists('/definitely/not/a/real/path/nutrition-full.db')).toThrow(/corpus not found/)
  })

  it('does not throw when the corpus file exists', () => {
    dir = mkdtempSync(join(tmpdir(), 'food-server-test-'))
    const dbPath = join(dir, 'nutrition-full.db')
    writeFileSync(dbPath, '')
    expect(() => assertCorpusExists(dbPath)).not.toThrow()
  })
})
