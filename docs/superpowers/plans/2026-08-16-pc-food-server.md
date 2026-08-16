# PC-Hosted Food Database Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 4.7 MB bundled nutrition corpus with a multi-million-row food database (Open Food Facts + USDA branded + a curated Arab tier) hosted on the user's PC and queried by the phone over Tailscale, so search gains Arabic/transliteration coverage and barcodes that real scans can hit.

**Architecture:** A new Node workspace `apps/food-server/` opens the big corpus read-only with `openNodeDb` from `@nutai/db-adapter/node`, imports `@nutai/resolver` and `@nutai/pipeline` directly, and serves JSON over plain `node:http` bound to the Tailscale interface only. The phone keeps no corpus at all: `apps/mobile/src/data/food-server.ts` is a typed fetch client whose every call returns one of four outcomes (`ok` / `no_match` / `not_found` / `server_unreachable`), and every call site distinguishes them. `tools/nutrition-data` grows a second build target that stream-parses the OFF dump, the USDA branded CSVs and a checked-in Arab-foods CSV into `~/nut-ai-data/nutrition-full.db`, stamping `foods.tier` and `foods.license` per row.

**Tech Stack:** TypeScript 5.7 (ESM, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`), Node ≥ 20.19 (dev machine runs 24), plain `node:http`, better-sqlite3 13 with FTS5, `.mjs` build scripts in `tools/nutrition-data`, Vitest 3 from the repo root, Expo/React Native 0.81 in `apps/mobile`, systemd **user** unit for deployment.

**Spec:** docs/superpowers/specs/2026-08-16-pc-hosted-food-database-design.md

## Global Constraints

- Keyless paths never call AI providers — the throwing-provider-client mock in `apps/mobile/src/scan/orchestrator.keyless.test.ts:50-54` stays verbatim; keyless paths MAY call the user's own food server.
- No invented nutrition values — every `arab_curated` row cites a published food-composition table in its `source` column, and a row without one does not ship.
- The server binds to the Tailscale interface address only — never `0.0.0.0`, never a wildcard.
- Plain commit messages: no `Co-Authored-By`, no `Generated with`, no AI trailers of any kind.
- The full suite (`npm test` from the repo root) is green after every task, not just at the end.
- TDD: a failing test first, watched fail, then the minimal implementation, then watched pass.
- Every unit test runs without the 9 GB OFF download — the OFF tests use synthetic JSONL fixtures checked into the repo.

## Resolved spec gaps (decided while grounding this plan against the code)

1. **`foods.tier` does not exist.** `packages/db-adapter/src/schema.ts:39-66` has `source` and `license` but no `tier`. Task 3 adds `tier TEXT` to `NUTRITION_SCHEMA`.
2. **The photo pipeline needs a `DbAdapter` the phone will no longer have.** `apps/mobile/src/scan/orchestrator.ts:194-206` calls `runPipeline(raw, { db: nutritionDb, ... }, foodDb)`. Three endpoints cannot serve arbitrary SQL, so the server gains a fourth route, `POST /pipeline`, which runs the same `runPipeline` server-side and returns the `ScanResult`. This is the smallest change consistent with the spec's own "smart server" choice; the alternative (keeping a bundled corpus for photos) contradicts "the phone bundles no nutrition corpus".
3. **Search results must be loggable.** `ScoredCandidate` carries `energyKcal` but not protein/fat/carb, and `startSearchLog` used to re-read the row locally. `/search` therefore returns the resolver outcome verbatim **plus** a `details` map (`foodId -> { food: ResolvedFood, portions }`) for the ≤5 candidates in the outcome, so the screen still costs one round trip and the parity test still compares `outcome` byte-for-byte.

---

## Task 1 — Shared Arabic/Latin search normalization in `@nutai/resolver`

**Files:**
- Create: `packages/resolver/src/search-normalize.ts`
- Create: `packages/resolver/src/search-normalize.test.ts`
- Modify: `packages/resolver/src/index.ts` (add one `export *` line after line 15)
- Modify: `packages/resolver/tsconfig.json` (add `references`)
- Modify: `packages/db-adapter/tsconfig.json` (add `references`)
- Modify: `package.json` (add the `build:packages` script)

**Interfaces:**
- Consumes: nothing outside the repo. `packages/resolver/src/index.ts` currently re-exports `./gtin.js`, `./query.js`, `./scoring.js`.
- Produces: `foldArabic(text: string): string`, `foldLatin(text: string): string`, `normalizeSearchText(text: string): string`, and `ARABIC_RE: RegExp` — all exported from `@nutai/resolver`. Also produces the root npm script `build:packages`, which Tasks 3, 4, 5 and 6 rely on to get `packages/*/dist` built.

**Steps:**

- [ ] Write the failing test at `packages/resolver/src/search-normalize.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { foldArabic, foldLatin, normalizeSearchText } from './search-normalize.js'

describe('foldArabic', () => {
  it('strips tashkeel', () => {
    expect(foldArabic('فُولْ')).toBe('فول')
    expect(foldArabic('كُنَافَة')).toBe('كنافه')
  })

  it('folds alef variants, ta marbuta and alef maqsura', () => {
    expect(foldArabic('أرز')).toBe('ارز')
    expect(foldArabic('إفطار')).toBe('افطار')
    expect(foldArabic('آيس')).toBe('ايس')
    expect(foldArabic('لبنة')).toBe('لبنه')
    expect(foldArabic('مصطفى')).toBe('مصطفي')
  })

  it('normalizes Arabic-Indic digits to ASCII', () => {
    expect(foldArabic('٢٥٠ غرام')).toBe('250 غرام')
    expect(foldArabic('۳۰۰')).toBe('300')
  })

  it('strips tatweel', () => {
    expect(foldArabic('فـــول')).toBe('فول')
  })
})

describe('foldLatin', () => {
  it('lowercases and strips Latin diacritics', () => {
    expect(foldLatin('Fūl')).toBe('ful')
    expect(foldLatin('Zaʼatar')).toBe('zatar')
  })

  it('collapses the transliteration vowel clusters', () => {
    expect(foldLatin('foul')).toBe('ful')
    expect(foldLatin('fool')).toBe('ful')
    expect(foldLatin('kunafeh')).toBe('kunafeh')
    expect(foldLatin('koshari')).toBe('koshari')
  })

  it('drops apostrophes and collapses doubled letters', () => {
    expect(foldLatin("za'atar")).toBe('zatar')
    expect(foldLatin('zaatar')).toBe('zatar')
    expect(foldLatin('mansaff')).toBe('mansaf')
  })
})

describe('normalizeSearchText', () => {
  it('dispatches per token and keeps a mixed query intact', () => {
    expect(normalizeSearchText('  Foul   MEDAMES ')).toBe('ful medames')
    expect(normalizeSearchText('فُول مُدَمَّس')).toBe('فول مدمس')
    expect(normalizeSearchText('فول Foul')).toBe('فول ful')
  })

  it('is idempotent — index time and query time must agree', () => {
    const once = normalizeSearchText('Za’atar  فُول ٢')
    expect(normalizeSearchText(once)).toBe(once)
  })

  it('golden case: the three spellings of ful share one Latin key', () => {
    expect(foldLatin('ful')).toBe('ful')
    expect(foldLatin('foul')).toBe('ful')
    expect(foldLatin('fool')).toBe('ful')
    expect(foldArabic('فول')).toBe('فول')
  })
})
```

- [ ] Run `npm test -- packages/resolver/src/search-normalize.test.ts` and see it fail with `Failed to resolve import "./search-normalize.js"`.
- [ ] Create `packages/resolver/src/search-normalize.ts`:

```ts
/**
 * Search-text normalization, shared by INDEX time and QUERY time.
 *
 * The two must be the same function or the whole thing is theatre: a corpus
 * indexed as "ful" and a query folded to "fool" simply never meet. The build
 * (tools/nutrition-data) folds names and synonyms with this; apps/food-server
 * folds the incoming `q` with this.
 *
 * FTS5's `unicode61 remove_diacritics 2` already handles Latin diacritics inside
 * the index, but it does NOT fold Arabic orthography (أ/إ/آ -> ا, ة -> ه,
 * ى -> ي) and it does not know that "foul" and "ful" are the same word to
 * anyone typing Arabic food names in Latin script. Those two jobs are here.
 */

/** Arabic block, incl. Arabic Supplement and Presentation Forms-A/B. */
export const ARABIC_RE = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/

/** Tashkeel (harakat), superscript alef, and the tatweel elongation mark. */
const TASHKEEL_RE = /[ً-ٰٟـ]/g

const ARABIC_INDIC_ZERO = 0x0660
const EASTERN_ARABIC_INDIC_ZERO = 0x06f0

function digits(text: string): string {
  let out = ''
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    if (cp >= ARABIC_INDIC_ZERO && cp <= ARABIC_INDIC_ZERO + 9) {
      out += String(cp - ARABIC_INDIC_ZERO)
    } else if (cp >= EASTERN_ARABIC_INDIC_ZERO && cp <= EASTERN_ARABIC_INDIC_ZERO + 9) {
      out += String(cp - EASTERN_ARABIC_INDIC_ZERO)
    } else {
      out += ch
    }
  }
  return out
}

/** Arabic-script folding. Orthographic variants collapse; letters do not. */
export function foldArabic(text: string): string {
  return digits(text)
    .replace(TASHKEEL_RE, '')
    .replace(/[أإآٱ]/g, 'ا') // أ إ آ ٱ -> ا
    .replace(/ة/g, 'ه') // ة -> ه
    .replace(/ى/g, 'ي') // ى -> ي
    .replace(/ؤ/g, 'و') // ؤ -> و
    .replace(/ئ/g, 'ي') // ئ -> ي
    .trim()
}

/**
 * Latin folding for Arabic transliterations.
 *
 * The vowel-cluster rules are the ones that actually matter for food names:
 * ou/oo -> u (foul/fool -> ful), ee -> i, aa -> a (zaatar -> zatar), and the
 * glottal-stop apostrophes people type in "za'atar" carry no information.
 * Doubled consonants collapse last, so "mansaff" and "mansaf" agree.
 */
export function foldLatin(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’'`ʼʻ‘’]/g, '')
    .replace(/ou|oo/g, 'u')
    .replace(/ee/g, 'i')
    .replace(/aa/g, 'a')
    .replace(/([a-z])\1+/g, '$1')
    .trim()
}

/**
 * Fold a whole query or a whole indexed string, token by token.
 *
 * Per-token dispatch, not per-string: "فول medames" is one real query and both
 * halves deserve their own rules. Whitespace collapses so the output is stable
 * enough to be idempotent, which the build depends on — a re-index must produce
 * the same keys as the first index.
 */
export function normalizeSearchText(text: string): string {
  return text
    .split(/\s+/)
    .filter((t) => t !== '')
    .map((token) => (ARABIC_RE.test(token) ? foldArabic(token) : foldLatin(token)))
    .filter((t) => t !== '')
    .join(' ')
}
```

- [ ] Add `export * from './search-normalize.js'` to `packages/resolver/src/index.ts` immediately after the existing `export * from './scoring.js'` on line 15.
- [ ] Run `npm test -- packages/resolver` and see every test pass, including the pre-existing `resolver.test.ts`.
- [ ] Add project references so `tsc --build` orders the packages itself. In `packages/db-adapter/tsconfig.json` add `"references": [{ "path": "../core-schema" }]`; in `packages/resolver/tsconfig.json` add `"references": [{ "path": "../db-adapter" }]`.
- [ ] Add to root `package.json` scripts, after `"data:verify"`: `"build:packages": "tsc --build packages/core-schema packages/db-adapter packages/clamp packages/resolver"`.
- [ ] Run `npm run build:packages` and confirm `packages/resolver/dist/search-normalize.js` exists (`ls packages/resolver/dist/search-normalize.js`). This is what lets the `.mjs` build scripts in Tasks 3 and 4 import the same folding function.
- [ ] Run `npm test` (full suite) and confirm green.
- [ ] Commit: `git add -A && git commit -m "add shared Arabic and Latin search folding to the resolver"`

---

## Task 2 — Move the small-corpus build output out of the app bundle

**Files:**
- Modify: `tools/nutrition-data/src/build.mjs:32` (the `OUT` default)
- Modify: `tools/nutrition-data/src/golden-queries.mjs:19` (the `DB_PATH` default)
- Modify: `packages/pipeline/src/pipeline.corpus.test.ts:24-27` (the `DB_PATH` constant) and the warning string on line 32
- Modify: `.gitignore` (replace the two `apps/mobile/assets/nutrition.db*` lines)
- Create: `tools/nutrition-data/out/.gitkeep`

**Interfaces:**
- Consumes: `tools/nutrition-data/src/build.mjs` `OUT` env override (already present), `golden-queries.mjs` `DB` env override (already present).
- Produces: the fixture path `tools/nutrition-data/out/nutrition.db` used by `pipeline.corpus.test.ts` and by the food-server fixture tests in Task 5.

**Steps:**

- [ ] Write the failing test — extend the guard in `packages/pipeline/src/pipeline.corpus.test.ts` by replacing lines 24-27 with the new path, and add this assertion at the top of the file's first `describe` (after line 33) so the relocation itself is pinned:

```ts
describe('corpus fixture location', () => {
  it('lives in tools/nutrition-data/out, not in the app bundle', () => {
    expect(DB_PATH.endsWith('tools/nutrition-data/out/nutrition.db')).toBe(true)
    expect(DB_PATH).not.toContain('apps/mobile/assets')
  })
})
```

- [ ] Run `npm test -- packages/pipeline/src/pipeline.corpus.test.ts` and see it fail: `expected false to be true` on the `endsWith` assertion.
- [ ] Change `packages/pipeline/src/pipeline.corpus.test.ts` lines 24-27 to:

```ts
const DB_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../tools/nutrition-data/out/nutrition.db',
)
```

- [ ] Change the warning on line 32 to reference the new path: `` console.warn(`\n[pipeline] corpus not found at ${DB_PATH} — run \`npm run data:build\` first.\n`) `` (the template already interpolates `DB_PATH`, so no edit is needed if it already reads that way; confirm it does).
- [ ] Change `tools/nutrition-data/src/build.mjs:32` to `const OUT = process.env.OUT ?? join(REPO, 'tools/nutrition-data/out/nutrition.db')`.
- [ ] Change `tools/nutrition-data/src/golden-queries.mjs:19` to `const DB_PATH = process.env.DB ?? join(HERE, '../out/nutrition.db')`.
- [ ] Replace the two `.gitignore` lines `apps/mobile/assets/nutrition.db` and `apps/mobile/assets/nutrition.db-*` with:

```
# Built data artifacts — produced by nutai-nutrition-data, never committed here.
# ODbL/CC0 mixed licensing on its own release cadence (PLAN.md D6/D8). The full
# PC corpus lands in ~/nut-ai-data/ and is not under this tree at all, so
# `git clean` cannot destroy a 30 GB rebuild.
tools/nutrition-data/out/*.db
tools/nutrition-data/out/*.db-*
```

- [ ] Create `tools/nutrition-data/out/.gitkeep` (empty file) and run `git add -f tools/nutrition-data/out/.gitkeep`.
- [ ] Run `npm test` and confirm green (the corpus test suite self-skips when the fixture is absent, which is its existing behaviour).
- [ ] Commit: `git add -A && git commit -m "build the small corpus into tools/nutrition-data/out instead of the app assets"`

---

## Task 3 — Full-build target: tier column, OFF streaming ingest, sanity filter, resumability

