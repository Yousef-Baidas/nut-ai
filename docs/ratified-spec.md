# Nut AI — the ratified spec

This is the fork's own document: for every place the README, the code comments, the
inherited design and the implementation have disagreed, the decided truth — carrying a
**shipped / partial / never-built** status for everything inherited. Assembled from the
divergence tickets of the reconciliation map
([#1](https://github.com/Yousef-Baidas/nut-ai/issues/1)), each of which supplied the
verdict for its own divergence. Ratified 2026-08-16.

## Where this document sits

| Layer | Document | Role |
|---|---|---|
| Contract | `README.md` | the fork's outward promise — wins any disagreement |
| Reconciliation | **this document** | decided truth + shipped / partial / never-built status |
| Evidence | `VERIFICATION.md` | what happened when commands were run — records, never promises |
| Archive | `docs/inherited-design.md` | frozen intent of the four inherited spec documents (Parts I–IV); never updated, never authoritative |

This document is authoritative over the code, the comments and the archive: where they
disagree with a verdict here, they are wrong. It does **not** supersede the README — where
this document and the README disagree, that is a defect in one of them, escalated
explicitly, never a silent win for either. (Ruled on #13, amending #18's original
"governs" wording.)

Code comments cite the archive for *intent* (`docs/inherited-design.md I §5.5` and the
like); whether that intent shipped is answered by this document's status entries. The two
are deliberately separated — an archive with a status column drifts by design.

### Two rulings the map left as fog, settled here

- **Where status lives:** per-divergence, grouped by product subsystem. That is the unit
  every closed ticket actually produced a verdict in; per-Part or per-section status would
  have forced verdicts to a granularity nobody argued at.
- **Milestone vocabulary:** the fork does not keep the inherited M0–M8 milestones or the
  "20+ engineer-weeks" accounting. That vocabulary is frozen inside Part II of the archive.
  This document and everything downstream of it speak in shipped / partial / never-built
  and ticket numbers.

## The rule the product is built around

> **The inference model never owns a number the user sees.**

The model is a perception device. Grams come from the deterministic reconciliation ladder,
nutrition from a real database row snapshotted at log time, totals are arithmetic, and
confidence comes from measured per-category error — with the caveat, stated everywhere it
matters, that today's error bands are **seeded** (synthetic, provenance-labelled), not yet
measured against a kitchen-scale golden set. Nothing derived from seeded data may be
presented as measured accuracy.

## One decision the inheritance never made: the PC-hosted corpus

The inherited design assumed a nutrition corpus bundled into the app binary. The fork
displaced it (PR #31): the corpus is built on the user's PC (`npm run data:build:full`,
three tiers — Open Food Facts, USDA FDC Branded, Arab curated — ~1.2M foods with real
GTINs) and served to the phone over Tailscale on port 7100 by `apps/food-server`, bound to
the Tailscale IPv4 only. The phone bundles no corpus. Search, barcode lookup and the
deterministic pipeline all call the server; when it is unreachable the app says so and
offers manual entry and, with a key, an AI estimate. The small USDA generic fixture built
by `npm run data:build` exists only for tests (`npm test`, `npm run data:verify`) and is
never shipped or read by the app.

This decision retroactively resolves two inherited limitations: the barcode column is no
longer empty (the generic tier carried zero barcodes; the full corpus carries millions),
and corpus size stopped being a bundle-size problem.

## Status of everything inherited

Statuses: **shipped** (built, tested, live) · **partial** (a real subset shipped; the gap
is named) · **never-built** (does not exist; any comment or doc implying otherwise is
wrong). "Settled" names the ticket or PR that produced the verdict.

### Inference

| Inherited claim | Status | Decided truth | Settled |
|---|---|---|---|
| Two inference paths, chosen at onboarding (Path A cloud / Path B on-device) | **partial** | Only cloud BYOK exists (Anthropic, OpenAI, Google). On-device is a roadmap item, out of the map's scope; if it ever ships, its accuracy is measured against the kitchen-scale golden set and published first. Code says `InferencePath = 'cloud' \| 'local'`, where `'local'` is the deterministic no-model pipeline — Path B's living successor, not on-device inference. `pathA/` was renamed `inference/cloud/`. | #12, `d34aff9` |
| Component-level identification, deterministic gram ladder, snapshot-at-log immutability | **shipped** | As designed. The 35% disagreement threshold escalates to a question, never a blend. | #2 sweep found no divergence |

### Accuracy harness (the reason `packages/*` stays React-Native-free)

| Inherited claim | Status | Decided truth | Settled |
|---|---|---|---|
| Eval scorers (metrics, strata, `evaluateGate`) | **shipped** | 244 lines, tested — shipped by upstream and always real. | #8 (corrected #2's "one-line re-export" claim) |
| Eval runner driving the real pipeline against a golden set | **shipped** | `npm run eval:run`: real `runPipeline`, real corpus fixture, unmodified scorers, non-zero exit on gate failure. | #9 |
| Kitchen-scale-weighed golden set | **never-built** | The shipped golden set is **seeded**: 11 synthetic cases, `provenance: 'seeded'`, truth computed from the fixture corpus's own per-100g values. Measured cases replace seeded ones case by case; on that flip, re-stratify to the letter-coded baseline strata so the MAPE-regression gate goes live (today only the 70% band-coverage floor gates). | #9 |
| Published accuracy numbers | **never-built** | Blocked on the measured golden set, by design. Every claim site says so. | #9, #13 |

### Resolver

| Inherited claim | Status | Decided truth | Settled |
|---|---|---|---|
| FTS5 match ladder + six-signal scoring | **shipped** | The six live weights sum to **0.95 by design** — that is the reachable ceiling, `minScore: 0.6` is calibrated against it, and the arithmetic is frozen until the eval harness can validate a recalibration. The old "sum to 1.0" comment was the defect. | #11 |
| `embeddingCosine` seventh signal | **never-built** | Weight 0, v1.x. Going live requires renormalizing weights and recalibrating `minScore` together, against the eval harness. | #11 |
| Trigram typo-tolerant shadow index | **shipped** | Wired 2026-08-16 as the last rung of `resolveByText`: after every word-level rung misses, per-token folded trigrams run against `food_fts_trigram`; `ladderStep = ladder.length` marks a trigram rescue. The index had been built and populated (including on the live 1.2M corpus) but never queried. | #11 |

### App surfaces

| Inherited claim | Status | Decided truth | Settled |
|---|---|---|---|
| Onboarding | **shipped** | 22 screen files, 19 steps in `FLOW`. (The inherited "not built: onboarding (12 screens)" and "Trends / Foods / You tabs" claims described a repo that never existed here — tabs are Home / Progress / Profile.) | #13 |
| Foods (text search → log) | **shipped** | Ruled part of the product and named **Foods** (#4); built by #25: tap a result → `readyFromRows(...)` → result screen → `logMeal`, the same seam every scan path uses. Grams come from `food_portions` household measures with free entry alongside and a 100 g fallback — **not** `serving_size_g ?? 100`, which was NULL-universal on the generic corpus. The `Groups` social-feed framing is deleted: the feed was cut by decision (moderation burden, eating-disorder risk), not left unbuilt. | #4, #25 |
| Saved meals | **shipped** | A real write path exists (`saved-meals.ts`); "Log again" logs. The inherited screen was read-only with no writer. | #22 |
| Barcode scanning | **shipped** | Local-first against the PC-hosted corpus; on a local hit, logged entirely offline with `origin: 'barcode'`. On a miss: keyed web lookup, or an honest screen offering search and manual entry. | #4, #6, PR #31 |
| Manual entry | **shipped** | Calories-only entry displays and deducts the same kcal (the displayed≠deducted split is closed; see the invariant below). | #28, #29 |
| Label OCR / receipt reading | **shipped (keyed)** | Provider vision calls. There is no on-device OCR; the label scanner fails fast and says so. The inherited claim that label reading was keyless was false and is corrected in both README and runtime copy. | #23, #24 |
| HealthKit | **partial** | Opt-in, **write-only** meal sync: an explicit toggle writes each logged meal's energy and macros to Apple Health (`src/health/meal-sync.ts`, tested). Reads (`readToday`, weight-trend second source) are **never-built**; the permission request is scoped to what the feature uses. Stubbed under Expo Go — the toggle no-ops there; a dev build gets the real module. | #5, PR #26 |
| Offline queue, widgets, Health Connect | **never-built** | Roadmap at most; no code asserts otherwise. | #13 seed |
| Store submission | **never-built** | You build it yourself; AGPL §7 grant exists for eventual store distribution. | README |

### Enforcement and conventions

| Inherited claim | Status | Decided truth | Settled |
|---|---|---|---|
| "An ESLint rule enforces the hex-colour token rule" | **shipped** | `eslint.config.mjs`: tseslint recommended + a `no-restricted-syntax` hex ban in `apps/mobile/**` with `src/theme/tokens.ts` the sole exception. 33 pre-existing violations were swept into named tokens. `npm run check` reaches all five gates. | #10 |
| "An ESLint rule checks tap targets ≥ 44pt / hitSlop" | **never-built** (as lint) | Deliberately: a syntactic rule would flag every divider. It is a **review convention**, and the comment now says so. | #10 |
| `npm run check` | **shipped** | Five gates: lint, typecheck, tests, node-purity, data:verify — and all five pass. Both inherited reproduce commands had never worked as written. | #7, #10 |

### Documents

| Inherited claim | Status | Decided truth | Settled |
|---|---|---|---|
| The four spec documents (`SPEC-accuracy-engine.md`, `PLAN.md`, `SPEC-ui.md`, `SPEC-product.md`) | **never existed** | In any commit of either repository. They lived in the previous author's planning context. Summarized into the frozen archive `docs/inherited-design.md` (Parts I–IV, inherited numbering kept — the Part numerals are load-bearing because the four namespaces collide on `§4.1`, `§4`, `§3.3`). All code citations repointed. | #8, #15, #16 |
| `THIRD-PARTY-DATA.md` | **shipped** | Exists at the repo root; per-tier licences (ODbL, CC0, curated-cited). | #6 |
| `VERIFICATION.md` | **shipped** (rescoped) | It is **evidence** — it records what happened when commands were run and never states what should be true. Its status section ("What is NOT built") was deleted; its corrected content is absorbed into this document. Failed claims were claims of *guarantee* laid over evidence that was a *sample* — the most misleading word in the file was "structurally". | #13 |

## Invariants this fork has ratified

These emerged from defect tickets rather than the inheritance, and they bind future work:

1. **Displayed kcal and deducted kcal share one basis.** Whatever kcal figure a row shows
   (Atwater 4/4/9 over user-edited macros when `macros_user_edited = 1`, the stored
   snapshot energy otherwise), day totals deduct the same figure —
   `DEDUCTED_KCAL_EXPR` in `packages/db-adapter/src/schema.ts` is the single shared
   definition, interpolated into both the app query and the round-trip test so they cannot
   drift. (#28, #29)
2. **Keyless paths never call an AI provider.** Text search, manual entry, saved-meal
   relog, barcode local hits and the entire correction flow complete without a credential
   in the process. Keyed features fail fast and say which key they need.
3. **`packages/*` stays importable under bare Node** — enforced by `check:node-purity`,
   justified by an eval harness that now actually consumes it.
4. **Snapshots are immutable.** A logged meal's nutrition never changes retroactively;
   corrections recompute from per-100 g snapshots, offline.
5. **Comments may not claim enforcement or usage that does not exist.** The inheritance's
   central failure mode was the present-tense intention — "an ESLint rule enforces",
   "every one is used by a feature", "the harness imports the real engine" — written
   indistinguishably from truth. The fork's rule: a comment states *intent* by citing the
   archive, and states *enforcement or usage* only when the mechanism exists at the time
   of writing. Whether the intent shipped is this document's job, and the second hop into
   this status table is acceptable — a source comment need not carry its own status.
   (Settles the map's "how comments state things" fog; the `I §8.4` test case is resolved
   because the runner now exists.)

## Known errata, held open deliberately

- **Archive erratum:** `docs/inherited-design.md I §5.5` does not contain the 5% zero-hit
  embedding trigger cited to it (it is "Candidate scoring") — the inherited numbering and
  its prose had come apart before the archive froze them. The archive is write-once, so
  this is recorded here, not repaired there. (#13)
- **Seeded-vs-baseline strata:** the seeded golden set's strata (`single`/`mixed`) do not
  join to `eval/baselines.json`'s letter-coded strata, so the MAPE-regression gate is
  inert until measured cases arrive re-stratified. (#9)
- **Resolver ranking quirk:** on generic-tier data, a bare key like `oats` can top-rank
  `Oil, oat`. Frozen with the scoring weights until the harness can validate changes. (#9,
  #11)
- Deferred minors from the PR #31 reviews are tracked as #32 (data-build robustness), #33
  (food-server hardening) and #34 (mobile UX) — not divergences, just backlog.

## Provenance

Seeded from the 20 divergences inventoried on #2 (D1–D7 charted on #1, D8–D20 swept), with
verdicts supplied by #3–#16 and the build tickets #21–#28 they graduated. The full decision
record lives in the map's comments and each ticket's resolution comment. This document
supersedes nothing in the README and everything in the comments.
