# Verification report

**This file is evidence, not a contract.** It records what happened when
commands were run against this fork. It does not say what the app should do —
the README is the contract, and where this file and the README disagree, the
README wins. It also does not carry shipped / partial / never-built status;
that belongs to the ratified spec (#18). Ruled on #13.

Each section below states its own freshness. The document as a whole has no
single as-of date, and an undated claim here has not been re-run.

## Gates

**Re-measured 2026-08-11** on `0863bd6`, Linux, Node v24.13.0 / npm 11.6.2 /
tsc 5.9.3 — this stamp covers this section only. The original column was
measured against upstream before this fork downgraded to Expo SDK 54 and stubbed
HealthKit (`9111415`). Two gates hold, two moved, and two fail. Nothing was
repaired to make them pass — this is a measurement.

**One reproduce command still doesn't run to completion.** `npm run data:build`
exits 1 because it needs a USDA FDC dataset that is not in the repository. Run
the gates individually.

**Lint, added since this snapshot (issue #10).** `eslint.config.mjs` is now
tracked at the repo root. It enforces a typescript-eslint recommended baseline
across the workspace, plus a hex-colour ban in `apps/mobile/**` (outside
`src/theme/tokens.ts`) so a hardcoded colour can't silently skip dark mode or
contrast checking. `npx eslint . --max-warnings=0` passes clean as of
2026-08-16 — the Lint row below records both dates.

| Gate | Command | Originally | Measured 2026-08-11 |
|---|---|---|---|
| Unit + property + integration tests | `npx vitest run` | **252 passed**, 13 files | ✅ **341 passed**, 24 files |
| Typecheck — packages | `tsc -p tsconfig.json` | clean, strict | ❌ **27 errors** |
| Typecheck — app | `tsc --noEmit` in `apps/mobile` | clean, strict | ❌ **1 error** |
| Node-purity gate | `node scripts/check-node-purity.mjs` | **11/11 packages** React-Native-free | ✅ **11/11**, unchanged |
| Corpus golden queries | `npm run data:verify` | **26/26 passed**, corpus accepted | ✅ **26/26**, unchanged |
| iOS bundle | `expo export --platform ios` | **1,597 modules**, 3.7 MB | ⚠️ **1,685 modules**, 4.94 MB |
| Lint | `npm run lint` | *(not listed)* | ❌ no ESLint config (2026-08-11) → ✅ `eslint.config.mjs` added, clean (2026-08-16) |
| Corpus build | `npm run data:build` | *(not listed)* | ❌ dataset not in repo |

**Tests moved up, not down.** 341 in 24 files, including `eval/src/scorers.test.ts`
(14 tests) — the scorers are implemented and covered. The harness that would run
them against a golden set is still absent (#2, #8).

**The packages typecheck was never clean.** All 27 errors reproduce identically on
a pristine `upstream/main` worktree, so this is not fork drift: 25 are `TS4111`
in `packages/prompt/src/wire-transforms.ts` and its test — index-signature
properties reached with dot access, which is precisely what
`noPropertyAccessFromIndexSignature` forbids — and 2 are `TS2345` in
`packages/totals/src/totals.test.ts:141`, a `MacroTotals` literal missing the
required `sugar_g`. The "clean, strict" claim and the code that violates it
arrived in the same commit, `08a342b`.

**The app typecheck failure is fork-introduced.**
`apps/mobile/src/health/healthkit.ts:51` imports
`@kingstinct/react-native-healthkit`, which upstream declared as `^14.0.2` and
which `9111415` removed when it stubbed HealthKit for Expo Go. The specifier is
still imported; the dependency and its types are gone.

**The bundle grew.** SDK 57 → 54 changed the module graph: 1,685 modules against
the claimed 1,597. The 4.94 MB is the `.hbc` bundle; the 4.91 MB `nutrition.db`
ships beside it as an asset, not inside it.

Strict mode means `strict` plus `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `noImplicitOverride`,
`noPropertyAccessFromIndexSignature` and `verbatimModuleSyntax`. Two of the bugs
below were caught by those flags alone — and, as measured above, two files have
never satisfied them.

---

## What the tests actually prove

*Claims in this section were re-audited against the code on 2026-08-11 (#13).
The measurements held; four claims overstated what they measured and have been
narrowed to what was actually run.*

### The two defining bugs are unreachable — one structurally, one by clamp

**A 27-million-calorie output cannot reach a user.** `@nutai/clamp` recomputes
calories from macros via Atwater whenever the model's own figure disagrees by
more than 15%, and the test asserts the string `27000000` appears nowhere in the
output. This is a runtime guarantee, not a structural one: nothing at the type or
Zod level bounds `calories_kcal`, so the protection is one pure function that
every caller goes through, plus the tests that pin it. `clamp(validated)` is
unconditional in `runPipeline` before any path branch, and the app's only scan
entry is `runPipeline`, so it is not skippable — though only the cloud path
exists today, so "both inference paths" is structural, not exercised.
It ships *before* any LLM verifier, not instead of one: a second model call to
check the first model's arithmetic costs money, adds latency, and can itself be
wrong. Arithmetic cannot.

**A macro edit cannot leave calories stale.** The reported failure — protein
edited 226 g → 175 g with calories frozen at 2,964 kcal — is unreachable because
no field exists for a stale total to live in. This one *is* structural:
`LoggedMeal` has no totals field and `IngredientRow` carries only `grams` plus a
per-100g snapshot, so totals derive on every read. A **500-run property test**
over arbitrary add / remove / edit-grams / set-fraction sequences asserts the
total matches an independently computed expectation, and a second **300-run**
test asserts it equals the sum of its own per-row contributions. A
single-example test would not have
caught the original bug either, because it only appears after a specific
*sequence*.

### The pipeline works against real data, not fixtures

`packages/pipeline/src/pipeline.corpus.test.ts` runs the real pipeline against
the real 7,928-food corpus:

- A three-item plate resolves every item to a genuine USDA row — **zero** fall to
  the AI-estimate path
- **Twenty common foods resolve with zero zero-hits**, well under the 5% rate
  said to trigger adding an embedding layer. That threshold was cited to
  `SPEC-accuracy-engine.md §5.5`, a file that never existed; the surviving
  archive coordinate `docs/inherited-design.md` **I §5.5** is "Candidate
  scoring" and contains no zero-hit rate and no embedding trigger. The 5% figure
  has no source in this repository.
- Displayed calories are reproducible from displayed macros across ten real foods
- Six hand-picked high-fat foods (banana, butter, olive oil, cheddar, almonds,
  lard) stay within a physically possible energy density. This is a spot check,
  not a corpus-wide sweep
- A full scan completes in **under 500 ms**

### Honesty is measurable, not aspirational

The merge gate blocks a prediction that is only **4% off** — an excellent MAPE —
because its band claimed ±1% and missed the truth. That is the ship-blocker the
whole product rests on: being wrong is survivable, claiming confidence you have
not earned is not.

`baselines.json` self-declares `provenance: "seeded"`. **Five of its eight strata
carry a citation** for where their number came from — `C_simple_cooked` (0.25),
`G_cuisine_diverse` (0.40) and `H_test_retest` (0.20) do not, and this file
previously claimed every stratum did. `"measured"` exists as a type and a
database column, but no code writes it: the intent is that it flips only after a
real golden-set run, and nothing enforces that, because the runner and the golden
set do not exist (#2, #8).

---

## Nine real bugs found and fixed

Listed because each one was a genuine defect, not a test adjustment. This is a
historical record of fixes as they were made, and is not edited to match later
code — the two items marked *superseded* were true when written and no longer
describe this fork.

1. **The clamp rejected real food.** `MAX_KCAL_PER_100G` was 900 on the reasoning
   that "pure fat is ~884". Real USDA data says otherwise: `Fat, beef tallow`,
   `Lard` and every fish oil in SR Legacy are **902 kcal/100 g**, because USDA
   applies a food-specific Atwater factor of 9.02 kcal/g rather than the rounded
   9. Anyone logging a spoon of lard would have been told their food was
   physically impossible. Raised to 920. *Found by the golden-query gate running
   against the actual corpus — which is the entire argument for having it.*

2. **One bad number killed a whole scan.** `model_gram_estimate` carried
   `.max(5000)` in Zod, so a single absurd value on one item of a five-item meal
   rejected the **entire payload** and the user got nothing back from a scan they
   paid for. Range checks belong to the clamp, which nulls the value and lets the
   ladder fall through. Structural violations still fail the payload; value-range
   violations no longer do.

3. **A type lie.** `ResolvedFood.foodId` was declared `string` while SQLite
   returns `INTEGER`. TypeScript was satisfied; every `===` downstream silently
   failed.

4. **Non-independence in the spec's own algorithm.** A trusted personal prior is
   computed *as* `model_estimate × ratio`, so blending it back against
   `model_guess` diluted the user's own correction with the very number they were
   correcting — and did so *harder* the more consistent they had been. A user who
   corrects 150 g → 200 g five times now sees 200, not 189.

5. **Double-counted uncertainty.** The band composed the pathway floor and the
   measured spread in quadrature when they describe the same quantity, inflating
   `packaged_exact`'s honest ±2% to ±2.8%.

6. **`better-sqlite3` throws synchronously** on a constraint violation, so
   `return Promise.resolve(stmt.run(...))` threw before a promise existed and a
   caller using `.catch()` on an async-looking interface would never see it.

7. **Metro vs. Node module resolution.** `packages/*` use explicit `./foo.js`
   specifiers because Node requires that when consuming built `dist/` — and the
   eval harness does exactly that. `tsc` and Vitest map `.js` → `.ts`; Metro takes
   it literally and fails. Fixed in `metro.config.js` rather than by dropping the
   extensions (breaks the Node build) or pointing the app at `dist/` (would mean
   the app runs different bytes from the harness).

8. **`newArchEnabled` no longer exists** in `ExpoConfig` — the New Architecture is
   the default in SDK 57 and the option was removed. *Superseded: this fork runs
   SDK 54, where `newArchEnabled` is still a valid `ExpoConfig` key. The same
   staleness survives in `app.config.ts:27-29`, which still argues the option was
   removed.*

9. **The spec's assumed `reanimated ~4.1` cannot install** against SDK 57: it
   peer-deps to RN 0.78–0.82 and the SDK ships RN 0.86. *Superseded: the SDK 57
   premise no longer holds on this fork.*

## Two research gaps closed

*Re-audited 2026-08-11 (#13). Both claims hold in the code; their citations to a
spec file that never existed have been repointed at the archive.*

**FDC column names, previously UNCONFIRMED.** Two prior research passes could not
read USDA's field-description PDF (403 both times), so the shape of
`food_portion` was a guess. Verified against the real file: `id, fdc_id, seq_num,
amount, measure_unit_id, portion_description, modifier, gram_weight`. The build
validates every header and fails loudly on a mismatch.

**A self-contradiction at `docs/inherited-design.md` I §6.3** (inherited from the
never-existent `SPEC-accuracy-engine.md`; the archive preserves it unrepaired at
`:469-479`). The stated rounding
rule ("one decimal for grams under 10 g") contradicts its own worked example,
which rounds 6.19 g fat to `6` and reports 466 kcal. We follow the stated rule
(6.2 g → 468 kcal): it preserves information that matters at a ~60 g daily fat
target, and the property that counts — displayed calories derived from displayed
macros — holds either way. Documented at the test.

---

## Where status lives

This file used to carry a "What is NOT built" section. It was a shipped /
partial / never-built status list, undated since `08a342b`, and most of its
entries were false by the time #13 measured them — it named screens as
unbuilt that ship today, and named three placeholder screens that do not exist
at all.

Status is not evidence, and it is not reproducible by running anything, so it
does not belong in this file. It lives in the ratified spec (#18), which was
seeded with the deleted text and its corrections.
