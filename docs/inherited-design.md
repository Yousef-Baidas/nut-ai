# Inherited design

> **This is an archive, not a specification. Nothing in it governs anything.**
>
> It records what someone intended, reconstructed from comments left in the code. It is not a
> description of what the code does, and no sentence in it should be read as a claim about the
> current system. If you arrived here from a `SPEC-accuracy-engine.md`, `SPEC-ui.md`,
> `SPEC-product.md` or `PLAN.md` citation in a source file, this is where that citation now points —
> and the thing it points at is a record of intent, not an authority you can cite back.
>
> **Frozen.** Write-once. It is never updated when the code changes. That is deliberate: a document
> that records what was intended cannot be falsified by a later commit, and one that tracked the
> code would need a maintainer forever. For what is actually built, read the code and the tests.

## Why this file exists

Forty-four tracked files in this repository cite four design documents:

| Document | Cited as | Archived here as |
| --- | --- | --- |
| `SPEC-accuracy-engine.md` | 33 citations across the TS surface, plus 2 outside it | Part I |
| `PLAN.md` | 10 citations across the TS surface, plus 6 outside it | Part II |
| `SPEC-ui.md` | 2 citations | Part III |
| `SPEC-product.md` | 1 citation | Part IV |

**None of those four documents has ever existed in any repository, upstream or fork.** The citations
are the only surviving trace of them. What they cite, however, is not lost: 48 comment blocks carry
734 lines — roughly 6,000 words — of prose explaining the reasoning behind each coordinate, and each
fragment names the coordinate it belongs to. This file is those fragments, assembled and ordered — an assembly job,
not an inference-from-behaviour job.

The four documents are kept as four **Parts** rather than merged, because their section numbering
collides. `§4.1` is reference-object scale priors in Part I and the Node-purity requirement in
Part II. `§4` is the gram engine in I and design tokens in III. `§3.3` is provider wire formats in I
and "ruling 2" in II. The filenames used to disambiguate; the Part numerals do it now.

## How to read an entry

Each entry gives the inherited coordinate, the source file the prose was recovered from, and the
reasoning as it was recorded. The reasoning is preserved close to verbatim. Where the inherited text
asserts a fact, a figure, or a citation to outside literature, it is reproduced as written and not
checked.

**Three things this archive deliberately does not do.**

*No status.* Whether a section was built, half-built, or only imagined is not recorded here. The
material mixes all three and the comments give no way to tell them apart — that ambiguity is the
reason this archive is frozen rather than ratified, and annotating it would mean guessing. Part I
§8.4 is the worked example: the scorers it describes exist as implemented, tested code, while the
harness that would run them against a golden set does not. Both facts sit outside this file's remit.
Status belongs to the governing layer.

*No repair.* Where the inherited design contradicts itself, the contradiction is preserved. Part I
§6.3 is the case in point, and the comment that records it is reproduced in full.

*No invention.* Three coordinates are named in the source comments without any accompanying
explanation. They are listed at the end of their Part with what the citing file implies and nothing
more. If you extend this archive, hold that line: a coordinate with no surviving source text stays
empty.

---

# Part I — Accuracy engine

*Archiving `SPEC-accuracy-engine.md`. Section numbers are the inherited ones.*

## §1.1 — Pipeline stages

*Recovered from `packages/pipeline/src/index.ts`, `apps/mobile/app/camera.tsx`,
`packages/prompt/src/local-signals.ts`*

The pipeline was described as ten stages, 0 through 9, of which the module wiring stages 4 through 9
was to be pure — taking a `VisionPayload` and a database handle and returning a `ScanResult`,
performing no network I/O, holding no credentials, and touching no platform API.

    [3] INFERENCE          <- the caller does this; the ONLY path-divergent stage
    [4] EXTRACT + CLAMP    Zod validate, then the non-skippable sanity clamp
    [5] GRAMS              the reconciliation ladder
    [6] RESOLVE            barcode exact -> FTS5 -> six-signal scoring
    [7] TOTALS             pure arithmetic
    [8] CONFIDENCE         measured bands, structural widening, quadrature
    [9] RESULT + REPAIR    questions and pre-answered chips

That purity was justified as what lets an eval harness run the real pipeline — not a
reimplementation of it — against a golden set under plain Node. A harness scoring raw model output
was held to measure the wrong thing entirely, because most of the accuracy was said to live in these
stages rather than in the model call.

The governing structural claim: **nothing after stage 3 branches on `path`** except to render a
badge and widen a band. Path A and Path B converge on one `VisionPayload` and share every line of
code below it.

**Stages 0 and 1 — capture.** The shutter always succeeds. It writes a draft row before anything
else can fail — no key, no network, no model, no permission to analyze. The stated reason: a capture
that fails because the network is down loses the user's meal, and losing a meal is unrecoverable in
a way that a wrong number never is. Everything after the shutter was to live behind the result
screen's progress states.

**Stage 2 — local signals.** See §2.3 below.

## §2.1 — The system prompt

*Recovered from `packages/prompt/src/system-prompt.ts`*

The prompt was to ship verbatim, with `<prompt_version>` living **inside** the prompt body, so that
it is impossible to log a scan without knowing which prompt produced it — the property that lets an
eval harness attribute a regression to a prompt change rather than guessing.

