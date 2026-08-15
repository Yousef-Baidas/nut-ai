# nutai-nutrition-data

Builds the `nutrition.db` artifact the app bundles.

**This project and its output are licensed separately from the application.**
The app is AGPL-3.0; this pipeline is ODbL-1.0, because that is the license the
Open Food Facts tier imports once it is added. Data licenses and code licenses
are legally independent — neither discharges the other.

Sources and their actual terms:

| Source | License | Obligation |
|---|---|---|
| USDA FoodData Central — Foundation Foods, SR Legacy | **CC0 1.0** | None legally. Attributed anyway. |
| USDA FoodData Central — Branded Foods | **CC0 1.0**, carries `gtin_upc` | Preferred over Open Food Facts for US barcodes, which keeps ODbL share-alike off the largest slice of the corpus. |
| Open Food Facts | **ODbL 1.0** + DbCL 1.0 + CC BY-SA 3.0 (photos) | Attribution + share-alike. The shipped `.sqlite` is itself a Derivative Database. |

Not yet ingested, all verified genuinely open and bulk-downloadable:
UK CoFID (OGL v3.0) · Japan MEXT (numerical data explicitly not copyrightable) ·
France CIQUAL (Licence Ouverte) · Germany BLS 4.0 (CC BY 4.0 — free only since
Dec 2025) · Australia FSANZ (CC BY 4.0 AU, and its AUSNUT carries 16,152 portion
records that feed the gram engine directly).

**Do not bundle**, verified restricted: China CFCT (all rights reserved),
India IFCT (restricted), Netherlands NEVO ("unchanged form" only),
Italy CREA, EuroFIR (paid membership).

## Full build (PC only)

`tools/nutrition-data/src/build-full.mjs` builds a full corpus — three tiers,
merged into one SQLite file — as a manual, PC-only step. It is never run on
the phone and its output is never an app asset; it exists to *produce* the
app asset (`nutrition.db`) on a machine that can hold gigabytes of scratch
data.

Three downloads/inputs, ingested in this order (order matters — see dedup below):

1. **Open Food Facts** — the full JSONL export, ~9 GB gzipped:
   ```
   curl -C - -o ~/nut-ai-data/openfoodfacts-products.jsonl.gz \
     https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz
   ```
2. **USDA FoodData Central — Branded Foods** CSV release, unzipped to
   `$FDC_BRANDED_DIR/branded/` (defaults to `~/nut-ai-data/fdc`), containing
   `branded_food.csv`, `food.csv` and `food_nutrient.csv`.
3. **`arab-foods.csv`** — checked into this repo, not downloaded. Every row
   cites a real published food-composition table (currently Pellett &
   Shadarevian's *Food Composition Tables for Use in the Middle East* and
   USDA SR Legacy). **Growing this tier is content work, not code work** —
   add cited lines to the CSV and rebuild; no code change is needed to go
   from 20 rows to 300.

| Tier | Source | License | Barcode dedup |
|---|---|---|---|
| `off` | Open Food Facts | ODbL-1.0 | always wins a shared GTIN |
| `fdc_branded` | USDA FDC Branded Foods | CC0-1.0 | loses a shared GTIN to `off` |
| `arab_curated` | `arab-foods.csv`, cited per row | curated-cited | no barcode, never collides |

**Dedup rule:** `off` always wins a shared GTIN over `fdc_branded` — by tier
rank, not by ingestion order. `insertFood` (`build-full.mjs`) looks up the
resident row for an incoming barcode and, when the incoming tier outranks it,
replaces the resident row; otherwise the incoming row is dropped. This holds
on a REBUILD too: even if `fdc_branded` already owns a GTIN in the resident
database from an earlier run, a subsequent OFF ingest still takes it over.
Ingesting `off` before `fdc_branded` (as this build does) is only an ordering
convenience, not what makes OFF win.

The build records this rule, plus final per-tier row counts and how many
`fdc_branded` rows lost their GTIN to `off`, into `build_manifest`
(`dedup_rule`, `counts.<tier>`, `dedup.branded_lost_to_off`) rather than only
logging it to stdout.

Run the build with:
```
node tools/nutrition-data/src/build-full.mjs
```
Output lands at `~/nut-ai-data/nutrition-full.db` (override with `OUT`). The
OFF ingest is resumable (checkpointed every 5000 lines); `fdc_branded` is
skipped with a log line, not an error, when `FDC_BRANDED_DIR` isn't set.
