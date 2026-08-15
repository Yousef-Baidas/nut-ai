# PC-hosted food database

Date: 2026-08-16. Approved by Yousef in-session.

## Goal

Replace the 4.7 MB bundled nutrition corpus with a food database of effectively
unlimited size (millions of products: Open Food Facts, USDA branded, and a
curated Arab-foods tier) hosted on the user's PC (`cachyos`) and queried by the
phone over Tailscale. Food search gains Arab/supermarket/cereal coverage,
Arabic-script + transliteration search, and — for the first time — a barcode
corpus that real scans can hit.

**Chosen architecture (approach B, "smart server"):** the PC service imports
`@nutai/resolver` directly and returns *scored candidates*, so one HTTP round
trip per search and zero drift between server scoring and what the app expects.

Decisions locked in-session:
- Sources: Open Food Facts + USDA `fdc_branded` + curated Arab tier.
- Everything on the PC — the phone bundles **no** nutrition corpus.
- Connectivity: Tailscale only (server binds to the tailnet interface).
- Search understands Arabic script and common Latin transliterations.

## Components

### 1. `apps/food-server/` — the lookup service

A Node/Bun HTTP service in the monorepo workspace (imports `@nutai/resolver`,
`@nutai/db-adapter/node`, `@nutai/core-schema`).

Endpoints (JSON):

| Route | Returns |
|---|---|
| `GET /health` | `{ ok, foods, portions, barcodes, builtAt, tiers }` — the app's corpus line |
| `GET /search?q=<text>&grams=<n>` | The resolver's outcome verbatim: `auto_accept` with match, `candidates[]`, or `no_match`, in the same `ScoredCandidate` shape `resolveByText` returns today |
| `GET /barcode/<gtin>` | The matching food row + portions, or 404 |

Behavior:
- Opens `nutrition-full.db` read-only once at startup (memoized, process-lived).
- Binds **only** to the Tailscale interface address (config via env in the unit
  file; no listening on 0.0.0.0). No auth beyond tailnet membership.
- Query normalization (Arabic folding, below) applied server-side so all
  clients get it for free.

Deployment: systemd **user** unit `food-server.service` in
`~/.config/systemd/user/` (same pattern as lute/odysseus: absolute paths,
in-repo working directory). A `deploy/food-server.service` template + a README
section document install. Port: 7100.

### 2. `tools/nutrition-data` — build tiers

The existing build keeps producing the small USDA-generic DB, which moves to
`tools/nutrition-data/out/nutrition.db` — it remains the fixture for
`pipeline.corpus.test.ts` (path updated there) but is no longer an app asset.
The build gains a `data:build:full` target producing `nutrition-full.db` (PC-only, never
an app asset, git-ignored; lands in `~/nut-ai-data/` — NOT in the repo, so
`git clean` can't destroy it).

New tiers, each stamping `foods.tier` and `foods.license` per row:

- **`off`** — Open Food Facts full product dump, filtered to rows with complete
  core nutriments (kcal, protein, carbs, fat per 100 g present and
  arithmetically sane per the existing clamp rules). Keeps barcode (GTIN),
  product name (all languages present, indexed), brand, quantity/serving where
  parseable. License ODbL: attribution + share-alike recorded in
  THIRD-PARTY-DATA.md.
- **`fdc_branded`** — full USDA branded tier (~400k products, GTINs, public
  domain). Same field mapping as the existing FDC tiers.
- **`arab_curated`** — a checked-in CSV at `tools/nutrition-data/arab-foods.csv`:
  regional dishes and staples (ful medames, koshari, mansaf, kunafa, labneh,
  za'atar, …). Every row carries a `source` column naming the published
  food-composition table it came from (e.g. the Palestinian or Jordanian FCT).
  **No invented values** — a row without a citable source does not ship.
  Synonyms in Arabic script AND common transliterations per food.
  Initial size ~150–300 rows; grows by editing the CSV and rebuilding.

Dedup rule between tiers: same GTIN → OFF row wins over fdc_branded (more
locale-relevant), recorded in the build manifest. Generic USDA rows (no GTIN)
are unaffected.

**Arabic normalization** (shared function, used at index time and by the
server at query time): strip tashkeel/diacritics, fold أ/إ/آ→ا, ة→ه, ى→ي,
normalize Arabic-Indic digits. FTS5 `unicode61` handles the rest.

### 3. App changes (`apps/mobile`)

- Delete the bundled `assets/nutrition.db` + `importDatabaseFromAssetAsync`
  path; `openNutritionDb` and its callers are replaced by a
  **`FoodServerClient`** (`src/data/food-server.ts`): typed fetch wrappers for
  the three endpoints, short timeout (~4 s), no retries-forever.
- Server URL lives in settings (same mechanism as the provider key), default
  `http://100.96.136.73:7100`, editable in Profile.
- `food-search.tsx` calls `/search`; the corpus line becomes the `/health`
  summary ("2.1M foods · OFF + USDA · on cachyos") or the unreachable state.
- Barcode scan path queries `/barcode/<gtin>` before any keyed fallback.
- **Unreachable state is a first-class outcome, never a hang**: every call
  site distinguishes `no_match` from `server_unreachable`; the UI copy for the
  latter is "Food database unreachable — is the PC on?" with manual entry and
  (keyed) AI-estimate as the offered paths. All spinner-guard discipline from
  the fix-live-defects branch applies.

### 4. Honesty & docs

- Keyless redefinition: keyless paths never call **AI providers** (the
  throwing-provider-client guard in `orchestrator.keyless.test.ts` stays
  verbatim); they MAY call the user's own food server and must fail honestly
  when it is unreachable.
- README: "everything local" becomes "everything on your own hardware — the
  phone talks only to your PC and (if keyed) your chosen AI provider".
  Setup section for Tailscale + the systemd unit.
- THIRD-PARTY-DATA.md: OFF/ODbL attribution + share-alike note, fdc_branded
  row, arab_curated sourcing policy.

## Error handling

- Server: malformed query → 400 with message; DB missing at startup → refuse
  to start with a legible error (unit shows failed, not zombie).
- App: timeouts and connection failures map to `server_unreachable`; JSON
  shape mismatches (version skew between app and server) map to the same
  state with a "server and app versions may differ" hint. `/health` carries a
  `schemaVersion`; the client warns on mismatch but still tries.

## Testing

- `apps/food-server`: endpoint tests against a small fixture DB (existing
  node adapter) — search shape parity with `resolveByText` is asserted by
  literally calling both and comparing.
- `tools/nutrition-data`: tier-filter unit tests (nutriment completeness,
  dedup rule, Arabic normalization golden cases: فول≡ful≡foul).
- App: `FoodServerClient` tests with a mocked fetch (success, 404, timeout,
  malformed JSON → the four outcomes); keyless suite unchanged plus new
  unreachable-behavior tests.
- Live gate before merge: emulator pass with the real server running on this
  machine (search "ful", search فول, a barcode lookup, then stop the server
  and verify the honest unreachable state).

## Out of scope (YAGNI, explicit)

- No write path from phone to server, no user accounts, no HTTPS/auth layer
  (tailnet is the boundary), no OFF delta-sync/auto-update job (rebuild is a
  manual `npm run data:build:full`), no on-phone caching layer in v1.
