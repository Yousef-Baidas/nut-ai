# Third-party data shipped in this app

Nut AI bundles one third-party dataset: the nutrition corpus in `nutrition.db`.
No other third-party data is compiled into the binary, and no data is fetched
from a third party without an API key the user supplied themselves.

## The bundled corpus

| Field | Value |
|---|---|
| Source | USDA FoodData Central (FDC) |
| Tiers included | `fdc_foundation`, `fdc_sr_legacy` |
| Rows | 7,928 foods; 14,630 rows in `food_portions` covering 7,643 of those foods |
| Licence | Public domain (USDA FDC data is released without copyright restriction; the build stamps `foods.license` per row) |
| Where it lands | `foods`, `food_portions`, `food_synonyms`, `food_micros` — see `packages/db-adapter/src/schema.ts:39` |

### Attribution

> Nutrient data from USDA FoodData Central, Agricultural Research Service,
> U.S. Department of Agriculture. https://fdc.nal.usda.gov/

USDA does not endorse this app. The app's in-corpus figure line ("USDA, CC0" in
`apps/mobile/app/food-search.tsx`) is the user-facing form of this attribution.

## What the generic tier does NOT contain: barcodes

**Zero of the 7,928 shipped foods carry a barcode.** `fdc_foundation` and
`fdc_sr_legacy` are generic-tier datasets — "Chicken, broilers or fryers,
breast, meat only, cooked, roasted" — and generic foods have no GTIN. The
branded tier (`fdc_branded`), which does carry GTINs, is not shipped.

The consequence is deliberate and is documented in the code: the local-first
barcode query at `apps/mobile/src/scan/orchestrator.ts:405` is correct but
cannot hit against the shipped corpus. Every real scan falls through to either
the keyed web lookup or, with no key, to the honest miss screen that offers
text search and manual entry. Nothing here silently guesses a product.

## Provider data

Photo, label and receipt scanning send the image to the AI provider the user
chose (Anthropic, OpenAI or Google) using the user's own key. Nothing is sent
anywhere else, and no key is compiled into the bundle — see the comment at
`apps/mobile/app.config.ts:74`.