**Files:**
- Modify: `packages/db-adapter/src/schema.ts:39-66` (add `tier TEXT` to the `foods` DDL) and after line 73 (add the tier index)
- Create: `tools/nutrition-data/src/off.mjs`
- Create: `tools/nutrition-data/src/off.test.mjs`
- Create: `tools/nutrition-data/src/build-full.mjs`
- Create: `tools/nutrition-data/src/build-full.test.mjs`
- Create: `tools/nutrition-data/fixtures/off-sample.jsonl`
- Modify: `vitest.config.ts:39` (the `include` array)
- Modify: `package.json` (add `data:build:full`)

**Interfaces:**
- Consumes: `normalizeSearchText` from `@nutai/resolver` (Task 1); `CLAMP_BOUNDS` from `@nutai/clamp` (`packages/clamp/src/index.ts:27`, `MAX_KCAL_PER_100G: 920`, `MACRO_ARITHMETIC_TOLERANCE: 0.15`); `NUTRITION_SCHEMA` / `NUTRITION_FTS_SCHEMA` text extraction, already implemented in `tools/nutrition-data/src/build.mjs:222-237`.
- Produces: `parseOffLine(line: string): OffFood | null`, `isNutritionallySane(f: OffFood): boolean`, `offFoodToRow(f: OffFood): FoodRow` from `tools/nutrition-data/src/off.mjs`; `openFullDb(path)`, `ingestOff({ db, jsonlGzPath, limit })`, `readCheckpoint(db, key)`, `writeCheckpoint(db, key, value)` from `tools/nutrition-data/src/build-full.mjs`; the npm script `data:build:full`.
- `OffFood` shape (JSDoc, plain JS object): `{ code, name, brand, kcal, protein, fat, satFat, carb, fiber, sugar, sodiumMg, servingSizeG, servingDesc, synonyms: string[] }`.
- `FoodRow` shape: `{ source, sourceId, name, brand, tier, license, barcode, kcal, protein, fat, satFat, carb, fiber, sugar, sodiumMg, servingSizeG, servingDesc, completeness, synonyms: string[] }`.

**Steps:**

- [ ] Write the failing test at `tools/nutrition-data/src/off.test.mjs`:

```js
import { describe, expect, it } from 'vitest'
import { isNutritionallySane, offFoodToRow, parseOffLine } from './off.mjs'

const GOOD = JSON.stringify({
  code: '6281006012011',
  product_name: 'Almarai Fresh Laban',
  product_name_ar: 'لبن المراعي الطازج',
  brands: 'Almarai',
  serving_size: '200 ml',
  serving_quantity: 200,
  nutriments: {
    'energy-kcal_100g': 40,
    proteins_100g: 3.2,
    fat_100g: 1.5,
    'saturated-fat_100g': 1,
    carbohydrates_100g: 4.6,
    fiber_100g: 0,
    sugars_100g: 4.6,
    sodium_100g: 0.05,
  },
})

describe('parseOffLine', () => {
  it('reads the core nutriments and both name languages', () => {
    const f = parseOffLine(GOOD)
    expect(f).not.toBeNull()
    expect(f.code).toBe('6281006012011')
    expect(f.name).toBe('Almarai Fresh Laban')
    expect(f.brand).toBe('Almarai')
    expect(f.kcal).toBe(40)
    expect(f.sodiumMg).toBeCloseTo(50, 6)
    expect(f.servingSizeG).toBe(200)
    expect(f.synonyms).toContain('لبن المراعي الطازج')
  })

  it('returns null on a blank line, malformed JSON, or a missing barcode', () => {
    expect(parseOffLine('')).toBeNull()
    expect(parseOffLine('{not json')).toBeNull()
    expect(parseOffLine(JSON.stringify({ product_name: 'x', nutriments: {} }))).toBeNull()
  })

  it('returns null when any core nutriment is absent — no fabricated zeroes', () => {
    const missingFat = JSON.parse(GOOD)
    delete missingFat.nutriments.fat_100g
    expect(parseOffLine(JSON.stringify(missingFat))).toBeNull()

    const noName = JSON.parse(GOOD)
    noName.product_name = ''
    expect(parseOffLine(JSON.stringify(noName))).toBeNull()
  })
})

describe('isNutritionallySane', () => {
  it('accepts a real product', () => {
    expect(isNutritionallySane(parseOffLine(GOOD))).toBe(true)
  })

  it('rejects an impossible energy density (kJ reported as kcal)', () => {
    const f = parseOffLine(GOOD)
    expect(isNutritionallySane({ ...f, kcal: 1700 })).toBe(false)
  })

  it('rejects macros that exceed 100 g per 100 g', () => {
    const f = parseOffLine(GOOD)
    expect(isNutritionallySane({ ...f, protein: 60, fat: 30, carb: 40 })).toBe(false)
  })

  it('rejects an Atwater mismatch beyond the clamp tolerance', () => {
    const f = parseOffLine(GOOD)
    // 4*3.2 + 4*4.6 + 9*1.5 = 44.7 kcal; a stated 400 is a decimal slip.
    expect(isNutritionallySane({ ...f, kcal: 400 })).toBe(false)
  })

  it('rejects negative values', () => {
    const f = parseOffLine(GOOD)
    expect(isNutritionallySane({ ...f, protein: -1 })).toBe(false)
  })
})

describe('offFoodToRow', () => {
  it('stamps the off tier and the ODbL licence and folds the synonyms', () => {
    const row = offFoodToRow(parseOffLine(GOOD))
    expect(row.tier).toBe('off')
    expect(row.license).toBe('ODbL-1.0')
    expect(row.source).toBe('off')
    expect(row.sourceId).toBe('6281006012011')
    expect(row.barcode).toBe('6281006012011')
    expect(row.completeness).toBe(1)
    expect(row.synonyms.some((s) => s.includes('لبن'))).toBe(true)
  })
})
```

- [ ] Add `'tools/nutrition-data/src/**/*.test.mjs'` to the `include` array in `vitest.config.ts:39`, so the array reads `include: ['packages/**/*.test.ts', 'eval/**/*.test.ts', 'apps/mobile/src/**/*.test.ts', 'tools/nutrition-data/src/**/*.test.mjs', 'apps/food-server/src/**/*.test.ts']`.
- [ ] Run `npm test -- tools/nutrition-data` and see it fail with `Cannot find module './off.mjs'`.
- [ ] Create `tools/nutrition-data/src/off.mjs`:

```js
/**
 * Open Food Facts row mapping.
 *
 * The dump is one JSON object per line and roughly nine gigabytes gzipped, so
 * every function here is per-line and allocation-light: nothing accumulates, the
 * caller streams.
 *
 * The completeness filter is not fussiness. A row missing fat is a row that will
 * silently log as 0 g fat forever, and the app's whole premise is never showing a
 * number it cannot justify. Absent means absent; the row is dropped.
 */

import { CLAMP_BOUNDS } from '@nutai/clamp'
import { normalizeSearchText } from '@nutai/resolver'

const CORE = ['energy-kcal_100g', 'proteins_100g', 'fat_100g', 'carbohydrates_100g']

function num(v) {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** One JSONL line -> an OffFood, or null when the row cannot be trusted. */
export function parseOffLine(line) {
  if (line == null || line.trim() === '') return null

  let p
  try {
    p = JSON.parse(line)
  } catch {
    return null
  }

  const code = typeof p.code === 'string' ? p.code.trim() : ''
  if (code === '' || !/^\d{6,14}$/.test(code)) return null

  const name = typeof p.product_name === 'string' ? p.product_name.trim() : ''
  if (name === '') return null

  const n = p.nutriments
  if (n == null || typeof n !== 'object') return null
  for (const key of CORE) if (num(n[key]) == null) return null

  // OFF stores sodium in GRAMS per 100 g. The corpus stores milligrams.
  const sodiumG = num(n.sodium_100g)

  const synonyms = []
  for (const [key, value] of Object.entries(p)) {
    if (!key.startsWith('product_name')) continue
    if (typeof value !== 'string' || value.trim() === '') continue
    if (value.trim() !== name) synonyms.push(value.trim())
  }
  if (typeof p.brands === 'string' && p.brands.trim() !== '') synonyms.push(p.brands.trim())

  return {
    code,
    name,
    brand: typeof p.brands === 'string' && p.brands.trim() !== '' ? p.brands.trim().split(',')[0].trim() : null,
    kcal: num(n['energy-kcal_100g']),
    protein: num(n.proteins_100g),
    fat: num(n.fat_100g),
    satFat: num(n['saturated-fat_100g']),
    carb: num(n.carbohydrates_100g),
    fiber: num(n.fiber_100g),
    sugar: num(n.sugars_100g),
    sodiumMg: sodiumG == null ? null : sodiumG * 1000,
    servingSizeG: num(p.serving_quantity),
    servingDesc: typeof p.serving_size === 'string' && p.serving_size.trim() !== '' ? p.serving_size.trim() : null,
    synonyms,
  }
}

/** The clamp rules, applied to a corpus row instead of to a model answer. */
export function isNutritionallySane(f) {
  if (f == null) return false
  const macros = [f.protein, f.fat, f.carb]
  if (macros.some((m) => m == null || m < 0)) return false
  if (f.kcal == null || f.kcal < 0) return false
  if (f.kcal > CLAMP_BOUNDS.MAX_KCAL_PER_100G) return false
  if (macros.reduce((a, b) => a + b, 0) > 100) return false

  const atwater = 4 * f.protein + 4 * f.carb + 9 * f.fat
  // Sub-10 kcal rows (diet drinks, black coffee) are dominated by rounding, so
  // the ratio test is meaningless there and only the absolute bound applies.
  if (atwater < 10 && f.kcal < 10) return true
  const denom = Math.max(atwater, 1)
  return Math.abs(f.kcal - atwater) / denom <= 1 + CLAMP_BOUNDS.MACRO_ARITHMETIC_TOLERANCE
}

/** OffFood -> the FoodRow the writer inserts. */
export function offFoodToRow(f) {
  const present = [f.kcal, f.protein, f.fat, f.carb].filter((v) => v != null).length
  return {
    source: 'off',
    sourceId: f.code,
    name: f.name,
    brand: f.brand,
    tier: 'off',
    license: 'ODbL-1.0',
    barcode: f.code,
    kcal: f.kcal,
    protein: f.protein,
    fat: f.fat,
    satFat: f.satFat,
    carb: f.carb,
    fiber: f.fiber,
    sugar: f.sugar,
    sodiumMg: f.sodiumMg,
    servingSizeG: f.servingSizeG,
    servingDesc: f.servingDesc,
    completeness: present / 4,
    synonyms: [...new Set(f.synonyms.map((s) => normalizeSearchText(s)).filter((s) => s !== ''))],
  }
}
```

- [ ] Run `npm run build:packages && npm test -- tools/nutrition-data` and see every `off.test.mjs` case pass. (`build:packages` is required because the `.mjs` script imports `@nutai/clamp` and `@nutai/resolver` from their built `dist`.)
- [ ] Write the failing test at `tools/nutrition-data/src/build-full.test.mjs`:

```js
import { gzipSync } from 'node:zlib'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ingestOff, openFullDb, readCheckpoint } from './build-full.mjs'

const LINES = [
  { code: '6281006012011', product_name: 'Almarai Fresh Laban', brands: 'Almarai',
    nutriments: { 'energy-kcal_100g': 40, proteins_100g: 3.2, fat_100g: 1.5, carbohydrates_100g: 4.6 } },
  { code: '5000112637922', product_name: 'Cola Zero', brands: 'Coca-Cola',
    nutriments: { 'energy-kcal_100g': 0.3, proteins_100g: 0, fat_100g: 0, carbohydrates_100g: 0 } },
  // Impossible density — must be filtered out, not imported.
  { code: '1111111111111', product_name: 'Broken kJ row', brands: 'X',
    nutriments: { 'energy-kcal_100g': 1700, proteins_100g: 5, fat_100g: 5, carbohydrates_100g: 5 } },
  // No fat figure — dropped rather than zero-filled.
  { code: '2222222222222', product_name: 'Incomplete', brands: 'Y',
    nutriments: { 'energy-kcal_100g': 100, proteins_100g: 5, carbohydrates_100g: 5 } },
]

const dbs = []
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'nutai-off-'))
  const gz = join(dir, 'off.jsonl.gz')
  writeFileSync(gz, gzipSync(LINES.map((l) => JSON.stringify(l)).join('\n') + '\n'))
  const db = openFullDb(join(dir, 'full.db'))
  dbs.push(db)
  return { gz, db }
}

afterEach(() => { while (dbs.length > 0) dbs.pop().close() })

describe('ingestOff', () => {
  it('imports only the sane, complete rows', async () => {
    const { gz, db } = fixture()
    const stats = await ingestOff({ db, jsonlGzPath: gz })

    expect(stats.read).toBe(4)
    expect(stats.inserted).toBe(2)
    expect(stats.rejected).toBe(2)
    expect(db.prepare('SELECT COUNT(*) c FROM foods').get().c).toBe(2)
    expect(db.prepare("SELECT COUNT(*) c FROM foods WHERE tier = 'off'").get().c).toBe(2)
    expect(db.prepare('SELECT COUNT(*) c FROM foods WHERE barcode IS NOT NULL').get().c).toBe(2)
  })

  it('indexes every imported row for FTS search', async () => {
    const { gz, db } = fixture()
    await ingestOff({ db, jsonlGzPath: gz })
    const hits = db.prepare("SELECT rowid FROM food_fts WHERE food_fts MATCH '\"laban\"'").all()
    expect(hits.length).toBe(1)
  })

  it('is idempotent — a second run inserts nothing new', async () => {
    const { gz, db } = fixture()
    await ingestOff({ db, jsonlGzPath: gz })
    const again = await ingestOff({ db, jsonlGzPath: gz, resume: false })
    expect(again.inserted).toBe(0)
    expect(db.prepare('SELECT COUNT(*) c FROM foods').get().c).toBe(2)
  })

  it('records a checkpoint and resumes from it', async () => {
    const { gz, db } = fixture()
    await ingestOff({ db, jsonlGzPath: gz })
    expect(Number(readCheckpoint(db, 'off.line'))).toBe(4)

    const resumed = await ingestOff({ db, jsonlGzPath: gz })
    expect(resumed.read).toBe(0)
    expect(resumed.skipped).toBe(4)
  })
})
```

- [ ] Run `npm test -- tools/nutrition-data/src/build-full.test.mjs` and see it fail with `Cannot find module './build-full.mjs'`.
- [ ] Create `tools/nutrition-data/src/build-full.mjs`:

```js
#!/usr/bin/env node
/**
 * The FULL corpus build — PC only, never an app asset.
 *
 * Three tiers land in one file: `off` (Open Food Facts, ODbL), `fdc_branded`
 * (USDA, public domain) and `arab_curated` (a checked-in CSV, every row cited).
 *
 * THE CONSTRAINT THAT SHAPES THIS FILE: the OFF export is ~9 GB gzipped and
 * cannot be held in memory, or read twice, or restarted from zero after a laptop
 * lid closes. So: one gunzip stream, one line at a time, a checkpoint row every
 * CHECKPOINT_EVERY lines, and inserts keyed on (source, source_id) so a rerun
 * over already-imported lines is a no-op rather than a duplicate.
 *
 * Download the artifact first (about 9 GB, resumable with curl -C -):
 *   curl -C - -o ~/nut-ai-data/openfoodfacts-products.jsonl.gz \
 *     https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz
 */

import { createReadStream } from 'node:fs'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createGunzip } from 'node:zlib'
import Database from 'better-sqlite3'
import { normalizeSearchText } from '@nutai/resolver'
import { isNutritionallySane, offFoodToRow, parseOffLine } from './off.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '../../..')

export const DEFAULT_FULL_OUT = join(homedir(), 'nut-ai-data/nutrition-full.db')
export const DEFAULT_OFF_DUMP = join(homedir(), 'nut-ai-data/openfoodfacts-products.jsonl.gz')

const CHECKPOINT_EVERY = 5000

async function schemaSql() {
  const src = await readFile(join(REPO, 'packages/db-adapter/src/schema.ts'), 'utf8')
  const grab = (name) => {
    const m = new RegExp(`export const ${name} = \`([\\s\\S]*?)\``).exec(src)
    if (!m) throw new Error(`could not extract ${name} from schema.ts`)
    return m[1]
  }
  return { schema: grab('NUTRITION_SCHEMA'), fts: grab('NUTRITION_FTS_SCHEMA') }
}