The rationale recorded for the parts of the prompt that look redundant:

- **"You are a perception device"** is load-bearing, not decoration. Without it the model optimizes
  for a confident gram number — precisely the field trusted least. Reframing the job around
  description is what makes the deterministic gram engine receive good inputs.
- **The "what you are bad at" bullets** map 1:1 onto the top real-world complaints: hidden oil (five
  independent sources converging near-verbatim), mixed dishes at 25–50% variance, portion depth.
  Every provider's model is trained partly on confident food-blogger captioning; without explicit
  anchoring it defaults to exactly the overconfidence the product exists to fix.
- **The sanity-bounds paragraph** is the first line of defence against the 27M-calorie class of bug.
  The clamp (§3.4) is the second and non-bypassable one. Cheap prompt text plus a hard gate, never
  one instead of the other.
- **Splitting `identification_confidence` from `portion_confidence`** operationalizes the finding
  that these are different tasks with different reliability.
- **The USDA-style `canonical_food_key` convention** is an information-retrieval lever, not a style
  preference: BM25 is sensitive to term overlap, so a query written in the target corpus's own idiom
  systematically outscores an equally correct query in conversational English against that same
  corpus. (See §5.4.)
- **"Look for companion drinks"** exists because beverages beside a plate are documented to go
  undetected entirely — omission, a distinct and worse failure mode than misestimation.

## §2.3 — Local signals

*Recovered from `packages/prompt/src/local-signals.ts`*

The per-scan context block was to be a **labeled text block in the user message**, never merged into
the cached system-prompt prefix. Two independent reasons were given:

1. **Prompt caching.** The system prompt is identical on every request and is the thing worth
   caching; splicing per-scan context into it would invalidate the cache on every single scan and
   multiply cost.
2. **Provenance.** Context about this user's containers and habits is data, not instruction. Keeping
   it in the user turn, clearly labeled, means the model cannot mistake a food name in the user's
   own history for a directive.

The value of the block was recorded as externally corroborated: ACETADA (Purdue controlled-feeding
RCT, food weighed to 0.1 g) measured contextual metadata improving calorie MAE by roughly 76 kcal on
average across GPT-4o, Claude and Gemini.

## §3 — Cloud inference (Path A)

*Recovered from `apps/mobile/src/inference/pathA/client.ts`*

A thin wrapper over React Native's `fetch`, deliberately **not** the vendor Node SDKs, which were
held to assume Node runtime features Hermes does not guarantee. Non-streaming: one request in, one
JSON object out — removing the single largest RN `fetch`/`ReadableStream` risk from the core
feature. This was to be the only place in the app that reads an API key, and the key travels to
exactly one destination: the provider the user named. (See also Part II, D10.)

## §3.1–3.2 — The vision payload

*Recovered from `packages/core-schema/src/vision-payload.ts`*

One canonical schema, three emitted provider shapes, one client-side validator running for all of
them. The `VisionPayload` was to be the only thing an inference model is allowed to return.

The governing rule, visible in the shape of the type: **the model is a perception device; it never
owns a number the user sees.** It reports what it can actually see — identity, form, relative size,
reference objects, cooking cues, legible text, and what it could not determine. Grams are computed
downstream by the gram engine, nutrition comes from a database row via the resolver, totals are
arithmetic, confidence comes from measured per-category error.

Two omissions were described as carrying most of the weight:

1. **There is no `meal_totals` field.** Not "present but ignored" — absent. A field always discarded
   is paid output tokens plus a standing temptation to render it. Its absence is what makes a
   macro-reconciliation mismatch unreachable rather than merely guarded against.
2. **The mass field is `model_gram_estimate`, not `estimated_grams`.** It sits at rank 5 of 6 in the
   reconciliation ladder. A field named `estimated_grams` invites a developer to display it; this
   one does not.

## §3.3 and §3.5 — Provider wire formats

*Recovered from `packages/prompt/src/providers.ts`*

One canonical schema, three emitted shapes. The module was to build request **bodies** only —
no I/O, no credentials, nothing platform-specific — so an eval harness could diff the exact bytes
each provider would receive without a network stack. The per-provider differences were recorded as
small but each load-bearing:

- **Anthropic** rejects numeric and length bounds in structured-output schemas, so
  `minimum`/`maximum`/`minItems`/`pattern` must be stripped. They live in the Zod validator instead,
  enforced client-side for all providers uniformly — which is what actually matters.
- **OpenAI** strict mode has no concept of optional-but-not-required, so every property must appear
  in `required` and nullability is expressed as a type union.
- **Gemini** accepts a looser shape, and its free tier was to be blocked entirely for photo scans.

## §3.4 — The deterministic sanity clamp

*Recovered from `packages/clamp/src/index.ts`*

Recorded in the inherited text in bold: **always on, every scan, both inference paths, non-LLM,
near-zero cost, never skippable.**

Described as the direct countermeasure to the most embarrassing documented failure in the product
category — an approximately 27-million-calorie output, observed across two independent research
passes. It was to ship **before** any LLM-based verifier, not instead of one: a second model call to
check the first model's arithmetic costs money, adds latency, and can itself be wrong. Arithmetic
cannot.

