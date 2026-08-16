# Third-party data used by this app

No third-party data is compiled into the binary. The app runs offline until the user enters an AI
provider key or uses the food server. Photo, label and receipt scanning are sent to the provider
the user chose (Anthropic, OpenAI or Google) using the user's own key. Food data is queried from
a nutrition database built on your PC and served over Tailscale.

## Nutrition tiers

The PC-hosted database merges three tiers, each under separate terms:

| Tier | Source | Licence | Dedup |
|---|---|---|---|
| `off` | Open Food Facts | ODbL-1.0 | Always wins a shared GTIN |
| `fdc_branded` | USDA FoodData Central Branded Foods | CC0-1.0 | Loses shared GTINs to `off` |
| `arab_curated` | `tools/nutrition-data/arab-foods.csv` (checked into this repo) | curated-cited | No barcodes, never collides |

### Open Food Facts (ODbL-1.0)

**Attribution:** "Contains information from Open Food Facts, which is made available under the
Open Database License (ODbL) v1.0."

**Share-alike note:** The built `nutrition-full.db` is a derivative database; redistributing it
means redistributing it under ODbL with the same attribution. It is not redistributed by this
repo — it is built locally on your PC and stays there.

### USDA FoodData Central Branded Foods (CC0-1.0)

Public domain release. Attributed per the existing form in the app.

### Arab Curated Foods (curated-cited)

Every row carries a `source` column naming the published food-composition table it was transcribed
from. A row without a citable source does not ship — `parseArabCsv` throws rather than skipping it.
Sourcing policy is checked as part of every build.

## Barcodes

The `off` and `fdc_branded` tiers carry GTINs. `apps/mobile/src/scan/orchestrator.ts` now queries
`/barcode/<gtin>` on the food server. A miss is a miss rather than a silent guess — the app offers
text search and manual entry when no barcode is found.

## Provider data

Photo, label and receipt scanning send the image to the AI provider the user
chose (Anthropic, OpenAI or Google) using the user's own key. Nothing is sent
anywhere else, and no key is compiled into the bundle — see the comment at
`apps/mobile/app.config.ts:74`.