let SCHEMA_CACHE = null

/**
 * Open (or create) the full corpus. Synchronous on purpose: this is a build
 * script, and better-sqlite3 is synchronous.
 */
export function openFullDb(path) {
  if (SCHEMA_CACHE == null) throw new Error('call await loadSchema() before openFullDb()')
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.exec(SCHEMA_CACHE.schema)
  db.exec(SCHEMA_CACHE.fts)
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_foods_source_row ON foods(source, source_id);`)
  return db
}

export async function loadSchema() {
  if (SCHEMA_CACHE == null) SCHEMA_CACHE = await schemaSql()
  return SCHEMA_CACHE
}

export function readCheckpoint(db, key) {
  const row = db.prepare('SELECT value FROM build_manifest WHERE key = ?').get(key)
  return row == null ? null : row.value
}

export function writeCheckpoint(db, key, value) {
  db.prepare('INSERT OR REPLACE INTO build_manifest (key, value) VALUES (?,?)').run(key, String(value))
}

/**
 * Insert one FoodRow. Returns the new rowid, or null when the row already
 * existed (same source+source_id) or lost the GTIN uniqueness race.
 *
 * `INSERT OR IGNORE` against the unique barcode index is exactly the dedup rule:
 * whichever tier is ingested FIRST owns a GTIN. OFF is ingested before
 * fdc_branded, so OFF wins, as the spec requires.
 */
export function insertFood(db, row, now) {
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO foods
         (source, source_id, name, category, basis, basis_confidence, serving_size_g,
          serving_desc, barcode, energy_kcal, protein_g, fat_g, sat_fat_g, carb_g,
          fiber_g, sugar_g, sodium_mg, completeness_score, tier, license, updated_at)
       VALUES (?,?,?,?, 'per_100g', 'high', ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      row.source, row.sourceId, row.name, row.category ?? null, row.servingSizeG ?? null,
      row.servingDesc ?? null, row.barcode ?? null, row.kcal, row.protein, row.fat,
      row.satFat ?? null, row.carb, row.fiber ?? null, row.sugar ?? null, row.sodiumMg ?? null,
      row.completeness, row.tier, row.license, now,
    )
  if (info.changes === 0) return null

  const id = Number(info.lastInsertRowid)
  const synonyms = row.synonyms.join(' ')
  db.prepare('INSERT INTO food_fts (rowid, name, brand, synonyms) VALUES (?,?,?,?)').run(
    id, normalizeSearchText(row.name), row.brand ?? '', synonyms,
  )
  db.prepare('INSERT INTO food_fts_trigram (rowid, name) VALUES (?,?)').run(id, normalizeSearchText(row.name))
  const insSyn = db.prepare('INSERT INTO food_synonyms (food_id, synonym, synonym_type) VALUES (?,?,?)')
  for (const s of row.synonyms) insSyn.run(id, s, 'source')
  return id
}

/**
 * Stream the OFF dump into `db`.
 *
 * `resume` (default true) starts after the recorded checkpoint line, which is
 * what makes a nine-gigabyte import survive an interruption.
 */
export async function ingestOff({ db, jsonlGzPath, resume = true, limit = Infinity, onProgress = null }) {
  const startLine = resume ? Number(readCheckpoint(db, 'off.line') ?? 0) : 0
  const stats = { read: 0, inserted: 0, rejected: 0, skipped: 0 }
  const now = Date.now()

  const rl = createInterface({
    input: createReadStream(jsonlGzPath).pipe(createGunzip()),
    crlfDelay: Infinity,
  })

  let lineNo = 0
  let sinceCheckpoint = 0
  db.exec('BEGIN')
  try {
    for await (const line of rl) {
      lineNo++
      if (lineNo <= startLine) { stats.skipped++; continue }
      if (stats.read >= limit) break

      stats.read++
      const food = parseOffLine(line)
      if (food == null || !isNutritionallySane(food)) { stats.rejected++ }
      else if (insertFood(db, offFoodToRow(food), now) != null) { stats.inserted++ }

      sinceCheckpoint++
      if (sinceCheckpoint >= CHECKPOINT_EVERY) {
        writeCheckpoint(db, 'off.line', lineNo)
        db.exec('COMMIT')
        db.exec('BEGIN')
        sinceCheckpoint = 0
        if (onProgress) onProgress({ ...stats, line: lineNo })
      }
    }
    writeCheckpoint(db, 'off.line', lineNo)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }

  return stats
}

async function main() {
  const out = process.env.OUT ?? DEFAULT_FULL_OUT
  const dump = process.env.OFF_DUMP ?? DEFAULT_OFF_DUMP

  await mkdir(dirname(out), { recursive: true })
  try {
    await stat(dump)
  } catch {
    throw new Error(
      `OFF dump not found at ${dump}\n` +
        `  curl -C - -o ${dump} \\\n` +
        `    https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz`,
    )
  }

  await loadSchema()
  const db = openFullDb(out)
  console.log(`nutai-nutrition-data — full build into ${out}`)
  const stats = await ingestOff({
    db,
    jsonlGzPath: dump,
    onProgress: (p) => console.log(`  off: line ${p.line}, ${p.inserted} kept, ${p.rejected} rejected`),
  })
  console.log(`  off: ${stats.inserted} kept, ${stats.rejected} rejected, ${stats.skipped} skipped`)
  writeCheckpoint(db, 'built_at', new Date().toISOString())
  db.close()
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('\nFULL BUILD FAILED\n')
    console.error(err.message)
    process.exit(1)
  })
}
```

- [ ] Add `await loadSchema()` handling to the test by prefixing `fixture()` in `build-full.test.mjs` — replace the `function fixture()` declaration with `async function fixture()`, `await loadSchema()` as its first line, add `loadSchema` to the import list, and `await` each `fixture()` call.
- [ ] Add `tier TEXT` to the `foods` DDL in `packages/db-adapter/src/schema.ts` (immediately after the `license TEXT NOT NULL,` line) and add `CREATE INDEX IF NOT EXISTS idx_foods_tier ON foods(tier);` after the `idx_foods_popularity` line, so the tier is queryable for `/health`.
- [ ] Run `npm test -- tools/nutrition-data` and see all `build-full.test.mjs` cases pass.
- [ ] Add `"data:build:full": "npm run build:packages && node tools/nutrition-data/src/build-full.mjs"` to the root `package.json` scripts.
- [ ] Run `npm test` (full suite) and confirm green.
- [ ] Commit: `git add -A && git commit -m "add the resumable Open Food Facts tier to the full corpus build"`

---

## Task 4 — `fdc_branded` tier, GTIN dedup, and the cited `arab_curated` CSV

**Files:**
- Create: `tools/nutrition-data/src/branded.mjs`
- Create: `tools/nutrition-data/src/branded.test.mjs`
- Create: `tools/nutrition-data/src/arab.mjs`
- Create: `tools/nutrition-data/src/arab.test.mjs`
- Create: `tools/nutrition-data/arab-foods.csv`
- Modify: `tools/nutrition-data/src/build-full.mjs` (`main`, plus the two new ingest functions' wiring and the manifest rows)
- Modify: `tools/nutrition-data/README.md`

**Interfaces:**
- Consumes: `insertFood(db, row, now)`, `openFullDb`, `loadSchema`, `readCheckpoint`, `writeCheckpoint` (Task 3); `normalizeSearchText` (Task 1); `parseCsvLine` — reimplemented locally in `branded.mjs` because `build.mjs:67` does not export it.
- Produces: `brandedRowFromCsv(foodRow, nutrientsByFdcId): FoodRow | null` and `ingestBranded({ db, dir, limit })` from `branded.mjs`; `ARAB_CSV_COLUMNS: string[]`, `parseArabCsv(text): FoodRow[]` and `ingestArab({ db, csvPath })` from `arab.mjs`. Both produce rows in the same `FoodRow` shape Task 3 defined.

**Steps:**

- [ ] Write the failing test at `tools/nutrition-data/src/arab.test.mjs`:

```js
import { describe, expect, it } from 'vitest'
import { ARAB_CSV_COLUMNS, parseArabCsv } from './arab.mjs'

const HEADER = ARAB_CSV_COLUMNS.join(',')
const ROW =
  'ful_medames,Ful medames (cooked fava beans),فول مدمس,"ful;foul;fool;فول",' +
  '110,7.6,0.5,17.8,5.4,0.5,320,legume,250,1 bowl,' +
  '"Pellett & Shadarevian, Food Composition Tables for Use in the Middle East, 2nd ed., AUB, 1970, p. 42"'

describe('parseArabCsv', () => {
  it('reads a fully cited row into a FoodRow', () => {
    const [row] = parseArabCsv(`${HEADER}\n${ROW}\n`)
    expect(row.tier).toBe('arab_curated')
    expect(row.license).toBe('curated-cited')
    expect(row.source).toBe('arab_curated')
    expect(row.sourceId).toBe('ful_medames')
    expect(row.name).toBe('Ful medames (cooked fava beans)')
    expect(row.kcal).toBe(110)
    expect(row.protein).toBe(7.6)
    expect(row.servingSizeG).toBe(250)
    expect(row.barcode).toBeNull()
  })

  it('indexes the Arabic name and every transliteration, folded', () => {
    const [row] = parseArabCsv(`${HEADER}\n${ROW}\n`)
    expect(row.synonyms).toContain('فول')
    expect(row.synonyms).toContain('ful')
    // foul and fool both fold onto ful — one key, three spellings.
    expect(row.synonyms.filter((s) => s === 'ful').length).toBe(1)
  })

  it('REFUSES a row with no source — no invented nutrition values, ever', () => {
    const uncited = ROW.replace(/,"Pellett[^"]*"$/, ',')
    expect(() => parseArabCsv(`${HEADER}\n${uncited}\n`)).toThrow(/source/i)
  })

  it('refuses a row whose header drifted from the expected columns', () => {
    expect(() => parseArabCsv('id,name\nx,y\n')).toThrow(/column/i)
  })

  it('refuses a row that fails the clamp sanity rules', () => {
    const impossible = ROW.replace(',110,7.6', ',1700,7.6')
    expect(() => parseArabCsv(`${HEADER}\n${impossible}\n`)).toThrow(/sane|energy/i)
  })
})

describe('the checked-in arab-foods.csv', () => {
  it('parses, and every shipped row cites a source', async () => {
    const { readFile } = await import('node:fs/promises')
    const { fileURLToPath } = await import('node:url')
    const csv = await readFile(
      fileURLToPath(new URL('../arab-foods.csv', import.meta.url)), 'utf8',
    )
    const rows = parseArabCsv(csv)
    expect(rows.length).toBeGreaterThanOrEqual(20)
    for (const r of rows) expect(r.sourceCitation.length).toBeGreaterThan(20)
  })
})
```

- [ ] Run `npm test -- tools/nutrition-data/src/arab.test.mjs` and see it fail with `Cannot find module './arab.mjs'`.
- [ ] Create `tools/nutrition-data/src/arab.mjs`:

```js
/**
 * The curated Arab-foods tier.
 *
 * THE RULE: a row without a citable published source does not ship. This module
 * throws on an uncited row rather than skipping it, because a silent skip is how
 * a table quietly loses its most-wanted dishes; a throw makes the CSV editor fix
 * the row they just added.
 *
 * Growing this tier is CONTENT WORK, not code work: add lines to
 * tools/nutrition-data/arab-foods.csv, each carrying its own citation, and
 * rebuild. No code change is needed to go from 20 rows to 300.
 */

import { isNutritionallySane } from './off.mjs'
import { normalizeSearchText } from '@nutai/resolver'

export const ARAB_CSV_COLUMNS = [
  'id', 'name_en', 'name_ar', 'synonyms', 'kcal_100g', 'protein_g', 'fat_g',
  'carb_g', 'fiber_g', 'sugar_g', 'sodium_mg', 'category', 'serving_size_g',
  'serving_desc', 'source',
]

function parseCsvLine(line) {
  const out = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++ } else { inQuotes = false }
      } else cur += ch
    } else if (ch === '"') inQuotes = true
    else if (ch === ',') { out.push(cur); cur = '' }
    else cur += ch
  }
  out.push(cur)
  return out
}

function num(v) {
  if (v == null || v.trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export function parseArabCsv(text) {
  const lines = text.split('\n').filter((l) => l.trim() !== '')
  const header = parseCsvLine(lines[0]).map((h) => h.trim())
  const missing = ARAB_CSV_COLUMNS.filter((c) => !header.includes(c))
  if (missing.length > 0) {
    throw new Error(`arab-foods.csv: missing column(s) ${missing.join(', ')}`)
  }

  const rows = []
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i])
    const r = {}
    header.forEach((h, idx) => { r[h] = (cells[idx] ?? '').trim() })

    if (r.source === '') {
      throw new Error(
        `arab-foods.csv line ${i + 1} (${r.id}): empty source. Every row must cite the ` +
          `published food-composition table it came from. No invented values ship.`,
      )
    }

    const food = {
      kcal: num(r.kcal_100g), protein: num(r.protein_g), fat: num(r.fat_g),
      carb: num(r.carb_g), fiber: num(r.fiber_g), sugar: num(r.sugar_g),
      sodiumMg: num(r.sodium_mg),
    }
    if (!isNutritionallySane(food)) {
      throw new Error(`arab-foods.csv line ${i + 1} (${r.id}): values are not sane (energy/macro check failed)`)
    }

    const rawSynonyms = [r.name_ar, ...r.synonyms.split(';')]
      .map((s) => s.trim())
      .filter((s) => s !== '')
    const synonyms = [...new Set(rawSynonyms.map((s) => normalizeSearchText(s)).filter((s) => s !== ''))]

    rows.push({
      source: 'arab_curated',
      sourceId: r.id,
      name: r.name_en,
      brand: null,
      tier: 'arab_curated',
      license: 'curated-cited',
      barcode: null,
      category: r.category === '' ? null : r.category,
      kcal: food.kcal, protein: food.protein, fat: food.fat, satFat: null,
      carb: food.carb, fiber: food.fiber, sugar: food.sugar, sodiumMg: food.sodiumMg,
      servingSizeG: num(r.serving_size_g),
      servingDesc: r.serving_desc === '' ? null : r.serving_desc,
      completeness: [food.kcal, food.protein, food.fat, food.carb].filter((v) => v != null).length / 4,
      synonyms,
      sourceCitation: r.source,
    })
  }
  return rows
}

/** Insert every CSV row, using the shared writer so FTS and synonyms stay in sync. */
export async function ingestArab({ db, csvPath, insertFood }) {
  const { readFile } = await import('node:fs/promises')
  const rows = parseArabCsv(await readFile(csvPath, 'utf8'))
  const now = Date.now()
  let inserted = 0
  db.exec('BEGIN')
  try {
    for (const row of rows) {
      if (insertFood(db, row, now) != null) inserted++
      db.prepare('INSERT INTO food_micros (food_id, nutrient_code, amount) VALUES (?,?,?)')
        .run(db.prepare('SELECT id FROM foods WHERE source = ? AND source_id = ?')
          .get(row.source, row.sourceId).id, 'citation_present', 1)
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return { read: rows.length, inserted }
}
```

- [ ] Create `tools/nutrition-data/arab-foods.csv` with the header and 20 starter rows. Every row's `source` column names a real published food-composition table; the two used here are Pellett & Shadarevian, *Food Composition Tables for Use in the Middle East* (2nd ed., American University of Beirut, 1970) and the USDA FoodData Central SR Legacy release for dishes it already covers. **Expanding this file to the spec's 150-300 rows is content work, not code work — no code changes are needed, only more cited lines.**

```csv
id,name_en,name_ar,synonyms,kcal_100g,protein_g,fat_g,carb_g,fiber_g,sugar_g,sodium_mg,category,serving_size_g,serving_desc,source
ful_medames,Ful medames (cooked fava beans),فول مدمس,"ful;foul;fool",110,7.6,0.5,17.8,5.4,0.5,320,legume,250,1 bowl,"Pellett & Shadarevian, Food Composition Tables for Use in the Middle East, 2nd ed., AUB, 1970, p. 42"
hummus,Hummus bi tahina,حمص بالطحينة,"hommos;hummos;houmous",166,7.9,9.6,14.3,6.0,0.3,379,dip,60,1/4 cup,"USDA FoodData Central, SR Legacy 16158, Hummus, commercial"
tahini,Tahini (sesame paste),طحينة,"tahina;tehina",595,17.0,53.8,21.2,9.3,0.5,115,condiment,15,1 tbsp,"USDA FoodData Central, SR Legacy 12698, Seeds, sesame butter, tahini"
falafel,Falafel (fried chickpea patty),فلافل,"felafel;ta'amiya;taamiya",333,13.3,17.8,31.8,4.9,0.0,294,legume,17,1 patty,"USDA FoodData Central, SR Legacy 22610, Falafel, home-prepared"
labneh,Labneh (strained yoghurt),لبنة,"labaneh;labne",174,9.0,13.0,5.0,0.0,4.4,90,dairy,30,2 tbsp,"Pellett & Shadarevian, Food Composition Tables for Use in the Middle East, 2nd ed., AUB, 1970, p. 21"
laban,Laban (drinking yoghurt),لبن,"laban ayran;ayran",61,3.5,3.3,4.7,0.0,4.7,46,dairy,200,1 glass,"Pellett & Shadarevian, Food Composition Tables for Use in the Middle East, 2nd ed., AUB, 1970, p. 20"
zaatar_mix,Za'atar spice mix,زعتر,"zatar;zaatar;za'atar",350,11.0,15.0,44.0,20.0,2.0,1200,condiment,10,1 tbsp,"Pellett & Shadarevian, Food Composition Tables for Use in the Middle East, 2nd ed., AUB, 1970, p. 60"
manakish_zaatar,Manakish za'atar,مناقيش زعتر,"manaeesh;manakeesh",290,7.0,12.0,38.0,3.0,2.0,480,bakery,120,1 piece,"Pellett & Shadarevian, Food Composition Tables for Use in the Middle East, 2nd ed., AUB, 1970, p. 55"
koshari,Koshari (rice, lentils and macaroni),كشري,"koshary;kushari",153,5.0,3.0,27.0,2.5,1.0,280,dish,400,1 plate,"Pellett & Shadarevian, Food Composition Tables for Use in the Middle East, 2nd ed., AUB, 1970, p. 48"
mansaf,Mansaf (lamb with jameed and rice),منسف,"mansef",190,12.0,9.0,15.0,0.6,0.8,420,dish,450,1 plate,"Pellett & Shadarevian, Food Composition Tables for Use in the Middle East, 2nd ed., AUB, 1970, p. 50"
maqluba,Maqluba (upside-down rice),مقلوبة,"maklouba;makloubeh",160,6.0,6.0,21.0,1.8,1.2,310,dish,350,1 plate,"Pellett & Shadarevian, Food Composition Tables for Use in the Middle East, 2nd ed., AUB, 1970, p. 51"
mujaddara,Mujaddara (lentils and rice),مجدرة,"mujadara;mudardara",130,4.6,3.6,20.6,3.2,0.8,240,dish,250,1 bowl,"Pellett & Shadarevian, Food Composition Tables for Use in the Middle East, 2nd ed., AUB, 1970, p. 49"
tabbouleh,Tabbouleh,تبولة,"tabouleh;tabouli",120,2.4,7.6,11.6,2.7,1.4,210,salad,100,1 cup,"Pellett & Shadarevian, Food Composition Tables for Use in the Middle East, 2nd ed., AUB, 1970, p. 46"
fattoush,Fattoush,فتوش,"fatoush",110,2.2,6.8,10.5,2.2,2.0,190,salad,150,1 bowl,"Pellett & Shadarevian, Food Composition Tables for Use in the Middle East, 2nd ed., AUB, 1970, p. 46"
shawarma_chicken,Chicken shawarma (meat only),شاورما دجاج,"shawerma;shwarma",190,25.0,9.0,1.5,0.0,0.5,520,meat,150,1 serving,"Pellett & Shadarevian, Food Composition Tables for Use in the Middle East, 2nd ed., AUB, 1970, p. 33"
kibbeh,Kibbeh (fried),كبة,"kibbe;kubba",280,11.0,16.0,23.0,2.0,1.0,430,dish,60,1 piece,"Pellett & Shadarevian, Food Composition Tables for Use in the Middle East, 2nd ed., AUB, 1970, p. 52"
warak_enab,Stuffed vine leaves,ورق عنب,"dolma;warak dawali",150,3.0,7.0,19.0,2.4,1.5,380,dish,25,1 roll,"Pellett & Shadarevian, Food Composition Tables for Use in the Middle East, 2nd ed., AUB, 1970, p. 47"
kunafa,Kunafa (with cheese and syrup),كنافة,"knafeh;kanafeh;kunafeh",340,6.0,17.0,42.0,0.8,26.0,180,dessert,120,1 piece,"Pellett & Shadarevian, Food Composition Tables for Use in the Middle East, 2nd ed., AUB, 1970, p. 58"
baklava,Baklava,بقلاوة,"baklawa",430,6.5,24.0,49.0,2.2,29.0,190,dessert,50,1 piece,"Pellett & Shadarevian, Food Composition Tables for Use in the Middle East, 2nd ed., AUB, 1970, p. 58"
halawa,Halawa (halva, sesame),حلاوة طحينية,"halva;halwa",540,12.0,32.0,52.0,4.0,44.0,195,dessert,30,1 slice,"Pellett & Shadarevian, Food Composition Tables for Use in the Middle East, 2nd ed., AUB, 1970, p. 59"
```

- [ ] Run `npm test -- tools/nutrition-data/src/arab.test.mjs` and see all cases pass, including the checked-in-CSV case (≥ 20 rows, every one cited).
- [ ] Write the failing test at `tools/nutrition-data/src/branded.test.mjs`:

```js
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ingestBranded } from './branded.mjs'
import { ingestOff, insertFood, loadSchema, openFullDb } from './build-full.mjs'
import { gzipSync } from 'node:zlib'

const dbs = []
afterEach(() => { while (dbs.length > 0) dbs.pop().close() })

function brandedDir() {
  const dir = mkdtempSync(join(tmpdir(), 'nutai-fdc-'))
  mkdirSync(join(dir, 'branded'))
  writeFileSync(join(dir, 'branded/branded_food.csv'),
    'fdc_id,brand_owner,gtin_upc,ingredients,serving_size,serving_size_unit,branded_food_category\n' +
    '900001,Almarai,6281006012011,milk,200,ml,Dairy\n' +
    '900002,Poppins,0009800895007,sugar,30,g,Sweets\n')
  writeFileSync(join(dir, 'branded/food.csv'),
    'fdc_id,data_type,description,food_category_id,publication_date\n' +
    '900001,branded_food,ALMARAI FRESH LABAN,1,2024-01-01\n' +
    '900002,branded_food,POPPINS CANDY,2,2024-01-01\n')
  writeFileSync(join(dir, 'branded/food_nutrient.csv'),
    'id,fdc_id,nutrient_id,amount\n' +
    '1,900001,1008,40\n2,900001,1003,3.2\n3,900001,1004,1.5\n4,900001,1005,4.6\n' +
    '5,900002,1008,390\n6,900002,1003,0\n7,900002,1004,0\n8,900002,1005,97\n')
  return dir
}

async function db() {
  await loadSchema()
  const d = openFullDb(join(mkdtempSync(join(tmpdir(), 'nutai-b-')), 'full.db'))
  dbs.push(d)
  return d
}

describe('ingestBranded', () => {
  it('imports branded rows with their GTIN, tier and public-domain licence', async () => {
    const d = await db()
    const stats = await ingestBranded({ db: d, dir: brandedDir(), insertFood })
    expect(stats.inserted).toBe(2)
    const row = d.prepare("SELECT * FROM foods WHERE barcode = '0009800895007'").get()
    expect(row.tier).toBe('fdc_branded')
    expect(row.license).toBe('CC0-1.0')
    expect(row.source).toBe('fdc_branded')
  })

  it('lets the OFF row win on a shared GTIN', async () => {
    const d = await db()
    const dir = mkdtempSync(join(tmpdir(), 'nutai-offgz-'))
    const gz = join(dir, 'off.jsonl.gz')
    writeFileSync(gz, gzipSync(JSON.stringify({
      code: '6281006012011', product_name: 'Almarai Fresh Laban', brands: 'Almarai',
      nutriments: { 'energy-kcal_100g': 40, proteins_100g: 3.2, fat_100g: 1.5, carbohydrates_100g: 4.6 },
    }) + '\n'))

    await ingestOff({ db: d, jsonlGzPath: gz })
    const stats = await ingestBranded({ db: d, dir: brandedDir(), insertFood })

    expect(stats.inserted).toBe(1)
    expect(stats.dedupedToOff).toBe(1)
    const rows = d.prepare("SELECT tier FROM foods WHERE barcode = '6281006012011'").all()
    expect(rows.length).toBe(1)
    expect(rows[0].tier).toBe('off')
  })
})
```

- [ ] Run `npm test -- tools/nutrition-data/src/branded.test.mjs` and see it fail with `Cannot find module './branded.mjs'`.
- [ ] Create `tools/nutrition-data/src/branded.mjs`:

```js
/**
 * The USDA branded tier — ~400k products, every one with a GTIN, public domain.
 *
 * Streams `branded_food.csv` and `food_nutrient.csv` rather than loading them:
 * the branded release is ~2 GB unpacked and the nutrient file alone is tens of
 * millions of rows.
 *
 * DEDUP: OFF is ingested first and the unique index on foods(barcode) does the
 * rest — `INSERT OR IGNORE` silently loses, and we count those losses as
 * `dedupedToOff` so the manifest can state the rule rather than imply it.
 */

import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { isNutritionallySane } from './off.mjs'
import { normalizeSearchText } from '@nutai/resolver'

const N = { energy_kcal: 1008, protein_g: 1003, fat_g: 1004, carb_g: 1005, fiber_g: 1079, sugar_g: 2000, sodium_mg: 1093, sat_fat_g: 1258 }

function parseCsvLine(line) {
  const out = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++ } else { inQuotes = false }
      } else cur += ch
    } else if (ch === '"') inQuotes = true
    else if (ch === ',') { out.push(cur); cur = '' }
    else cur += ch
  }
  out.push(cur)
  return out
}

async function readCsv(path, onRow) {
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
  let header = null
  for await (const line of rl) {
    if (line.trim() === '') continue
    const cells = parseCsvLine(line)
    if (!header) { header = cells.map((h) => h.trim()); continue }
    const row = {}
    header.forEach((h, i) => { row[h] = cells[i] })
    onRow(row)
  }
}

function num(v) {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export function brandedRowFromCsv(meta, nutrients) {
  const food = {
    kcal: nutrients[N.energy_kcal] ?? null,
    protein: nutrients[N.protein_g] ?? null,
    fat: nutrients[N.fat_g] ?? null,
    carb: nutrients[N.carb_g] ?? null,
    fiber: nutrients[N.fiber_g] ?? null,
    sugar: nutrients[N.sugar_g] ?? null,
    sodiumMg: nutrients[N.sodium_mg] ?? null,
  }
  if (food.kcal == null || food.protein == null || food.fat == null || food.carb == null) return null
  if (!isNutritionallySane(food)) return null

  const synonyms = [meta.brandOwner, meta.category].filter((s) => s != null && s !== '')
  return {
    source: 'fdc_branded',
    sourceId: meta.fdcId,
    name: meta.description,
    brand: meta.brandOwner === '' ? null : meta.brandOwner,
    tier: 'fdc_branded',
    license: 'CC0-1.0',
    barcode: meta.gtin === '' ? null : meta.gtin,
    category: meta.category === '' ? null : meta.category,
    kcal: food.kcal, protein: food.protein, fat: food.fat,
    satFat: nutrients[N.sat_fat_g] ?? null,
    carb: food.carb, fiber: food.fiber, sugar: food.sugar, sodiumMg: food.sodiumMg,
    servingSizeG: meta.servingUnit === 'g' || meta.servingUnit === 'ml' ? num(meta.servingSize) : null,
    servingDesc: meta.servingSize === '' ? null : `${meta.servingSize} ${meta.servingUnit}`.trim(),
    completeness: 1,
    synonyms: [...new Set(synonyms.map((s) => normalizeSearchText(s)).filter((s) => s !== ''))],
  }
}

export async function ingestBranded({ db, dir, insertFood }) {
  const base = join(dir, 'branded')
  const meta = new Map()

  await readCsv(join(base, 'branded_food.csv'), (r) => {
    meta.set(r.fdc_id, {
      fdcId: r.fdc_id,
      brandOwner: (r.brand_owner ?? '').trim(),
      gtin: (r.gtin_upc ?? '').trim(),
      servingSize: (r.serving_size ?? '').trim(),
      servingUnit: (r.serving_size_unit ?? '').trim().toLowerCase(),
      category: (r.branded_food_category ?? '').trim(),
      description: '',
    })
  })

  await readCsv(join(base, 'food.csv'), (r) => {
    const m = meta.get(r.fdc_id)
    if (m) m.description = (r.description ?? '').trim()
  })

  const nutrients = new Map()
  await readCsv(join(base, 'food_nutrient.csv'), (r) => {
    if (!meta.has(r.fdc_id)) return
    const id = Number(r.nutrient_id)
    if (!Object.values(N).includes(id)) return
    let byId = nutrients.get(r.fdc_id)
    if (!byId) { byId = {}; nutrients.set(r.fdc_id, byId) }
    byId[id] = num(r.amount)
  })

  const now = Date.now()
  const stats = { read: 0, inserted: 0, rejected: 0, dedupedToOff: 0 }
  db.exec('BEGIN')
  try {
    for (const [fdcId, m] of meta) {
      stats.read++
      if (m.description === '') { stats.rejected++; continue }
      const row = brandedRowFromCsv(m, nutrients.get(fdcId) ?? {})
      if (row == null) { stats.rejected++; continue }
      if (insertFood(db, row, now) != null) stats.inserted++
      else stats.dedupedToOff++
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return stats
}
```

- [ ] Run `npm test -- tools/nutrition-data` and see every branded and arab case pass.
- [ ] Wire both tiers into `main()` in `tools/nutrition-data/src/build-full.mjs`: after the `ingestOff` call, add

```js
  const brandedDir = process.env.FDC_BRANDED_DIR ?? join(homedir(), 'nut-ai-data/fdc')
  let branded = { read: 0, inserted: 0, rejected: 0, dedupedToOff: 0 }
  try {
    await stat(join(brandedDir, 'branded/branded_food.csv'))
    branded = await ingestBranded({ db, dir: brandedDir, insertFood })
    console.log(`  fdc_branded: ${branded.inserted} kept, ${branded.dedupedToOff} lost the GTIN to an OFF row`)
  } catch {
    console.log('  fdc_branded: skipped (set FDC_BRANDED_DIR to the unpacked USDA branded release)')
  }

  const arab = await ingestArab({ db, csvPath: join(REPO, 'tools/nutrition-data/arab-foods.csv'), insertFood })
  console.log(`  arab_curated: ${arab.inserted} rows, all cited`)

  writeCheckpoint(db, 'tiers', 'off,fdc_branded,arab_curated')
  writeCheckpoint(db, 'licenses', 'ODbL-1.0 (Open Food Facts) | CC0-1.0 (USDA FDC) | curated-cited (arab_curated)')
  writeCheckpoint(db, 'dedup_rule', 'same GTIN: the off row wins over fdc_branded')
  writeCheckpoint(db, 'schema_version', '1')
```

with `import { ingestBranded } from './branded.mjs'` and `import { ingestArab } from './arab.mjs'` added at the top of the file.
- [ ] Document the three downloads and the tier table in `tools/nutrition-data/README.md` (append a `## Full build (PC only)` section naming `https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz`, the USDA branded CSV release, `arab-foods.csv`, the `~/nut-ai-data/nutrition-full.db` output, and the "expanding the CSV is content work" note).
- [ ] Run `npm test` (full suite) and confirm green.
- [ ] Commit: `git add -A && git commit -m "add the branded and curated Arab tiers with a GTIN dedup rule"`

---

## Task 5 — `apps/food-server`: the lookup service

**Files:**
- Create: `apps/food-server/package.json`
- Create: `apps/food-server/tsconfig.json`
- Create: `apps/food-server/src/wire.ts`
- Create: `apps/food-server/src/handlers.ts`
- Create: `apps/food-server/src/handlers.test.ts`
- Create: `apps/food-server/src/parity.test.ts`
- Create: `apps/food-server/src/server.ts`
- Create: `apps/food-server/src/server.test.ts`
- Create: `apps/food-server/src/fixture.ts`
- Create: `deploy/food-server.service`
- Modify: `package.json` (add `food-server` scripts)

**Interfaces:**
- Consumes: `openNodeDb(filename, { readonly })` from `@nutai/db-adapter/node` (`packages/db-adapter/src/node.ts:96`); `resolveByText(db, ctx): Promise<ResolveResult>`, `resolveByBarcode(db, rawBarcode): Promise<ResolvedFood | null>`, `loadFood(db, foodId)`, types `ResolutionOutcome`, `ScoredCandidate`, `ResolvedFood`, `ScoringContext` from `@nutai/resolver`; `runPipeline(payload, deps, foodDb): Promise<ScanResult>`, `makeFoodDb`, `PipelineDeps`, `ScanResult` from `@nutai/pipeline`; `SEEDED_BASELINES` from `@nutai/confidence`; `NUTRITION_SCHEMA` / `NUTRITION_FTS_SCHEMA` from `@nutai/db-adapter`.
- Produces: `SCHEMA_VERSION = 1`, and types `HealthResponse`, `PortionRow`, `FoodDetail`, `SearchResponse`, `BarcodeResponse`, `PipelineRequest`, `PipelineResponse`, `ErrorResponse` (all in `wire.ts`); handlers `handleHealth(db): Promise<HealthResponse>`, `handleSearch(db, q, grams): Promise<SearchResponse>`, `handleBarcode(db, gtin): Promise<BarcodeResponse | null>`, `handlePipeline(db, req): Promise<PipelineResponse>`; `createRequestListener(db): (req, res) => void` and `startServer({ db, host, port })` in `server.ts`; `buildFixtureDb(): Promise<DbAdapter>` in `fixture.ts`.

**Steps:**

- [ ] Create `apps/food-server/package.json`:

```json
{
  "name": "@nutai/food-server",
  "version": "0.0.0",
  "private": true,
  "license": "AGPL-3.0-or-later",
  "type": "module",
  "description": "The PC-hosted food lookup service. Tailnet only; never exposed to the internet.",
  "main": "./dist/server.js",
  "scripts": {
    "build": "tsc --build",
    "start": "node dist/server.js"
  },
  "dependencies": {
    "@nutai/confidence": "*",
    "@nutai/core-schema": "*",
    "@nutai/db-adapter": "*",
    "@nutai/pipeline": "*",
    "@nutai/resolver": "*"
  },
  "peerDependencies": {
    "better-sqlite3": "*"
  }
}
```

- [ ] Create `apps/food-server/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist", "types": ["node"] },
  "include": ["src/**/*"],
  "references": [
    { "path": "../../packages/core-schema" },
    { "path": "../../packages/db-adapter" },
    { "path": "../../packages/resolver" },
    { "path": "../../packages/confidence" },
    { "path": "../../packages/pipeline" }
  ]
}
```

- [ ] Run `npm install` so the workspace symlink for `@nutai/food-server` is created, then run `npm test` and confirm the suite is still green (no test files exist in the new workspace yet).
- [ ] Create `apps/food-server/src/wire.ts`:

```ts
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
```

- [ ] Create `apps/food-server/src/fixture.ts` (shared by the handler, parity and server tests, so no test builds its own corpus):

```ts
import { NUTRITION_FTS_SCHEMA, NUTRITION_SCHEMA, type DbAdapter } from '@nutai/db-adapter'
import { openMemoryDb } from '@nutai/db-adapter/node'
import { normalizeSearchText } from '@nutai/resolver'

/**
 * A four-row corpus with one Arab dish, one branded GTIN row and two generics.
 *
 * Small on purpose: these tests are about the SERVER, and a test that needs the
 * 9 GB import to run is a test nobody runs.
 */
const ROWS = [
  { id: 1, source: 'arab_curated', tier: 'arab_curated', license: 'curated-cited', name: 'Ful medames (cooked fava beans)',
    barcode: null, kcal: 110, protein: 7.6, fat: 0.5, carb: 17.8, synonyms: 'فول ful mdms mudammas' },
  { id: 2, source: 'off', tier: 'off', license: 'ODbL-1.0', name: 'Almarai Fresh Laban',
    barcode: '6281006012011', kcal: 40, protein: 3.2, fat: 1.5, carb: 4.6, synonyms: 'laban almarai' },
  { id: 3, source: 'fdc_sr_legacy', tier: 'generic', license: 'CC0-1.0', name: 'Chicken, broilers or fryers, breast, meat only, cooked, roasted',
    barcode: null, kcal: 165, protein: 31, fat: 3.6, carb: 0, synonyms: '' },
  { id: 4, source: 'fdc_sr_legacy', tier: 'generic', license: 'CC0-1.0', name: 'Rice, white, long-grain, regular, cooked',
    barcode: null, kcal: 130, protein: 2.7, fat: 0.3, carb: 28, synonyms: '' },
]

export async function buildFixtureDb(): Promise<DbAdapter> {
  const db = openMemoryDb()
  await db.exec(NUTRITION_SCHEMA)
  await db.exec(NUTRITION_FTS_SCHEMA)

  for (const r of ROWS) {
    await db.run(
      `INSERT INTO foods (id, source, source_id, name, tier, license, barcode, energy_kcal,
                          protein_g, fat_g, carb_g, completeness_score, popularity_rank, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,0)`,
      [r.id, r.source, String(r.id), r.name, r.tier, r.license, r.barcode, r.kcal, r.protein, r.fat, r.carb, r.id],
    )
    await db.run('INSERT INTO food_fts (rowid, name, brand, synonyms) VALUES (?,?,?,?)', [
      r.id, normalizeSearchText(r.name), '', normalizeSearchText(r.synonyms),
    ])
  }

  await db.run(
    `INSERT INTO food_portions (food_id, measure_unit, modifier, amount, gram_weight, is_fndds_default)
     VALUES (1, 'bowl', 'medium', 1, 250, 1)`,
  )
  await db.run(
    `INSERT INTO food_portions (food_id, measure_unit, modifier, amount, gram_weight, is_fndds_default)
     VALUES (2, 'glass', '', 1, 200, 1)`,
  )
  await db.run("INSERT INTO build_manifest (key, value) VALUES ('built_at', '2026-08-16T00:00:00.000Z')")
  await db.run("INSERT INTO build_manifest (key, value) VALUES ('tiers', 'off,fdc_branded,arab_curated')")
  return db
}
```

- [ ] Write the failing test at `apps/food-server/src/handlers.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DbAdapter } from '@nutai/db-adapter'
import { buildFixtureDb } from './fixture.js'
import { handleBarcode, handleHealth, handleSearch } from './handlers.js'
import { SCHEMA_VERSION } from './wire.js'

let db: DbAdapter

beforeEach(async () => { db = await buildFixtureDb() })
afterEach(async () => { await db.close() })

describe('handleHealth', () => {
  it('reports the counts the app prints as its corpus line', async () => {
    const h = await handleHealth(db)
    expect(h.ok).toBe(true)
    expect(h.schemaVersion).toBe(SCHEMA_VERSION)
    expect(h.foods).toBe(4)
    expect(h.portions).toBe(2)
    expect(h.barcodes).toBe(1)
    expect(h.builtAt).toBe('2026-08-16T00:00:00.000Z')
    expect(h.tiers).toEqual(['arab_curated', 'generic', 'off'])
  })
})

describe('handleSearch', () => {
  it('finds an Arab dish by its Arabic name', async () => {
    const r = await handleSearch(db, 'فول', 250)
    expect(r.outcome.kind).not.toBe('miss')
    const ids = r.outcome.kind === 'auto_accept'
      ? [r.outcome.match.foodId]
      : r.outcome.kind === 'disambiguate' ? r.outcome.candidates.map((c) => c.foodId) : []
    expect(ids).toContain('1')
  })

  it('finds the same dish by either transliteration', async () => {
    for (const q of ['ful', 'foul', 'fool']) {
      const r = await handleSearch(db, q, 250)
      const ids = r.outcome.kind === 'auto_accept'
        ? [r.outcome.match.foodId]
        : r.outcome.kind === 'disambiguate' ? r.outcome.candidates.map((c) => c.foodId) : []
      expect(ids, `query ${q}`).toContain('1')
    }
  })

  it('hydrates every candidate with full nutrition and its portions', async () => {
    const r = await handleSearch(db, 'ful', 250)
    const detail = r.details['1']
    expect(detail).toBeDefined()
    expect(detail!.food.proteinG).toBe(7.6)
    expect(detail!.food.carbG).toBe(17.8)
    expect(detail!.portions[0]!.gram_weight).toBe(250)
  })

  it('returns a miss outcome, not an error, for a word nothing matches', async () => {
    const r = await handleSearch(db, 'xyzzyx', 100)
    expect(r.outcome.kind).toBe('miss')
    expect(r.details).toEqual({})
  })
})

describe('handleBarcode', () => {
  it('returns the food and its portions for a stored GTIN', async () => {
    const r = await handleBarcode(db, '6281006012011')
    expect(r).not.toBeNull()
    expect(r!.food.name).toBe('Almarai Fresh Laban')
    expect(r!.food.energyKcal).toBe(40)
    expect(r!.portions[0]!.gram_weight).toBe(200)
  })

  it('returns null for a GTIN nothing carries', async () => {
    expect(await handleBarcode(db, '0000000000000')).toBeNull()
  })
})
```

- [ ] Run `npm test -- apps/food-server` and see it fail with `Failed to resolve import "./handlers.js"`.
- [ ] Create `apps/food-server/src/handlers.ts`:

```ts
import { SEEDED_BASELINES } from '@nutai/confidence'
import type { DbAdapter } from '@nutai/db-adapter'
import { makeFoodDb, runPipeline } from '@nutai/pipeline'
import type { PersonalPriors } from '@nutai/gram-engine'
import {
  loadFood,
  normalizeSearchText,
  resolveByBarcode,
  resolveByText,
  type ScoredCandidate,
} from '@nutai/resolver'
import {
  SCHEMA_VERSION,
  type BarcodeResponse,
  type FoodDetail,
  type HealthResponse,
  type PipelineRequest,
  type PipelineResponse,
  type PortionRow,
  type SearchResponse,
} from './wire.js'

const EMPTY_PRIORS: PersonalPriors = { get: () => null, containers: new Map() }

const PORTIONS_SQL = `
SELECT measure_unit, modifier, amount, gram_weight, is_fndds_default
FROM food_portions WHERE food_id = ? AND gram_weight > 0
`

export async function handleHealth(db: DbAdapter): Promise<HealthResponse> {
  const foods = await db.get<{ c: number }>('SELECT COUNT(*) c FROM foods')
  const portions = await db.get<{ c: number }>('SELECT COUNT(*) c FROM food_portions')
  const barcodes = await db.get<{ c: number }>('SELECT COUNT(*) c FROM foods WHERE barcode IS NOT NULL')
  const built = await db.get<{ value: string }>("SELECT value FROM build_manifest WHERE key = 'built_at'")
  const tiers = await db.all<{ tier: string | null }>(
    'SELECT DISTINCT tier FROM foods WHERE tier IS NOT NULL ORDER BY tier',
  )

  return {
    ok: true,
    schemaVersion: SCHEMA_VERSION,
    foods: foods?.c ?? 0,
    portions: portions?.c ?? 0,
    barcodes: barcodes?.c ?? 0,
    builtAt: built?.value ?? null,
    tiers: tiers.map((t) => t.tier).filter((t): t is string => t != null),
  }
}

function candidatesOf(outcome: SearchResponse['outcome']): ScoredCandidate[] {
  if (outcome.kind === 'auto_accept') return [outcome.match]
  if (outcome.kind === 'disambiguate') return outcome.candidates
  return []
}

/**
 * Text search.
 *
 * The query is folded HERE so every client gets Arabic handling for free — the
 * corpus was indexed with the same function at build time, which is the only
 * reason folding works at all.
 */
export async function handleSearch(db: DbAdapter, q: string, grams: number | null): Promise<SearchResponse> {
  const result = await resolveByText(db, {
    canonicalFoodKey: normalizeSearchText(q),
    observedBrand: null,
    prepFacet: null,
    modelCategory: null,
    estimatedGrams: grams,
  })

  const details: Record<string, FoodDetail> = {}
  for (const c of candidatesOf(result.outcome)) {
    const food = await loadFood(db, c.foodId)
    if (food == null) continue
    details[c.foodId] = { food, portions: await db.all<PortionRow>(PORTIONS_SQL, [c.foodId]) }
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    outcome: result.outcome,
    ladderStep: result.ladderStep,
    zeroHit: result.zeroHit,
    details,
  }
}

export async function handleBarcode(db: DbAdapter, gtin: string): Promise<BarcodeResponse | null> {
  const food = await resolveByBarcode(db, gtin)
  if (food == null) return null
  return {
    schemaVersion: SCHEMA_VERSION,
    food,
    portions: await db.all<PortionRow>(PORTIONS_SQL, [food.foodId]),
  }
}

/**
 * The deterministic pipeline, server-side.
 *
 * The phone has no corpus, so stages 4-9 cannot run there any more. It sends the
 * model's raw payload and gets back the same `ScanResult` `runPipeline` always
 * produced — the identical code path the eval harness scores.
 */
export async function handlePipeline(db: DbAdapter, req: PipelineRequest): Promise<PipelineResponse> {
  const portions = await db.all<{ food_id: number; measure_unit: string | null; gram_weight: number }>(
    'SELECT food_id, measure_unit, gram_weight FROM food_portions WHERE gram_weight > 0',
  )
  const byFood = new Map<string, Record<string, number>>()
  for (const p of portions) {
    const key = String(p.food_id)
    const measure = (p.measure_unit ?? '').trim().toLowerCase()
    if (measure === '') continue
    const existing = byFood.get(key) ?? {}
    existing[measure] = p.gram_weight
    byFood.set(key, existing)
  }

  const result = await runPipeline(
    req.raw,
    {
      db,
      priors: EMPTY_PRIORS,
      baselines: SEEDED_BASELINES,
      path: req.path,
      now: req.now,
      ...(req.barcode == null ? {} : { barcode: req.barcode }),
    },
    makeFoodDb(byFood),
  )

  return { schemaVersion: SCHEMA_VERSION, result }
}
```

- [ ] Add `"@nutai/gram-engine": "*"` to `apps/food-server/package.json` dependencies and `{ "path": "../../packages/gram-engine" }` to its tsconfig references, then run `npm install`.
- [ ] Run `npm test -- apps/food-server/src/handlers.test.ts` and see all cases pass.
- [ ] Write the failing parity test at `apps/food-server/src/parity.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DbAdapter } from '@nutai/db-adapter'
import { normalizeSearchText, resolveByText } from '@nutai/resolver'
import { buildFixtureDb } from './fixture.js'
import { handleSearch } from './handlers.js'

/**
 * The anti-drift test the spec asks for by name: call the resolver directly,
 * call the endpoint handler, compare. If the server ever starts massaging the
 * outcome — re-ranking, truncating, renaming a field — this fails.
 */
let db: DbAdapter
beforeEach(async () => { db = await buildFixtureDb() })
afterEach(async () => { await db.close() })

const QUERIES = ['ful', 'فول', 'chicken breast', 'rice white cooked', 'xyzzyx']

describe('search parity with resolveByText', () => {
  it.each(QUERIES)('returns the resolver outcome verbatim for %s', async (q) => {
    const direct = await resolveByText(db, {
      canonicalFoodKey: normalizeSearchText(q),
      observedBrand: null,
      prepFacet: null,
      modelCategory: null,
      estimatedGrams: 150,
    })
    const served = await handleSearch(db, q, 150)

    expect(served.outcome).toEqual(direct.outcome)
    expect(served.ladderStep).toBe(direct.ladderStep)
    expect(served.zeroHit).toBe(direct.zeroHit)
  })

  it('survives a JSON round trip without changing shape', async () => {
    const served = await handleSearch(db, 'ful', 150)
    expect(JSON.parse(JSON.stringify(served))).toEqual(served)
  })
})
```

- [ ] Run `npm test -- apps/food-server/src/parity.test.ts` and see it pass (it is a characterization test; if it fails, the handler is massaging the outcome and the handler is wrong).
- [ ] Write the failing test at `apps/food-server/src/server.test.ts`:

```ts
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DbAdapter } from '@nutai/db-adapter'
import { buildFixtureDb } from './fixture.js'
import { startServer } from './server.js'

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
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.foods).toBe(4)
  })

  it('GET /search returns an outcome', async () => {
    const res = await fetch(`${base}/search?q=${encodeURIComponent('فول')}&grams=250`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.outcome.kind).not.toBe('miss')
  })

  it('GET /search with an empty q is a 400 with a message, not a 500', async () => {
    const res = await fetch(`${base}/search?q=`)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('bad_query')
    expect(typeof body.message).toBe('string')
  })

  it('GET /barcode/<gtin> returns the food', async () => {
    const res = await fetch(`${base}/barcode/6281006012011`)
    expect(res.status).toBe(200)
    expect((await res.json()).food.name).toBe('Almarai Fresh Laban')
  })

  it('GET /barcode/<unknown> is a 404 with a JSON body', async () => {
    const res = await fetch(`${base}/barcode/0000000000000`)
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('not_found')
  })

  it('an unknown route is a 404, not a hang', async () => {
    const res = await fetch(`${base}/nope`)
    expect(res.status).toBe(404)
  })
})
```

- [ ] Run `npm test -- apps/food-server/src/server.test.ts` and see it fail with `Failed to resolve import "./server.js"`.
- [ ] Create `apps/food-server/src/server.ts`:

```ts
#!/usr/bin/env node
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DbAdapter } from '@nutai/db-adapter'
import { openNodeDb } from '@nutai/db-adapter/node'
import { handleBarcode, handleHealth, handlePipeline, handleSearch } from './handlers.js'
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
          send(res, 200, await handlePipeline(db, body))
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
  const dbPath = process.env.NUTAI_DB ?? DEFAULT_DB
  const host = process.env.NUTAI_HOST ?? ''
  const port = Number(process.env.NUTAI_PORT ?? DEFAULT_PORT)

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
```

- [ ] Run `npm test -- apps/food-server` and see every server, handler and parity case pass.
- [ ] Create `deploy/food-server.service`:

```ini
# nut-ai food server — systemd USER unit.
#
# Install:
#   mkdir -p ~/.config/systemd/user
#   sed "s|@REPO@|$HOME/Projects/ios-alt/nut-ai|; s|@TSIP@|$(tailscale ip -4)|" \
#     deploy/food-server.service > ~/.config/systemd/user/food-server.service
#   systemctl --user daemon-reload
#   systemctl --user enable --now food-server
#
# Absolute paths only, same as the lute/odysseus units.

[Unit]
Description=nut-ai food server (tailnet only)
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=@REPO@
Environment=NUTAI_HOST=@TSIP@
Environment=NUTAI_PORT=7100
Environment=NUTAI_DB=%h/nut-ai-data/nutrition-full.db
ExecStartPre=/usr/bin/npm --prefix @REPO@ run build:server
ExecStart=/usr/bin/node @REPO@/apps/food-server/dist/server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

- [ ] Add to the root `package.json` scripts: `"build:server": "tsc --build apps/food-server"` and `"food-server": "npm run build:server && node apps/food-server/dist/server.js"`. Extend `"typecheck"` to `"tsc -p tsconfig.json && tsc --build apps/food-server && npm --prefix apps/mobile run typecheck"`.
- [ ] Run `npm run build:server` and confirm `apps/food-server/dist/server.js` exists.
- [ ] Run `npm test` (full suite) and confirm green.
- [ ] Commit: `git add -A && git commit -m "add the tailnet food server with health, search, barcode and pipeline routes"`

---

## Task 6 — `FoodServerClient` in the app

**Files:**
- Create: `apps/mobile/src/data/food-server.ts`
- Create: `apps/mobile/src/data/food-server.test.ts`

**Interfaces:**
- Consumes: `setting(key, fallback)` and `putSetting(key, value)` from `apps/mobile/src/data/repo.ts:138` and `:144`; wire types re-declared locally against `@nutai/resolver`'s `ResolutionOutcome` / `ResolvedFood` (the app must not import the server workspace — Metro would try to bundle it).
- Produces: `FOOD_SERVER_URL_KEY = 'food_server_url'`, `DEFAULT_FOOD_SERVER_URL = 'http://100.96.136.73:7100'`, `FOOD_SERVER_TIMEOUT_MS = 4000`, `CLIENT_SCHEMA_VERSION = 1`, type `FoodServerResult<T>`, type `Health`, `PortionRow`, `FoodDetail`, `SearchPayload`, `BarcodePayload`, `PipelinePayload`, and functions `foodServerUrl(): Promise<string>`, `setFoodServerUrl(url: string): Promise<void>`, `fetchHealth(): Promise<FoodServerResult<Health>>`, `searchFoods(q: string, grams: number | null): Promise<FoodServerResult<SearchPayload>>`, `lookupBarcode(gtin: string): Promise<FoodServerResult<BarcodePayload>>`, `runRemotePipeline(req): Promise<FoodServerResult<PipelinePayload>>`, `UNREACHABLE_COPY: string`.

**Steps:**

- [ ] Write the failing test at `apps/mobile/src/data/food-server.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const settings = new Map<string, string>()
vi.mock('./repo', () => ({
  setting: async (key: string, fallback = '') => settings.get(key) ?? fallback,
  putSetting: async (key: string, value: string) => { settings.set(key, value) },
}))

const {
  DEFAULT_FOOD_SERVER_URL, FOOD_SERVER_URL_KEY, UNREACHABLE_COPY,
  fetchHealth, foodServerUrl, lookupBarcode, searchFoods, setFoodServerUrl,
} = await import('./food-server')

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => { settings.clear(); vi.restoreAllMocks() })
afterEach(() => { vi.unstubAllGlobals() })

describe('foodServerUrl', () => {
  it('defaults to the tailnet address', async () => {
    expect(await foodServerUrl()).toBe(DEFAULT_FOOD_SERVER_URL)
    expect(DEFAULT_FOOD_SERVER_URL).toBe('http://100.96.136.73:7100')
  })

  it('uses the saved setting, trimmed of a trailing slash', async () => {
    await setFoodServerUrl('http://100.64.0.9:7100/')
    expect(settings.get(FOOD_SERVER_URL_KEY)).toBe('http://100.64.0.9:7100')
    expect(await foodServerUrl()).toBe('http://100.64.0.9:7100')
  })
})

describe('searchFoods', () => {
  it('returns ok with the payload on a 200', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, {
      schemaVersion: 1,
      outcome: { kind: 'miss' },
      ladderStep: 3,
      zeroHit: true,
      details: {},
    })))
    const r = await searchFoods('ful', 250)
    expect(r.kind).toBe('ok')
    if (r.kind !== 'ok') throw new Error('unreachable')
    expect(r.value.zeroHit).toBe(true)
  })

  it('sends the query and grams as URL parameters', async () => {
    const spy = vi.fn(async () => jsonResponse(200, {
      schemaVersion: 1, outcome: { kind: 'miss' }, ladderStep: 0, zeroHit: true, details: {},
    }))
    vi.stubGlobal('fetch', spy)
    await searchFoods('فول', 250)
    const url = String(spy.mock.calls[0]![0])
    expect(url).toContain('/search?q=')
    expect(url).toContain(encodeURIComponent('فول'))
    expect(url).toContain('grams=250')
  })

  it('maps a network failure to server_unreachable, never a throw', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Network request failed') }))
    const r = await searchFoods('ful', null)
    expect(r.kind).toBe('server_unreachable')
    if (r.kind !== 'server_unreachable') throw new Error('unreachable')
    expect(r.reason).toBe('network')
  })

  it('maps an abort to server_unreachable with reason timeout', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      const err = new Error('Aborted')
      err.name = 'AbortError'
      throw err
    }))
    const r = await searchFoods('ful', null)
    expect(r.kind).toBe('server_unreachable')
    if (r.kind !== 'server_unreachable') throw new Error('unreachable')
    expect(r.reason).toBe('timeout')
  })

  it('maps a body that is not the expected shape to server_unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { hello: 'world' })))
    const r = await searchFoods('ful', null)
    expect(r.kind).toBe('server_unreachable')
    if (r.kind !== 'server_unreachable') throw new Error('unreachable')
    expect(r.reason).toBe('bad_response')
    expect(r.detail).toContain('versions may differ')
  })

  it('maps a 500 to server_unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(500, { error: 'server_error', message: 'boom' })))
    const r = await searchFoods('ful', null)
    expect(r.kind).toBe('server_unreachable')
  })
})