A flag never silently deletes an item. It degrades it honestly, in three effects:

- (a) the flag is recorded on the log entry, for support and for the eval harness
- (b) the item's confidence is forced to the lowest band
- (c) a visible "please check this one" marker is surfaced in the UI

One departure from the inherited spec is itself recorded in the source: unlike the spec's reference
implementation, the clamp was made **pure**, returning a new payload rather than mutating its input,
because an eval harness replaying the same payload through multiple pipeline configurations would
have run N's corrections silently contaminate run N+1.

## §3.8 — The optional LLM verifier

*Recovered from `packages/clamp/src/index.ts`*

A user-enabled verifier pass, armed by a deliberately narrow set of clamp flags — those indicating
the model's output is not merely imprecise but internally incoherent.

## §4 — The gram engine

*Recovered from `packages/gram-engine/src/index.ts` and `types.ts`*

Pure TypeScript over bundled tables. Same code, both inference paths. Under 10 ms.

Described as where the accuracy actually lives: the model says **what** is on the plate and roughly
what shape it is; this decides **how much**, using deterministic tables. The difference between
those two jobs was called the entire product thesis.

The justification recorded in one figure: Gemini 2.5 Flash's carbohydrate MAPE moved 56.6% (no
weight info) → 39.5% (predicted weight) → 20.2% (ground-truth weight). Knowing the mass collapses
error by roughly two thirds — a larger lever than any model upgrade, realized by deterministic
tables plus a portion-confirmation UI rather than a smarter model.

And the reason no hardware was to be bought for it: DPF-Nutrition measured RGB-only at 20.9% mean
PMAE, software-predicted depth at 17.8%, and a real depth sensor at 17.2%. LiDAR buys 0.6 percentage
points — not worth Pro-device fragmentation plus custom native code on two platforms.

## §4.1 — Reference-object scale priors

*Recovered from `packages/gram-engine/src/reference-objects.ts`*

Ranked by **size variance**, not by how often the object appears. That ordering was called the whole
point: a dinner plate is the most commonly present anchor and one of the worst, because "dinner
plate" spans 23–33 cm, and that ±18% lands on the scale factor before any food-area error even
starts compounding.

GoCARB was cited as the clinical precedent for the approach — a standardized reference card beside
the meal, two photos from different angles, volumetric assessment against a nutrition database,
validated in *Diabetes Care* (2016), where it beat patients' own manual carb counting.

## §4.2 — Food-form volume heuristics

*Recovered from `packages/gram-engine/src/volume.ts`*

A food-form classifier gates which volume formula fires. No universal formula was held to exist, and
pretending otherwise was described as how a pipeline gets confidently wrong on leafy greens
(0.06 g/mL) using a constant tuned for casseroles (1.04 g/mL).

Recorded as the single largest unproven-number risk in the pipeline: **two tables have no
authoritative published source** — the flat thickness table and the pile factors. They were items 1
and 2 in the §11 device protocol: measure real grocery cuts with calipers and a scale; photograph
known-mass piles at varying heights and back-solve the factor per class. Until that happened, the
values were to be treated as inferred, with every number derived from them carrying a wide band.

## §4.3 — Density

*Recovered from `packages/gram-engine/src/density.ts`*

Licensing was stated plainly and drove the design. The FAO/INFOODS Density Database v2.0 (2012) —
638 entries, the obvious source — is not CC0 like USDA FDC and not ODbL like Open Food Facts. Its
copyright page was quoted verbatim: *"All rights reserved… Non-commercial uses will be authorized
free of charge, upon request. Reproduction for resale or other commercial purposes, including
educational purposes, may incur fees."*

**The decision: do not bundle the FAO table.** A small, hand-authored table was to be written for
this project under this project's own terms, using the FAO figures as a validation reference rather
than as bundled content. Rows whose FAO source code is USDA or FNDDS are independently re-derivable
from the CC0 USDA source, which was named as where they should come from at pipeline-build time.

The most important thing the table was to encode: **there is no universal density.** Raw green salad
leaves are 0.06 g/mL and a casserole is 1.04 g/mL — a 17× spread.

## §4.5 — Cooking yields and oil absorption

*Recovered from `packages/gram-engine/src/yields.ts`*

The yield figures were recorded as confirmed from the USDA Table of Cooking Yields for Meat and
Poultry (Showell et al., USDA ARS Nutrient Data Laboratory, December 2012), public domain as a US
government work — real wet-lab measurements, moisture via AOAC 950.46 and fat via acid hydrolysis,
not estimates. The core equation, verbatim:

    Yield (%) = 100 x (Wch / Wcr)      cooked-hot weight over raw weight

**The load-bearing rule:** yields are food-class-specific lookups. No generic meat constant was to
exist anywhere in the codebase. Bacon yields 29–32% — roughly 70% of raw weight lost to rendered fat
and moisture — while cured ham-and-water product yields 96%. A pipeline applying a generic
"meat ≈ 75%" to bacon was called not slightly off but structurally, wildly wrong.

## §4.6.2 — Reconciliation

*Recovered from `packages/gram-engine/src/reconcile.ts`*