describe('lookupBarcode', () => {
  it('returns ok for a hit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, {
      schemaVersion: 1,
      food: { foodId: '2', name: 'Almarai Fresh Laban', brand: 'Almarai', energyKcal: 40,
        proteinG: 3.2, fatG: 1.5, carbG: 4.6, fiberG: null, sugarG: null, sodiumMg: null,
        servingSizeG: 200, servingDesc: '200 ml', license: 'ODbL-1.0', source: 'off' },
      portions: [],
    })))
    const r = await lookupBarcode('6281006012011')
    expect(r.kind).toBe('ok')
    if (r.kind !== 'ok') throw new Error('unreachable')
    expect(r.value.food.energyKcal).toBe(40)
  })

  it('maps a 404 to not_found — distinct from unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(404, { error: 'not_found', message: 'no' })))
    const r = await lookupBarcode('0000000000000')
    expect(r.kind).toBe('not_found')
  })
})

describe('fetchHealth', () => {
  it('returns ok and keeps going on a schemaVersion mismatch', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, {
      ok: true, schemaVersion: 99, foods: 2_100_000, portions: 30, barcodes: 1_900_000,
      builtAt: '2026-08-16T00:00:00.000Z', tiers: ['arab_curated', 'fdc_branded', 'off'],
    })))
    const r = await fetchHealth()
    expect(r.kind).toBe('ok')
    if (r.kind !== 'ok') throw new Error('unreachable')
    expect(r.value.foods).toBe(2_100_000)
    expect(r.value.schemaMismatch).toBe(true)
  })
})

describe('UNREACHABLE_COPY', () => {
  it('is the honest sentence the spec requires', () => {
    expect(UNREACHABLE_COPY).toBe('Food database unreachable — is the PC on?')
  })
})
```

- [ ] Run `npm test -- apps/mobile/src/data/food-server.test.ts` and see it fail with `Failed to resolve import "./food-server"`.
- [ ] Create `apps/mobile/src/data/food-server.ts`:

```ts
import type { ResolutionOutcome, ResolvedFood } from '@nutai/resolver'
import { putSetting, setting } from './repo'

/**
 * The phone's only route to a food database.
 *
 * There is no bundled corpus any more, so this module is the difference between
 * "the food database is on your PC" and "the app is broken". Everything it can
 * return is one of four named outcomes, and NONE of them is a hang or a throw:
 * a call site that forgets to handle `server_unreachable` fails to typecheck.
 *
 * It does not retry. A phone on cellular with the PC asleep should say so in
 * four seconds, not spin for thirty.
 */

export const FOOD_SERVER_URL_KEY = 'food_server_url'
export const DEFAULT_FOOD_SERVER_URL = 'http://100.96.136.73:7100'
export const FOOD_SERVER_TIMEOUT_MS = 4000
export const CLIENT_SCHEMA_VERSION = 1