A trust hierarchy, not an average. **Do not silently average.**

A large disagreement between two independent signals was itself held to be information — arguably
the most useful information the pipeline produces, because it is the one case where the app knows it
does not know. Blending 140 g and 220 g into 180 g destroys that and replaces it with a
confident-looking number that is probably wrong in a way nobody can see.

When the threshold fires, the user was to see: *"We're not sure — does this look more like 140 g or
220 g?"* with both numbers as taps. That question exists only because two independent estimates were
kept instead of collapsed.

## §4.8 — Personal gram priors

*Recovered from `packages/gram-engine/src/priors.ts`*

The flagship "it learns from you" mechanism, and the direct answer to the best-corroborated finding
about the incumbent app: four independent sources using near-identical language — *"no way to teach
the AI"*, *"does not improve based on your corrections"*, *"corrections do not persist between
scans"*.

An explicit non-goal was stated plainly: **none of this is model fine-tuning.** "The app learns from
you" was to be entirely a local statistics problem — EWMA ratios, frequency tables, median gram
weights; plain SQLite and arithmetic. Zero dependency on fine-tuning infrastructure, provider
personalization APIs, or on-device training. And because it sits strictly below the inference call,
it works identically on Path A and Path B by construction.

## §4.9 — Per-pathway uncertainty half-bands

*Recovered from `packages/gram-engine/src/bands.ts`*

Every band was to trace to a specific cited figure — recorded as mattering for defending the
accuracy-honesty positioning against the obvious challenge, *"how do you know these ranges are
right?"*

These were the **literature-seeded** values. They were to ship first, labeled in-app as seeded rather
than measured, and be replaced by values an eval harness regenerates from the golden set (Part II,
D17). Shipping a fabricated "measured" range was called a worse dishonesty than saying nothing.

## §5 — Nutrition resolution

*Recovered from `packages/resolver/src/index.ts`*

The stage between "the model says this is grilled chicken breast" and "165 kcal per 100 g, from FDC
row 171077". Everything here was to be offline: no network call was ever part of this stage, on
either inference path, which is what makes the whole repair loop free.

## §5.2 — The nutrition corpus

*Recovered from `tools/nutrition-data/src/build.mjs`*

The generic tier ships first (~15–25 MB); branded and national tables are additive stages gated
independently.

Recorded as what made the stage risky: two prior research passes could not read USDA's
field-description PDF (it 403'd both times), so the column names of `food_portion` and `measure_unit`
were explicitly **unconfirmed**. The build was therefore to validate every header against the real
CSV and fail loudly on a mismatch rather than silently produce a corpus with empty portion weights.

A second rule: **NULL never becomes 0.** USDA's own disclaimer is explicit that a missing value means
data were not supplied, not that the amount is zero. A fabricated zero was called worse than an
absent value, because it looks like knowledge.

## §5.3 — Two databases

*Recovered from `packages/db-adapter/src/schema.ts`*

Two databases with deliberately separate lifecycles, and the separation was described as licensing
as much as engineering:

| | |
| --- | --- |
| `nutrition.db` | read-only PC-hosted database. ODbL/CC0 **data**, built on the user's PC and served over Tailscale. |
| `user.db` | writable, local, user-owned. Never mixed with the corpus. |

Keeping them apart means a nutrition-database update can never mutate a historical log, and the data
license never has to interact with the code license.

## §5.4 — FTS5 query construction

*Recovered from `packages/resolver/src/query.ts`*

Two things the module was deliberately **not** to do, because FTS5 already does them better:

- **Plurals and inflection** → the porter tokenizer, not app code. It is applied identically to
  indexed content and to the query, so over-stemming (`sauce` → `sauc`) is irrelevant: it only has to
  be internally consistent, which it is by construction.
- **Word order** → needs no handling at all. FTS5 ANDs bareword tokens regardless of order, so
  `chicken breast grilled` matches "Chicken, broilers or fryers, breast, meat only, cooked, grilled".
  USDA's comma-reversed, attribute-heavy naming works naturally with unordered token matching, and no
  comma-permutation logic is needed anywhere.

This was named as the concrete reason the system prompt insists on generic-noun-first USDA-style
keys: the query and the corpus share an idiom, and BM25 rewards that.

## §5.5 — Candidate scoring

*Recovered from `packages/resolver/src/scoring.ts`*

Six signals plus one penalty, combined linearly. The weights were described as tunable constants to
be fitted against real dogfood logs — a reasoned starting point, not final numbers — living in one
place precisely so that fitting them is a one-file change.

## §5.6 — GTIN normalization

*Recovered from `packages/resolver/src/gtin.ts`*

A UPC-A is technically an EAN-13 with a leading zero, so everything normalizes to a canonical
13-digit GTIN at **both** index-build time and scan time. Standard GS1 practice, and the reason a
UPC-A scanned off a US package finds the same row as its EAN-13 equivalent.

Getting it wrong was called the most confusing possible bug class: the barcode is in the database,
the scan succeeds, and the lookup misses.

## §6 — Totals

*Recovered from `packages/totals/src/index.ts`*

Pure arithmetic over per-100 g snapshots. Zero network, zero device APIs, sub-millisecond.

Recorded as the reason no correction ever needs a paid model call again. The inference model's only
job was producing the initial `IngredientRow[]`; every subsequent action is local arithmetic over
values already on the device:

    edit grams          -> factor changes, snapshot does not. Multiplication.
    swap identity       -> new snapshot copied from a local SQLite row. Instant.
    answer "oil?"       -> push a synthetic ingredient row, then recompute.
    answer "all of it?" -> set portionEatenFraction. One multiplier.
    add / remove        -> splice. There is no data-model difference between
                           "the AI added rice and I removed it" and "I removed
                           rice because I didn't eat it."

## §6.1 — The stored domain model

*Recovered from `packages/core-schema/src/domain.ts`*

One invariant was said to pay for the entire product:

> Every ingredient row, regardless of origin, is stored as
> (food_reference, grams, per-100g nutrient snapshot) — **never** as a bare calorie or macro number.

Everything downstream was held to fall out of that:

- Corrections are free, instant, and offline forever, on **both** inference paths, because a
  correction is arithmetic over values already on device.
- Historical logs never silently change when the nutrition database updates, because the snapshot was
  copied at add time and is immutable thereafter.
- Saved meals survive any database update for the same reason.

The alternative — storing opaque totals — was named as what forces a second paid model call to fix a
wrong number, and what lets a database update rewrite what you ate last March.

## §6.3 — Display rounding *(the inherited text contradicts itself here)*

*Recovered from `packages/totals/src/totals.test.ts` and `VERIFICATION.md`*

This coordinate is preserved as a contradiction because that is what the source records. Reproduced
from the comment:

> `SPEC-accuracy-engine.md` §6.3 contradicts itself here. The stated rule is "one decimal for grams
> under 10 g; whole grams at 10 g and above", which makes 6.19 g of fat display as 6.2. But the
> worked example immediately below it shows that same 6.19 rounding to 6 — the whole-gram rule — and
> therefore reports 466 kcal.
>
> We follow the STATED RULE, not the example, for two reasons: it preserves real information (6.2 g
> of fat is a materially different number from 6 g when the daily target is ~60 g), and the property
> that actually matters is unaffected — displayed calories are computed FROM the displayed macros
> either way, so the user can still hand-multiply and get the shown figure.
>
> Under the stated rule: round(4*53 + 4*50 + 9*6.2) = round(467.8) = 468.

`VERIFICATION.md` independently logs the same defect as "a self-contradiction in
`SPEC-accuracy-engine.md` §6.3".

## §7 — Confidence and calibration

*Recovered from `packages/confidence/src/index.ts`*

**Why the model's own confidence number is not the answer.**

Verbalized LLM confidence was recorded as measurably miscalibrated, citing Xiong et al., *"Can LLMs
Express Their Uncertainty?"* (arXiv:2306.13063), which finds models *"tend to be overconfident,
potentially imitating human patterns of expressing confidence"*, and that black-box confidence
elicitation trails white-box internal-probability methods by an AUROC gap of 0.522 to 0.605.

Under bring-your-own-key, token probabilities are never visible — only whatever JSON the API returns
— so the design was described as **structurally confined to the worse side of that gap**.
Small-classifier softmax was noted to have the mirror-image problem: overconfident without
temperature scaling.

So the model's self-report was to be a **modifier, never the signal**. The primary signal was to be
measured per-pathway and per-category error from the project's own eval harness.

And the bar to clear was stated as not "perfectly calibrated Bayesian intervals": the incumbent shows
no confidence score, error range, or uncertainty indicator of any kind, while its FAQ concedes
*"CalAI is about 80% accurate"* and its blog boilerplate claims 90% — two different self-reported
numbers from one company, neither per-scan, neither sourced. **The bar is showing any honest measured
signal at all.**

## §7.3 — Category-derived uncertainty

*Recovered from `packages/repair/src/question-bank.ts`*

Deriving uncertainty from the food category alone, with no model self-report. Described as what makes
Path B possible at all — an on-device classifier cannot emit `stated_assumptions`,
`clarifying_questions` or `uncertainty_reason`, so on Path B this is the sole source of those fields.

On Path A it is a **floor**, applied as a union and never a replacement: if the model failed to flag
oil on a stir-fry, flag it anyway. *The model not mentioning something is not evidence that it is not
there.*

## §8.1 — The interruption rule

*Recovered from `packages/repair/src/index.ts`*

    expected_value(Q) = P(assumption_wrong) x expected_kcal_swing(Q) x severity

    ASK Q as a highlighted chip iff  expected_value(Q) > INTERRUPTION_THRESHOLD
                                     AND selected_this_scan < MAX_QUESTIONS
    ELSE apply the silent default and render it as a visibly-editable,
         clearly-labeled, PRE-ANSWERED chip. Never a hidden assumption.

The inherited text calls the asymmetry this produces **the single most important property of the
entire design**: a typical home-cooked mixed-dish photo surfaces 1–2 questions, while a banana or a
plain grilled chicken breast surfaces zero and logs in one tap. That asymmetry is what stops the
feature becoming a 30-second chore — named as the failure mode that kills food logging apps.

## §8.2 — Totals invariant and the result screen

*Recovered from `packages/totals/src/totals.property.test.ts`, `apps/mobile/app/result.tsx`*

The invariant, stated as property test 1 of 3:

> For **any** ingredient list, after **any** sequence of add / remove / edit-grams / set-fraction
> operations, the displayed total equals Σ(grams/100 × per-100g) × portionEatenFraction.

This was recorded as the invariant the incumbent shipped broken: editing protein from 226 g to 175 g
left calories sitting at 2,964 kcal, unchanged. A single-example unit test was held insufficient to
catch it, because the bug only appears after a specific *sequence* of operations — generating the
sequences was the point.

On the result screen: **one primary action, `Log it`. There is no `Fix Results` mode.** The inherited
text is emphatic that this is not a simplification but the fix — a separate "fix mode" structurally
forces the interruption cost to be paid even when nothing is worth asking, and is what makes
"re-analysis that deletes the ingredients you already corrected" possible at all. **The review screen
is the fix screen.** Every row editable in place; every edit recomputes locally, instantly, for free.
(See also Part II, §3.3 ruling 2.)

## §8.4 — Accuracy scorers and the ranked question bank

*Recovered from `eval/src/scorers.ts`, `packages/repair/src/question-bank.ts`*

**The scorers.** Every metric was said to exist because a simpler one would hide something:

- **Median and IQR alongside the mean**, because the distributions are heavy-tailed (Lo 2024: MAE
  69.2±34.7 kcal for a single food, 151.2±125.3 for a mixed meal). A mean alone cannot distinguish
  "uniformly mediocre" from "mostly fine with a few catastrophic misses", and those call for
  completely different work.
- **MSPE, signed**, because the most corroborated finding in the whole corpus is systematic
  **undercounting** — and MAPE, being absolute, is blind to it. An app that is 30% wrong in both
  directions is a different product from one that is 30% low every time.
- **Band coverage**, because it is the only metric that tests the honesty claim rather than the
  accuracy claim. A systematically too-narrow band is a ship-blocker even when MAPE looks
  respectable: it means the app says "I am confident" and is wrong.

**The question bank.** Ordered by (a) swing magnitude, (b) how invisible the ambiguity is in a photo,
and (c) how cheaply and certainly asking resolves it. Ranks 1–2 top the list because they are
multiplicative and fully resolvable with certainty — factual questions, not perceptual ones. Rank 3
is third because hidden oil is the single most over-determined complaint in the entire research
corpus: five independent sources converging near-verbatim.

The bank-wide rule: **every silent default is disclosed inline on the result card, never hidden.**
That was held to satisfy "ask when unsure" and "minimize the cost of poor guesses" simultaneously, by
making every guess auditable and one-tap correctable even when not interrupting for it.

Swing magnitudes were to be standard USDA-consistent nutrition science (fat 9 kcal/g, carb 4, protein
4, alcohol 7), while the exact per-100 g values used to **apply** an answer must come from the actual
bundled FDC rows at runtime, never from illustrative figures.

## Coordinates named in Part I without surviving text

- **§8.5** — an accessibility bar. Cited from `apps/mobile/src/components/ConfidenceChip.tsx`, which
  implies it sets a colour-independence requirement that colour alone would fail. No further text
  survives.
- **§11** — a device protocol. Cited from `packages/gram-engine/src/volume.ts`, which implies it is a
  numbered list of physical-measurement tasks whose items 1 and 2 are the flat thickness table and
  the pile factors (§4.2). No further text survives.

---

# Part II — Plan and rulings

*Archiving `PLAN.md`. Section numbers, `D`-numbered decisions and `M`-numbered milestones are the
inherited ones.*

## §3.3, ruling 2 — No separate fix mode

*Recovered from `apps/mobile/app/result.tsx`*

Cited alongside Part I §8.2, which carries the reasoning: one primary action, no `Fix Results` mode,
the review screen is the fix screen.

## §4.1 — Node purity

*Recovered from `packages/db-adapter/src/types.ts`, `scripts/check-node-purity.mjs`,
`packages/core-schema/src/index.ts`, `packages/db-adapter/src/index.ts`,
`apps/mobile/src/db/expo-adapter.ts`, `vitest.config.ts`*

The most-cited coordinate in the archive. `PLAN.md` §4.1 was quoted directly in the purity gate:

> Every `packages/*` module must remain importable in plain Node with zero React Native surface.
> Enforce with a CI check that imports each package in a bare Node script.

The inherited text calls this **"the one non-obvious architectural requirement"**, and names it as
the reason the whole `packages/*` purity rule exists:

> The eval harness must import the REAL gram engine and the REAL resolver and run them under Node
> against the golden set. Without a Node-runnable database, the harness could only score raw model
> output — which measures the wrong thing, because the gram engine and resolver sit between the model
> and the number a user sees, and that is where much of the accuracy lives.

**The database consequence.** One interface, two implementations, split by where they are allowed to
live:

- `better-sqlite3` → `@nutai/db-adapter/node`, inside the package. Node only.
- `expo-sqlite` → `apps/mobile/src/db`, **not** in the package.

An `import 'expo-sqlite'` inside `packages/*` would fail the node-purity gate — described as exactly
the gate doing its job. `apps/mobile` was to be the only package allowed to hold React Native
imports. Both implementations satisfy the same interface, which is what makes "it worked in the
harness" mean something on device.

The interface was to be **async even though `better-sqlite3` is synchronous**, because `expo-sqlite`
is not: making the shared interface async costs the Node side one trivially-resolved promise per call
and saves the app side from a lie.

**The gate's own design.** Two checks, because they catch different failures:

1. **Static** — scan source for forbidden import specifiers. Catches the mistake at the moment it is
   written, with a precise `file:line`.
2. **Runtime** — actually `import()` each package's entry in the Node process. Catches transitive
   contamination through a dependency, which no amount of source scanning will find.

The failure message directs the developer to put platform behaviour behind an interface and implement
it in `apps/mobile`, and for storage specifically to use the db-adapter.

Test configuration was to alias `@nutai/*` to package **source**, not `dist`, so the unit-test loop
runs without a build step; the purity gate separately verifies the **built** output imports cleanly
under bare Node.

## §4.4 — Key handling

*Recovered from `.gitignore`*

API keys live only in `expo-secure-store`, written from runtime user input, and **never** from
`EXPO_PUBLIC_*`, `app.json`, `.env`, or EAS secrets. Never committed.

## §8.2 — The totals property test

*Recovered from `packages/totals/src/totals.property.test.ts`*

Cited jointly with Part I §8.2, which carries the statement of the invariant.

## §8.4 — Scorers

*Recovered from `eval/src/scorers.ts`*

Cited jointly with Part I §8.4, which carries the reasoning for each metric.

## D6 / D8 — The nutrition data artifact

*Recovered from `.gitignore`*

The built nutrition data artifact is produced by a separate `nutai-nutrition-data` project and never
committed to this repository. It is ODbL-licensed and lives on its own release cadence.

## D10 — `fetch` over vendor SDKs

*Recovered from `apps/mobile/src/inference/pathA/client.ts`*

Cited alongside Part I §3, which carries the reasoning: React Native's `fetch` rather than the vendor
Node SDKs, because those assume Node runtime features Hermes does not guarantee.

## D16 — The model is a perception device

*Recovered from `packages/core-schema/src/vision-payload.ts`*

Named as the governing rule made visible in the shape of the `VisionPayload` type: **the model is a
perception device; it never owns a number the user sees.** Reasoning archived under Part I §3.1–3.2.

## M0.5 — Corpus build milestone

*Recovered from `tools/nutrition-data/src/build.mjs`, `tools/nutrition-data/src/golden-queries.mjs`*

The nutrition-corpus build milestone, shipping the generic tier first to unblock M1 (see Part I
§5.2).

**Exit criterion 3**, quoted in the golden-query suite: a fixed set of queries must resolve to
known-correct rows, and the build fails on regression. The reasoning: a build that merely "completes"
tells you nothing — the failure mode that matters is a rebuild where every row is present but
"chicken breast" stops matching, and only a query-level assertion catches that.

## Coordinates named in Part II without surviving text

- **D17** — regenerating uncertainty bands from the golden set. Cited from
  `packages/gram-engine/src/bands.ts`, which implies it governs the replacement of literature-seeded
  band values with eval-harness-measured ones (Part I §4.9). No further text survives.

---

# Part III — UI

*Archiving `SPEC-ui.md`. Section numbers are the inherited ones.*

## §0.2, rule 1 — Uncertainty must be visible

*Recovered from `apps/mobile/src/components/ConfidenceChip.tsx`*

> A number the app is unsure about must **look** unsure, everywhere it appears.

Described as the product's whole reason to exist, and as exactly what the incumbent's result screen
is confirmed never to show — *"no confidence score, error range, or uncertainty indicator of any
kind"*, converged across four independent sources.

Two deliberate choices for the confidence chip:

- **Colour is violet, never amber or red.** Low confidence is an invitation to check, not a scold.
  Red belongs to safety warnings only.
- **The glyph carries the tier independently of colour**, so confidence survives protanopia,
  deuteranopia, tritanopia and a greyscale screenshot. Colour alone would fail the accessibility bar
  in Part I §8.5.

## §4 — Design tokens

*Recovered from `apps/mobile/src/theme/tokens.ts`*

The design system as typed tokens, in the only file in the app allowed to contain a hex colour, with
an ESLint rule enforcing it. Stated not to be tidiness: a hardcoded colour is a colour that silently
ignores dark mode and never gets contrast-checked.

**The colour rule called out as mattering most:**

> Red is reserved for **safety** warnings only. Never for food, never for a missed goal, never for a
> number being "bad".

The reasoning: the app being replaced reuses one coral hue for both "protein" and "you missed your
goal", turning a food-group identity colour into a shame signal. Uncertainty here is **violet** — an
invitation to check, not a scold. A scolding colour was named as what makes people switch the
indicator off, which defeats the entire point of having one.

---

# Part IV — Product

*Archiving `SPEC-product.md`.*

## Goals math, steps 1–8

*Recovered from `packages/goals/src/index.ts`*

BMR, TDEE, targets, macro splits, weight-trend smoothing, adaptive TDEE — pure arithmetic,
unit-testable in Node.

Two principles were said to run through all of it:

1. **Nothing is silently substituted.** When the safety floor raises a target, the result carries the
   raw value and the reason, so the UI can say *"your target would have been 1,050 kcal, but we don't
   go below 1,200 — here's why."* Named as the same reconciliation-first principle that makes the
   macro-edit bug (Part I §8.2) impossible.
2. **No moralizing.** These functions produce numbers and explanations, never judgments. Nothing
   returns a "you're behind" or a pass/fail day.

---

# Coordinate index

Every coordinate cited anywhere in the repository, and where its explanatory prose was recovered
from. Coordinates marked † are named in a citing file but have no surviving explanatory text.

## Part I — `SPEC-accuracy-engine.md`

| Coordinate | Recovered from |
| --- | --- |
| §1.1 | `packages/pipeline/src/index.ts`, `apps/mobile/app/camera.tsx`, `packages/prompt/src/local-signals.ts` |
| §2.1 | `packages/prompt/src/system-prompt.ts` |
| §2.3 | `packages/prompt/src/local-signals.ts` |
| §3 | `apps/mobile/src/inference/pathA/client.ts` |
| §3.1–3.2 | `packages/core-schema/src/vision-payload.ts` |
| §3.3, §3.5 | `packages/prompt/src/providers.ts` |
| §3.4 | `packages/clamp/src/index.ts` |
| §3.8 | `packages/clamp/src/index.ts` |
| §4 | `packages/gram-engine/src/index.ts`, `packages/gram-engine/src/types.ts` |
| §4.1 | `packages/gram-engine/src/reference-objects.ts` |
| §4.2 | `packages/gram-engine/src/volume.ts` |
| §4.3 | `packages/gram-engine/src/density.ts` |
| §4.5 | `packages/gram-engine/src/yields.ts` |
| §4.6.2 | `packages/gram-engine/src/reconcile.ts` |
| §4.8 | `packages/gram-engine/src/priors.ts` |
| §4.9 | `packages/gram-engine/src/bands.ts` |
| §5 | `packages/resolver/src/index.ts` |
| §5.2 | `tools/nutrition-data/src/build.mjs` |
| §5.3 | `packages/db-adapter/src/schema.ts` |
| §5.4 | `packages/resolver/src/query.ts` |
| §5.5 | `packages/resolver/src/scoring.ts` |
| §5.6 | `packages/resolver/src/gtin.ts` |
| §6 | `packages/totals/src/index.ts` |
| §6.1 | `packages/core-schema/src/domain.ts` |
| §6.3 | `packages/totals/src/totals.test.ts`, `VERIFICATION.md` |
| §7 | `packages/confidence/src/index.ts` |
| §7.3 | `packages/repair/src/question-bank.ts` |
| §8.1 | `packages/repair/src/index.ts` |
| §8.2 | `packages/totals/src/totals.property.test.ts`, `apps/mobile/app/result.tsx` |
| §8.4 | `eval/src/scorers.ts`, `packages/repair/src/question-bank.ts` |
| §8.5 † | `apps/mobile/src/components/ConfidenceChip.tsx` |
| §11 † | `packages/gram-engine/src/volume.ts` |

## Part II — `PLAN.md`

| Coordinate | Recovered from |
| --- | --- |
| §3.3 ruling 2 | `apps/mobile/app/result.tsx` |
| §4.1 | `packages/db-adapter/src/types.ts`, `scripts/check-node-purity.mjs`, `packages/core-schema/src/index.ts`, `packages/db-adapter/src/index.ts`, `apps/mobile/src/db/expo-adapter.ts`, `vitest.config.ts` |
| §4.4 | `.gitignore` |
| §8.2 | `packages/totals/src/totals.property.test.ts` |
| §8.4 | `eval/src/scorers.ts` |
| D6, D8 | `.gitignore` |
| D10 | `apps/mobile/src/inference/pathA/client.ts` |
| D16 | `packages/core-schema/src/vision-payload.ts` |
| D17 † | `packages/gram-engine/src/bands.ts` |
| M0.5 | `tools/nutrition-data/src/build.mjs`, `tools/nutrition-data/src/golden-queries.mjs` |

## Part III — `SPEC-ui.md`

| Coordinate | Recovered from |
| --- | --- |
| §0.2 rule 1 | `apps/mobile/src/components/ConfidenceChip.tsx` |
| §4 | `apps/mobile/src/theme/tokens.ts` |

## Part IV — `SPEC-product.md`

| Coordinate | Recovered from |
| --- | --- |
| goals math, steps 1–8 | `packages/goals/src/index.ts` |

---

## Provenance

Assembled from the comment blocks present in the working tree at commit `d34aff9`, enumerated with:

```sh
git grep -lE '(SPEC-accuracy-engine|SPEC-ui|SPEC-product|PLAN)\.md'
```

44 tracked files, 48 citation-bearing blocks, 734 lines of source prose, and 47 distinct
coordinates — of which 44 carry explanatory text and 3 (Part I §8.5, Part I §11, Part II D17) are
named by a citing file without it. No content was inferred from code behaviour; every passage above
traces to a comment written by the original author.