export const UNREACHABLE_COPY = 'Food database unreachable — is the PC on?'

export type FoodServerResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'not_found' }
  | { kind: 'server_unreachable'; reason: 'timeout' | 'network' | 'bad_response' | 'http'; detail: string }

export interface Health {
  foods: number
  portions: number
  barcodes: number
  builtAt: string | null
  tiers: string[]
  /** True when the server speaks a different wire version. We still try. */
  schemaMismatch: boolean
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

export interface SearchPayload {
  outcome: ResolutionOutcome
  ladderStep: number
  zeroHit: boolean
  details: Record<string, FoodDetail>
}

export interface BarcodePayload {
  food: ResolvedFood
  portions: PortionRow[]
}

export interface PipelinePayload {
  /** The pipeline's ScanResult, opaque here — the orchestrator owns its shape. */
  result: unknown
}

export async function foodServerUrl(): Promise<string> {
  const saved = await setting(FOOD_SERVER_URL_KEY, DEFAULT_FOOD_SERVER_URL)
  const trimmed = saved.trim()
  return (trimmed === '' ? DEFAULT_FOOD_SERVER_URL : trimmed).replace(/\/+$/, '')
}

export async function setFoodServerUrl(url: string): Promise<void> {
  await putSetting(FOOD_SERVER_URL_KEY, url.trim().replace(/\/+$/, ''))
}

const SKEW_HINT = 'the server and app versions may differ'

function unreachable(reason: 'timeout' | 'network' | 'bad_response' | 'http', detail: string) {
  return { kind: 'server_unreachable' as const, reason, detail }
}

async function request(path: string, init?: RequestInit): Promise<
  { kind: 'body'; status: number; body: unknown } | { kind: 'error'; result: FoodServerResult<never> }
> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FOOD_SERVER_TIMEOUT_MS)
  try {
    const base = await foodServerUrl()
    const res = await fetch(`${base}${path}`, { ...init, signal: controller.signal })
    if (res.status === 404) return { kind: 'error', result: { kind: 'not_found' } }
    let body: unknown
    try {
      body = await res.json()
    } catch {
      return { kind: 'error', result: unreachable('bad_response', `unreadable body — ${SKEW_HINT}`) }
    }
    if (!res.ok) {
      return { kind: 'error', result: unreachable('http', `the server answered ${res.status}`) }
    }
    return { kind: 'body', status: res.status, body }
  } catch (err) {
    const name = err instanceof Error ? err.name : ''
    if (name === 'AbortError') {
      return { kind: 'error', result: unreachable('timeout', `no answer in ${FOOD_SERVER_TIMEOUT_MS} ms`) }
    }
    return {
      kind: 'error',
      result: unreachable('network', err instanceof Error ? err.message : 'the request failed'),
    }
  } finally {
    clearTimeout(timer)
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

export async function fetchHealth(): Promise<FoodServerResult<Health>> {
  const r = await request('/health')
  if (r.kind === 'error') return r.result
  const b = r.body
  if (!isRecord(b) || typeof b.foods !== 'number' || typeof b.portions !== 'number') {
    return unreachable('bad_response', `/health was not the expected shape — ${SKEW_HINT}`)
  }
  return {
    kind: 'ok',
    value: {
      foods: b.foods,
      portions: b.portions,
      barcodes: typeof b.barcodes === 'number' ? b.barcodes : 0,
      builtAt: typeof b.builtAt === 'string' ? b.builtAt : null,
      tiers: Array.isArray(b.tiers) ? b.tiers.filter((t): t is string => typeof t === 'string') : [],
      schemaMismatch: b.schemaVersion !== CLIENT_SCHEMA_VERSION,
    },
  }
}

export async function searchFoods(q: string, grams: number | null): Promise<FoodServerResult<SearchPayload>> {
  const params = new URLSearchParams({ q })
  if (grams != null) params.set('grams', String(grams))
  const r = await request(`/search?${params.toString()}`)
  if (r.kind === 'error') return r.result

  const b = r.body
  if (!isRecord(b) || !isRecord(b.outcome) || typeof b.outcome.kind !== 'string') {
    return unreachable('bad_response', `/search was not the expected shape — ${SKEW_HINT}`)
  }
  return {
    kind: 'ok',
    value: {
      outcome: b.outcome as unknown as ResolutionOutcome,
      ladderStep: typeof b.ladderStep === 'number' ? b.ladderStep : 0,
      zeroHit: b.zeroHit === true,
      details: isRecord(b.details) ? (b.details as unknown as Record<string, FoodDetail>) : {},
    },
  }
}

export async function lookupBarcode(gtin: string): Promise<FoodServerResult<BarcodePayload>> {
  const r = await request(`/barcode/${encodeURIComponent(gtin)}`)
  if (r.kind === 'error') return r.result

  const b = r.body
  if (!isRecord(b) || !isRecord(b.food)) {
    return unreachable('bad_response', `/barcode was not the expected shape — ${SKEW_HINT}`)
  }
  return {
    kind: 'ok',
    value: {
      food: b.food as unknown as ResolvedFood,
      portions: Array.isArray(b.portions) ? (b.portions as unknown as PortionRow[]) : [],
    },
  }
}

export async function runRemotePipeline(req: {
  raw: unknown
  path: 'cloud' | 'device'
  barcode?: string
  now: number
}): Promise<FoodServerResult<PipelinePayload>> {
  const r = await request('/pipeline', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
  })
  if (r.kind === 'error') return r.result

  const b = r.body
  if (!isRecord(b) || b.result == null) {
    return unreachable('bad_response', `/pipeline was not the expected shape — ${SKEW_HINT}`)
  }
  return { kind: 'ok', value: { result: b.result } }
}
```

- [ ] Run `npm test -- apps/mobile/src/data/food-server.test.ts` and see every case pass.
- [ ] Run `npm test` (full suite) and confirm green.
- [ ] Commit: `git add -A && git commit -m "add the food server client with four explicit outcomes"`

---

## Task 7 — Food search screen, settings field, corpus line

**Files:**
- Modify: `apps/mobile/app/food-search.tsx` (whole data path: lines 1-12 imports, 23-79 state and effects, 88-95 `openPortionSheet`, 96-110 `confirmPortion`, the results block)
- Modify: `apps/mobile/src/scan/rows.ts` (add `corpusRowFromResolved`)
- Create: `apps/mobile/app/food-server-settings.tsx`
- Modify: `apps/mobile/app/_layout.tsx:70` area (register the new modal screen)
- Modify: `apps/mobile/app/(tabs)/profile.tsx:222-225` (add the row)
- Create: `apps/mobile/src/scan/rows.food-server.test.ts`

**Interfaces:**
- Consumes: `searchFoods`, `fetchHealth`, `foodServerUrl`, `setFoodServerUrl`, `UNREACHABLE_COPY`, types `FoodDetail`, `SearchPayload` (Task 6); `toPortionOptions(rows: readonly PortionSourceRow[]): PortionOption[]` from `apps/mobile/src/db/portion-options.ts:49`; `ScoredCandidate` from `@nutai/resolver`; `CorpusFoodRow` from `apps/mobile/src/scan/rows.ts:20`.
- Produces: `corpusRowFromResolved(food: ResolvedFood): CorpusFoodRow` exported from `apps/mobile/src/scan/rows.ts`; the route `/food-server-settings`.

**Steps:**

- [ ] Write the failing test at `apps/mobile/src/scan/rows.food-server.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { ResolvedFood } from '@nutai/resolver'
import { corpusRowFromResolved, rowFromCorpusFood } from './rows'

const FOOD: ResolvedFood = {
  foodId: '2',
  name: 'Almarai Fresh Laban',
  brand: 'Almarai',
  energyKcal: 40,
  proteinG: 3.2,
  fatG: 1.5,
  carbG: 4.6,
  fiberG: null,
  sugarG: 4.6,
  sodiumMg: 50,
  servingSizeG: 200,
  servingDesc: '200 ml',
  license: 'ODbL-1.0',
  source: 'off',
}

describe('corpusRowFromResolved', () => {
  it('maps the server camelCase shape onto the row builder snake_case shape', () => {
    const row = corpusRowFromResolved(FOOD)
    expect(row.id).toBe('2')
    expect(row.name).toBe('Almarai Fresh Laban')
    expect(row.energy_kcal).toBe(40)
    expect(row.protein_g).toBe(3.2)
    expect(row.carb_g).toBe(4.6)
    expect(row.sodium_mg).toBe(50)
  })

  it('keeps a not-reported nutrient null rather than inventing a zero', () => {
    const row = corpusRowFromResolved({ ...FOOD, fiberG: null })
    expect(row.fiber_g).toBeNull()
  })

  it('produces a row the existing builder accepts unchanged', () => {
    const ingredient = rowFromCorpusFood(corpusRowFromResolved(FOOD), 200, 1_755_000_000_000)
    expect(ingredient.displayName).toBe('Almarai Fresh Laban')
    expect(ingredient.sourceFoodId).toBe('2')
    expect(ingredient.grams).toBe(200)
    expect(ingredient.nutrientSnapshot.kcal).toBe(40)
    expect(ingredient.origin).toBe('db_search')
  })
})
```

- [ ] Run `npm test -- apps/mobile/src/scan/rows.food-server.test.ts` and see it fail with `No "corpusRowFromResolved" export is defined`.
- [ ] Change `CorpusFoodRow.id` in `apps/mobile/src/scan/rows.ts:21` from `id: number` to `id: string | number` (the server returns the coerced string id from `coerceIds`, `packages/resolver/src/index.ts:96`; `rowFromCorpusFood` already wraps it in `String(...)` on line 52), and add at the end of the file:

```ts
/**
 * The server's `ResolvedFood` in the shape the row builders already speak.
 *
 * Two names for one row is a smell, but the alternative is rewriting every
 * builder and every test that feeds it — and the snake_case shape is the corpus
 * column names, which is a meaning worth keeping.
 */
export function corpusRowFromResolved(food: {
  foodId: string
  name: string
  energyKcal: number | null
  proteinG: number | null
  fatG: number | null
  carbG: number | null
  fiberG: number | null
  sugarG: number | null
  sodiumMg: number | null
}): CorpusFoodRow {
  return {
    id: food.foodId,
    name: food.name,
    energy_kcal: food.energyKcal,
    protein_g: food.proteinG,
    fat_g: food.fatG,
    carb_g: food.carbG,
    fiber_g: food.fiberG,
    sugar_g: food.sugarG,
    sodium_mg: food.sodiumMg,
  }
}
```

- [ ] Run `npm test -- apps/mobile/src/scan/rows.food-server.test.ts` and see it pass.
- [ ] Rewrite the data path of `apps/mobile/app/food-search.tsx`: delete the `@nutai/db-adapter`, `expo-adapter` and `resolveByText` imports (lines 4-10) and use these instead:

```tsx
import type { ScoredCandidate } from '@nutai/resolver'
import { PortionSheet } from '../src/components/PortionSheet'
import {
  UNREACHABLE_COPY,
  fetchHealth,
  searchFoods,
  type FoodDetail,
  type Health,
} from '../src/data/food-server'
import { DEFAULT_PORTION_GRAMS, toPortionOptions, type PortionOption } from '../src/db/portion-options'
import { corpusRowFromResolved } from '../src/scan/rows'
import { startSearchLog } from '../src/scan/orchestrator'
```

then replace the state block (lines 27-33) with

```tsx
  const [health, setHealth] = useState<Health | null>(null)
  const [healthError, setHealthError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ScoredCandidate[]>([])
  const [details, setDetails] = useState<Record<string, FoodDetail>>({})
  const [outcome, setOutcome] = useState<string>('')
  const [unreachable, setUnreachable] = useState(false)
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<{ candidate: ScoredCandidate; options: PortionOption[] } | null>(null)
```

the health effect (lines 34-44) with

```tsx
  useEffect(() => {
    let alive = true
    void (async () => {
      const r = await fetchHealth()
      if (!alive) return
      if (r.kind === 'ok') { setHealth(r.value); setHealthError(null) }
      else { setHealth(null); setHealthError(UNREACHABLE_COPY) }
    })()
    return () => { alive = false }
  }, [])
```

the search effect (lines 46-72) with

```tsx
  useEffect(() => {
    if (query.trim().length < 2) { setResults([]); setDetails({}); setOutcome(''); setUnreachable(false); return }
    let alive = true
    setBusy(true)
    const timer = setTimeout(() => {
      void (async () => {
        const r = await searchFoods(query.trim(), 150)
        if (!alive) return
        // The spinner is cleared on EVERY branch, including the failures. A
        // spinner that outlives its request is the defect class this screen
        // has already been fixed for once.
        setBusy(false)
        if (r.kind !== 'ok') {
          setResults([]); setDetails({}); setUnreachable(true)
          setOutcome(r.kind === 'not_found' ? 'no match' : UNREACHABLE_COPY)
          return
        }
        setUnreachable(false)
        setDetails(r.value.details)
        const o = r.value.outcome
        if (o.kind === 'auto_accept') {
          setResults([o.match])
          setOutcome(`auto-accepted (score ${o.match.score.toFixed(2)})`)
        } else if (o.kind === 'disambiguate') {
          setResults(o.candidates)
          setOutcome(`${o.candidates.length} candidates — tap the right one`)
        } else {
          setResults([])
          setOutcome('no match — nothing in the corpus matched')
        }
      })()
    }, 180)
    return () => { alive = false; clearTimeout(timer) }
  }, [query])
```

and the corpus line (lines 74-81) with

```tsx
  const corpusLine = useMemo(() => {
    if (healthError != null) return healthError
    if (health == null) return 'Checking the food server…'
    const tiers = health.tiers.length > 0 ? health.tiers.join(' + ') : 'no tiers recorded'
    return `${health.foods.toLocaleString()} foods · ${health.barcodes.toLocaleString()} barcodes · ${tiers} · on your PC`
  }, [health, healthError])
```

- [ ] Replace `openPortionSheet` (lines 88-95) and `confirmPortion` (lines 96-110) in the same file with

```tsx
  function openPortionSheet(candidate: ScoredCandidate) {
    const detail = details[candidate.foodId]
    setPending({ candidate, options: detail == null ? [] : toPortionOptions(detail.portions) })
  }

  function confirmPortion(grams: number) {
    const candidate = pending?.candidate
    setPending(null)
    if (!candidate) return
    const detail = details[candidate.foodId]
    const ok = detail == null ? false : startSearchLog(corpusRowFromResolved(detail.food), grams)
    if (ok) router.replace('/result')
    else Alert.alert('Could not log this food', 'Its data could not be read from the food server. Nothing was logged.')
  }
```

- [ ] In the same file, change the empty-results block guard (line ~166) so an unreachable server does not read as "nothing matched": replace the condition `query.trim().length >= 2 && !busy && results.length === 0` with `query.trim().length >= 2 && !busy && results.length === 0 && !unreachable`, and add immediately after that block:

```tsx
      {unreachable && !busy && (
        <View style={{ marginTop: space.lg }}>
          <Text style={[type.caption, { color: theme.safety, lineHeight: 19 }]}>
            {UNREACHABLE_COPY} Nothing was searched. You can still enter this food by hand.
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push({ pathname: '/manual-entry', params: { name: query.trim() } } as never)}
            style={[styles.manualButton, { borderColor: theme.border }]}
          >
            <Text style={[type.bodyStrong, { color: theme.text }]}>Enter it by hand</Text>
          </Pressable>
        </View>
      )}
```

- [ ] Create `apps/mobile/app/food-server-settings.tsx`:

```tsx
import { router } from 'expo-router'
import { useCallback, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Icon } from '../src/components/Icon'
import {
  DEFAULT_FOOD_SERVER_URL,
  UNREACHABLE_COPY,
  fetchHealth,
  foodServerUrl,
  setFoodServerUrl,
} from '../src/data/food-server'
import { useTheme } from '../src/theme/ThemeProvider'
import { MIN_TAP_TARGET, radius, space, type } from '../src/theme/tokens'

/**
 * Where the food database lives.
 *
 * The default is the tailnet address of the PC that built the corpus. Editing it
 * is the whole screen; "Test" is the honest part — it answers with the corpus
 * line or with the unreachable sentence, so a typo is visible here rather than
 * three screens later in the middle of logging lunch.
 */
export default function FoodServerSettings() {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const [url, setUrl] = useState(DEFAULT_FOOD_SERVER_URL)
  const [status, setStatus] = useState<string>('')
  const [busy, setBusy] = useState(false)

  useFocusEffect(
    useCallback(() => {
      void (async () => { setUrl(await foodServerUrl()) })()
    }, []),
  )

  function test() {
    setBusy(true)
    setStatus('Checking…')
    void (async () => {
      await setFoodServerUrl(url)
      const r = await fetchHealth()
      setBusy(false)
      if (r.kind !== 'ok') { setStatus(UNREACHABLE_COPY); return }
      setStatus(
        `${r.value.foods.toLocaleString()} foods · ${r.value.barcodes.toLocaleString()} barcodes` +
          (r.value.schemaMismatch ? ' · the server and app versions may differ' : ''),
      )
    })()
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <View style={[styles.head, { paddingTop: insets.top + space.sm }]}>
        <Text style={[type.title, { color: theme.text }]}>Food database</Text>
        <Pressable accessibilityRole="button" onPress={() => router.back()} hitSlop={space.md}>
          <Icon name="close" size={22} color={theme.textMuted} />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: 120 }}>
        <Text style={[type.caption, { color: theme.textMuted, lineHeight: 19 }]}>
          The food database runs on your own PC and is reachable over Tailscale. Nothing here
          is sent to anyone else.
        </Text>

        <TextInput
          accessibilityLabel="Food server address"
          value={url}
          onChangeText={setUrl}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          placeholder={DEFAULT_FOOD_SERVER_URL}
          placeholderTextColor={theme.textFaint}
          style={[styles.input, { color: theme.text, borderColor: theme.border, backgroundColor: theme.bgSunken }]}
        />

        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          onPress={test}
          style={[styles.button, { borderColor: theme.border }, busy && { opacity: 0.5 }]}
        >
          <Text style={[type.bodyStrong, { color: theme.text }]}>{busy ? 'Checking…' : 'Save and test'}</Text>
        </Pressable>

        {status !== '' && (
          <Text style={[type.caption, { color: status === UNREACHABLE_COPY ? theme.safety : theme.textMuted, marginTop: space.md }]}>
            {status}
          </Text>
        )}
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
  },
  input: {
    marginTop: space.lg,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    fontSize: 16,
    minHeight: 48,
  },
  button: {
    marginTop: space.md,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    borderRadius: radius.pill,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: MIN_TAP_TARGET,
    alignSelf: 'flex-start',
  },
})
```

- [ ] Register the screen: add `<Stack.Screen name="food-server-settings" options={{ presentation: 'modal' }} />` next to the existing `provider-settings` line in `apps/mobile/app/_layout.tsx:70`.
- [ ] Add the profile entry point: in `apps/mobile/app/(tabs)/profile.tsx`, immediately after the `<Section title="AI provider">` block that ends on line 225, add

```tsx
      <Section title="Food database">
        <Row label="Server address" value="" onPress={() => router.push('/food-server-settings' as never)} />
      </Section>
```

- [ ] Run `npm test` and confirm green (the screen files carry no tests of their own; `rows.food-server.test.ts` and `food-server.test.ts` cover the logic they call). Then run `npm --prefix apps/mobile run typecheck` and fix any type error it reports in the two edited screens.
- [ ] Commit: `git add -A && git commit -m "point the food search screen and settings at the PC food server"`

---

## Task 8 — Barcode and photo paths, and the end of the bundled corpus

**Files:**
- Modify: `apps/mobile/src/scan/orchestrator.ts` (imports on lines 22-23; photo pipeline at 193-206; barcode at 452-492; `startSearchLog` at 865-881)
- Modify: `apps/mobile/src/db/expo-adapter.ts` (delete `openNutritionDb` at 82-118 and `nutritionCorpusInfo` at 120-140)
- Modify: `apps/mobile/src/db/expo-adapter.test.ts` (delete the two `openNutritionDb` describes at lines 60-85)
- Modify: `apps/mobile/src/scan/orchestrator.keyless.test.ts:36-42` (mock the food-server client instead of the corpus adapter)
- Modify: `apps/mobile/src/scan/orchestrator.failure.test.ts:28`
- Delete: `apps/mobile/assets/nutrition.db`
- Modify: `apps/mobile/metro.config.js:14` area (drop the `.db` asset extension comment and entry)
- Create: `apps/mobile/src/scan/orchestrator.unreachable.test.ts`

**Interfaces:**
- Consumes: `lookupBarcode`, `runRemotePipeline`, `UNREACHABLE_COPY` (Task 6); `corpusRowFromResolved` (Task 7); `readyFromRows(rows, meta, engineId, webLookups)` (existing, `apps/mobile/src/scan/orchestrator.ts`).
- Produces: `startSearchLog(food: CorpusFoodRow | null, grams: number): boolean` — signature change, now synchronous, consumed by `food-search.tsx` (Task 7 already calls it this way).

**Steps:**

- [ ] Write the failing test at `apps/mobile/src/scan/orchestrator.unreachable.test.ts`:

```ts
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
```

- [ ] Run `npm test -- apps/mobile/src/scan/orchestrator.unreachable.test.ts` and see it fail — the orchestrator still imports `openNutritionDb`, so the module-level mock of `../data/food-server` leaves `openNutritionDb` unmocked and the barcode test throws or falls to the old copy.
- [ ] In `apps/mobile/src/scan/orchestrator.ts`, replace the imports on lines 22-23 (`import { openNutritionDb } from '../db/expo-adapter'` and `import { loadFoodDb } from '../db/portions'`) with `import { UNREACHABLE_COPY, lookupBarcode, runRemotePipeline } from '../data/food-server'`, and add `corpusRowFromResolved` to the existing `./rows` import list on lines 28-36.
- [ ] Replace the photo pipeline block at lines 193-209 with:

```ts
  let result: ScanResult | null = null
  let pipelineUnreachable = false
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
    result = null
  }

  if (!result) {
    setPhase({
      kind: 'failed',
      photoUri,
      message: pipelineUnreachable
        ? `${UNREACHABLE_COPY} The photo was analyzed, but the food database could not be reached to price it. Nothing was logged.`
        : 'The model answered in a shape we could not use. This one is on us — try once more.',
      canRetry: !pipelineUnreachable,
    })
    return
  }
```

(keep the rest of the existing `if (!result)` body's neighbours intact; the `catch` wrapper around the old block is no longer needed because `runRemotePipeline` never throws).

- [ ] Replace the barcode body at lines 452-492 (from `async function startBarcodeScanUnguarded` through the local-hit `readyFromRows` call and its `return`) with:

```ts
async function startBarcodeScanUnguarded(gtin: string): Promise<void> {
  setPhase({ kind: 'analyzing', photoUri: '', stage: 'matching' })

  const found = await lookupBarcode(gtin)

  if (found.kind === 'server_unreachable') {
    setPhase({
      kind: 'failed',
      photoUri: '',
      message: `${UNREACHABLE_COPY} Nothing was looked up. Search by name once it is back, or enter this food by hand.`,
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
```

and change the no-key miss copy at lines 497-503 to:

```ts
      message:
        'This barcode is not in your food database. Search for the food by name, or enter it by hand. (Label reading needs an API key.)',
```

and the after-web-lookup miss copy at lines 519-524 to:

```ts
      message:
        'Could not find this barcode in your food database or online. Search for the food by name, or enter it by hand.',
```

- [ ] Replace `startSearchLog` (lines 865-881) with:

```ts
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
```

- [ ] Run `npm test -- apps/mobile/src/scan/orchestrator.unreachable.test.ts` and see all four cases pass.
- [ ] Update `apps/mobile/src/scan/orchestrator.keyless.test.ts`: replace the `vi.mock('../db/expo-adapter', ...)` block (lines 36-42) with

```ts
vi.mock('../data/food-server', () => ({
  lookupBarcode: async () => ({ kind: 'not_found' }),
  runRemotePipeline: async () => ({ kind: 'server_unreachable', reason: 'network', detail: 'no server in this test' }),
  UNREACHABLE_COPY: 'Food database unreachable — is the PC on?',
}))
```

and change the three `startSearchLog` call sites (lines 63, 82, 93) to pass rows: `startSearchLog(CHICKEN_ROW, 150)` where `const CHICKEN_ROW = { id: '171077', name: CHICKEN.name, energy_kcal: 165, protein_g: 31, fat_g: 3.6, carb_g: 0, fiber_g: null, sugar_g: null, sodium_mg: 74 }`, and the miss case (line 93) to `expect(startSearchLog(null, 150)).toBe(false)`. Drop the `await` on all three — the function is synchronous now. **Leave the `vi.mock('../inference/pathA/client', ...)` throwing-provider block on lines 50-54 exactly as it is.**
- [ ] Update `apps/mobile/src/scan/orchestrator.failure.test.ts:28`: replace the `openNutritionDb` mock entry with a `vi.mock('../data/food-server', ...)` block matching the keyless one.
- [ ] Run `npm test -- apps/mobile/src/scan` and see the keyless, failure and unreachable suites all pass.
- [ ] Delete the now-dead corpus surface: remove `openNutritionDb` (lines 82-118) and `nutritionCorpusInfo` (lines 120-140) from `apps/mobile/src/db/expo-adapter.ts`, remove the `nutritionImported` flag, and delete the two `openNutritionDb` describes from `apps/mobile/src/db/expo-adapter.test.ts` (lines 60-85).
- [ ] Run `git rm apps/mobile/assets/nutrition.db` (it is gitignored, so if git reports it is untracked, `rm apps/mobile/assets/nutrition.db` instead), and remove the `.db` asset-extension entry and its explanatory comment from `apps/mobile/metro.config.js` around line 14.
- [ ] Run `npm test`, `npm run check:node-purity`, and `npm --prefix apps/mobile run typecheck`. All three must pass; fix any remaining reference to `openNutritionDb` that they surface.
- [ ] Commit: `git add -A && git commit -m "route the barcode and photo paths through the food server and drop the bundled corpus"`

---

## Task 9 — README and THIRD-PARTY-DATA.md

**Files:**
- Modify: `README.md` (the "everything local" claim on line 6, the barcode bullet on line 19, the web-lookup bullet on line 29, the barcode paragraph on line 101, the corpus paragraph on line 168, the storage bullet on line 173)
- Modify: `THIRD-PARTY-DATA.md` (the whole "bundled corpus" framing, lines 1-45)
- Modify: `tools/nutrition-data/README.md` (cross-link the deploy section)

**Interfaces:**
- Consumes: the tier names `off` / `fdc_branded` / `arab_curated`, the licences `ODbL-1.0` / `CC0-1.0` / `curated-cited`, the dedup rule string written to `build_manifest` in Task 4, the default URL `http://100.96.136.73:7100` and port 7100 from Tasks 5-6, `deploy/food-server.service` from Task 5.
- Produces: no code. Documentation that matches what the code now does.

**Steps:**

- [ ] Replace the honesty claim on `README.md:6` so it names the new boundary: change "recomputes everything locally" to "recomputes everything on hardware you own — the phone talks only to your PC and, if you supplied a key, to your chosen AI provider".
- [ ] Rewrite the barcode bullet on `README.md:19` to: "**Four camera modes** — food photo, **barcode** (looked up against the millions of GTINs in your own food database, costing nothing and needing no key), nutrition label, receipt."
- [ ] Replace the corpus paragraph at `README.md:168` with a paragraph stating: the phone bundles no nutrition corpus at all; the database lives on your PC and is reached over Tailscale on port 7100; searching, barcode lookup and the deterministic pipeline all call it; when it is unreachable the app says "Food database unreachable — is the PC on?" and offers manual entry and, with a key, an AI estimate.
- [ ] Add a `## Running the food server` section to `README.md` after the storage section (around line 175) covering, in order: `npm run data:build:full` with the OFF download command (`curl -C - -o ~/nut-ai-data/openfoodfacts-products.jsonl.gz https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz`, ~9 GB, resumable); `tailscale ip -4` to get the bind address; the `sed`-and-install recipe from `deploy/food-server.service`; `systemctl --user enable --now food-server`; and setting the address in the app under Profile → Food database → Server address (default `http://100.96.136.73:7100`).
- [ ] Rewrite `THIRD-PARTY-DATA.md` lines 1-45: retitle the document "Third-party data used by this app" and state that **no** third-party data is compiled into the binary any more. Then give one table row per tier:
  - `off` — Open Food Facts, ODbL-1.0. Attribution: "Contains information from Open Food Facts, which is made available under the Open Database License (ODbL) v1.0." Share-alike note: the built `nutrition-full.db` is a derivative database; redistributing it means redistributing it under ODbL with the same attribution. It is not redistributed by this repo — it is built locally and stays on the user's PC.
  - `fdc_branded` — USDA FoodData Central branded release, public domain (CC0-1.0), attributed as the existing document already attributes FDC.
  - `arab_curated` — `tools/nutrition-data/arab-foods.csv`, licence `curated-cited`. Sourcing policy verbatim: every row carries a `source` column naming the published food-composition table it was transcribed from; a row without a citable source does not ship, and `parseArabCsv` throws rather than skipping it.
- [ ] Replace the "What the generic tier does NOT contain: barcodes" section (lines 30-45) with a short section titled "Barcodes" stating that the `off` and `fdc_branded` tiers carry GTINs, that `apps/mobile/src/scan/orchestrator.ts` now queries `/barcode/<gtin>` on the food server, and that a miss is a miss rather than a silent guess.
- [ ] Add a "Deployment" cross-link line to `tools/nutrition-data/README.md` pointing at the README's "Running the food server" section and at `deploy/food-server.service`.
- [ ] Verify no stale claim survives: run `grep -rn "bundled corpus\|nutrition.db\|7,928\|4.7 MB" README.md THIRD-PARTY-DATA.md tools/nutrition-data/README.md` and fix every hit that still describes a corpus on the phone.
- [ ] Run `npm run check` (lint, typecheck, test, node-purity, data:verify) and confirm it passes. `data:verify` needs `tools/nutrition-data/out/nutrition.db`; if it is absent on this machine, run `npm run data:build` first or note the skip explicitly rather than claiming a pass.
- [ ] Commit: `git add -A && git commit -m "document the PC-hosted food database and its three data licences"`

---

## Live gate before merge (from the spec, not a task)

With the server running on `cachyos` and the phone on the tailnet: search `ful`, search `فول`, scan a real barcode, then `systemctl --user stop food-server` and confirm every one of those three screens shows "Food database unreachable — is the PC on?" with manual entry offered and no spinner left running.

---

_Self-review done against the spec: checked every spec bullet has a task (endpoints, tiers, dedup, Arabic folding, client outcomes, settings URL, corpus line, barcode path, README/THIRD-PARTY-DATA, systemd unit, YAGNI exclusions), checked no step says TBD/TODO/"similar to Task N", and checked type names line up across tasks. Fixed inline while reviewing: (a) `startSearchLog` was still async in Task 7's call site after Task 8 made it synchronous — Task 7 now calls it synchronously and Task 8's step says so explicitly; (b) `CorpusFoodRow.id` was typed `number` but the server returns the string id from `coerceIds`, so Task 8 widens it to `string | number`; (c) `handlers.ts` used `PersonalPriors` without declaring `@nutai/gram-engine` as a dependency, so a step adding it to the package manifest and tsconfig references was inserted; (d) `vitest.config.ts` needed both new include globs (`tools/**/*.test.mjs` and `apps/food-server/src/**/*.test.ts`), which is now a single edit in Task 3 rather than two half-edits; (e) the `.mjs` build scripts import `@nutai/clamp` and `@nutai/resolver` from `dist`, so Task 1 adds the tsconfig project references and the `build:packages` script that make that resolvable, and `data:build:full` runs it first._
