# PricePulse V2 — Product-Type Conflict Fix

## 1. Root cause of the Cellspare false positive

The matcher (`services/productMatcher.js`'s `computeMatchConfidence`) only
ever scored **token overlap + brand/model/variant text matching**. It had
no concept of "is this candidate even the same KIND of thing as the
request" — it went straight from tokens to a confidence score. Because
`"Samsung Galaxy S26 Ultra 256GB 12GB RAM Motherboard PCB"` contains
nearly every token of the requested phone (`Samsung`, `Galaxy`, `S26`,
`Ultra`, `256GB`, `12GB`, `RAM`), it scored:

- title-token overlap: very high
- brand match: +0.15
- model match: +0.25
- storage match (256GB): +0.1
- RAM match (12GB): +0.05
- no generation/variant-suffix contradiction (still says "S26 Ultra")

…and clipped to `confidence = 1.0`. The only existing accessory
protection (`looksLikeAccessory` in `utils/text.js`) checked a short,
phone-accessory-flavored word list (`case`, `cover`, `charger`, `cable`,
…) that did **not** include `motherboard`, `pcb`, `mainboard`, or any
other replacement-part vocabulary, and even where it did match, it was
only a **soft −0.6 penalty** — easily outweighed by the token-overlap
score above. Product identity (a phone) and product type (a spare part
for a phone) were never distinguished from each other; matching was
"tokens matched → high score → cheapest wins," exactly the anti-pattern
described in the request's Step 7.

## 2. Files changed

**New:**
- `comparison/productTypeClassifier.js` — the classification layer
- `comparison/offerEligibility.js` — the single "can this offer even
  participate" gate + the two confidence thresholds (moved out of
  `offerRanker.js` so both modules share one definition)
- `tests/matching/productTypeConflict.test.js` — 25 new deterministic tests

**Modified:**
- `services/productMatcher.js` — new Gate 0 (`evaluateProductIdentity`)
  runs before any token scoring; new `getMatchDecision()`;
  `computeMatchConfidence` now also returns `hardReject`,
  `matchDecision`, `requestedType`, `candidateType`
- `comparison/variantMatcher.js` — propagates the new fields onto every
  scored offer (`hardReject`, `matchDecision`, `requestedProductType`,
  `candidateProductType`)
- `comparison/offerRanker.js` — filters out `hardReject` offers *before*
  the confident/possible split; imports thresholds from
  `offerEligibility.js` instead of defining them locally; `buildComparison`
  now also returns `rejectedOffers` (for logging)
- `comparison/compareEngine.js` — logs every rejected offer (spec Step 17
  format: merchant/title/reason/requested type/candidate type — never
  logs secrets); passes `rejectedOffers` through
- `services/compareService.js` — exposes two new **additive** frontend
  fields, `productType` and `matchDecision`

**Untouched:** `providers/serper/*`, `searchPlanner.js`,
`candidateCollector.js`, `productIdentity.js`, `productNormalizer.js`,
`offerExtractor.js`, `urlResolver.js`, `merchantRegistry.js`,
`offerDeduplicator.js`, `qualityScorer.js`, `services/stores/*`,
`routes/*`, all frontend (`js/*`, `index.html`), `AI Find`
(`vision.js`/`imageSearch.js`), `.env`.

## 3. New matching architecture

```
Product Type            ← NEW: classifyProductType() + detectProductTypeConflict()
   ↓                       (Gate 0 — runs first, can short-circuit to confidence=0)
Brand
   ↓
Model
   ↓
Generation                 (unchanged — existing letter+digit token guard)
   ↓
Variant                    (unchanged — existing suffix-word guard: Pro/Ultra/Plus/…)
   ↓
Attributes                 (unchanged — RAM-aware storage/RAM/color scoring)
   ↓
Offer Eligibility        ← NEW: isEligibleForResults() / isEligibleForComparison()
   ↓
Ranking / bestOffer        (unchanged — tier → direct-URL → price)
```

`comparison/productTypeClassifier.js` is deterministic and rule-based (no
external/AI call, per the request's explicit instruction). It has two
signal tables:

- **`PART_TYPE_SIGNALS`** — phrases that mean "this listing is an
  accessory / replacement part / component," grouped into
  `replacement_part` (motherboard, PCB, LCD panel, battery replacement,
  flex cable, …), `accessory` (case, charger, screen protector, ear pads,
  heatsink, controller, water block, …), and `component`.
- **`PRODUCT_CATEGORY_SIGNALS`** — ~19 whole-product categories from the
  request's Step 2 list (smartphone, tablet, laptop, desktop, monitor,
  television, headphones, earbuds, smartwatch, camera, gaming_console,
  graphics_card, cpu, ssd, hdd, ram, printer, appliance), each with a
  broad, multi-brand keyword set (not just Samsung — e.g. smartphone
  covers `iphone`, `galaxy s/a/m/z/note`, `pixel`, `oneplus`, `redmi`,
  `poco`, `realme`, `moto`, `xperia`, `nothing phone`).

Part signals are checked **before** category signals, so a title that
matches both (`"...Galaxy S26 Ultra... Motherboard PCB"`) classifies as
`replacement_part`, not `smartphone` — this is the actual fix.

## 4. How product-type conflicts work

`detectProductTypeConflict(requestedClass, candidateClass)` uses what I
call the **asymmetric part rule**:

> If the candidate is a part/accessory/component, it conflicts with the
> request **unless the request was explicitly for that same kind of
> part**. This does NOT require the requested type's main category to be
> confidently known.

That last clause matters: `"Samsung 990 Pro 2TB"` has no literal `ssd`/
`nvme` word, so its *requested* type classifies as `unknown` — but a
candidate `"Samsung 990 Pro Heatsink"` must still be rejected. Requiring
a confidently-known main category before rejecting a part would silently
defeat the whole feature for any product line not in the (necessarily
incomplete) keyword tables. Only symmetry — the request itself also being
for that same part type (`"Samsung Galaxy S26 Ultra Motherboard"`
searched on purpose) — grants an exception, exactly per Step 4's
instruction that "if the user searches for a motherboard, motherboard is
a positive signal."

A secondary, weaker rule also flags a conflict when both sides classify
into different **known main** categories (e.g. requested smartphone,
candidate tablet) — general cross-category protection, though it wasn't
what the reported bug needed.

`HARD_REJECT` (spec Step 8) is reserved **only** for product-type
conflicts. Wrong generation/model/variant/storage (Steps 6/14 Tests 4–6)
keep their existing, already-tested soft-demotion behavior (confidence
capped low, landing in the "possible match" bucket) rather than being
excluded outright — this was a deliberate choice: the repo's own Test J
(`scripts/regression-tests.js`) requires a wrong-generation candidate
(`"Galaxy S26"` when `"Galaxy S26 Ultra"` was requested) to remain
visible as a possible match with `matchIssue: "variant_mismatch"`, and
the request's own Test 6 explicitly allows a 512GB-vs-256GB mismatch to
stay as a "possible/variant mismatch" rather than being hard-rejected.
Making every variant mismatch a hard reject would have broken that
already-passing, already-specified behavior.

## 5. How variant matching works

Unchanged — this fix adds a gate *before* variant matching, it doesn't
change variant matching itself. Storage/RAM extraction is still
RAM-aware (`"12GB RAM, 256GB Storage"` never confuses the two figures),
generation/variant-suffix guards are still hard ceilings (not
subtractive penalties that can wash out), and RAM mismatches are still
demoted-not-rejected. See `services/productMatcher.js`.

## 6. How bestOffer eligibility was changed

`comparison/offerEligibility.js` is now the single source of truth for
two gates:

- `isEligibleForResults(offer)` — `!offer.hardReject`. A hard-rejected
  offer never enters `offers` or `possibleMatches` at all (both are
  filtered from a common `candidateOffers` pool in `offerRanker.js`'s
  `buildComparison`, computed *before* the confident/possible split).
- `isEligibleForComparison(offer)` — the existing bestOffer bar (strong
  confidence, real price, not out-of-stock, real URL), now with an
  explicit `!offer.hardReject` check documenting the guarantee (it was
  already implied since a hard-rejected offer's confidence is forced to
  0, but Step 9 asked for an explicit eligibility property).

## 7. Tests added

`tests/matching/productTypeConflict.test.js` — **25 tests**, fixture-based,
no network/API key required:
- The exact reported bug (Cellspare motherboard → hard-rejected, excluded
  from results, real Amazon listing becomes bestOffer, savings not
  inflated) — request's Test 1
- Tests 2, 3, 4, 5, 6, 7, 8, 9, 10 from the request, verbatim
- Six other product categories (iPhone 17 Pro, MacBook Air M4, Sony
  WH-1000XM6, PlayStation 5, RTX 5070, Samsung 990 Pro), each with one
  legitimate listing AND one accessory/component false positive — request
  Step 15
- Positive-signal asymmetry: searching for "Motherboard" on purpose is
  never rejected
- `classifyProductType`/`detectProductTypeConflict` unit tests

## 8. Existing tests passed/failed

**All 64 pre-existing tests still pass, unchanged, zero modifications to
their assertions:**
- `scripts/regression-tests.js`: **32/32**
- `scripts/regression-dedup-test.js`: **15/15**
- `tests/comparison/searchPlanner.test.js`: **6/6**
- `tests/urls/urlRecognition.test.js`: **11/11**

Plus the new suite:
- `tests/matching/productTypeConflict.test.js`: **25/25**

**Total: 89/89 passing.** I ran every suite after implementing the fix
(not just claimed it) — the full commands and their tail output are in
this conversation.

`node -c` syntax-checked `server.js`, `routes/compare.js`, and
`routes/compareText.js` — all clean.

## 9. Live test result

**I could not run `node scripts/run-live-tests.js` in this environment** —
this sandbox has no outbound network access to `google.serper.dev` and no
`backend/.env` file (I did not create, overwrite, or inspect its
contents, per Step 18). Per the request's own instruction ("If a task
would need... Do not claim success unless you actually ran the tests"), I
am stating this plainly rather than claiming a live result I didn't
produce.

What I *can* state with certainty, because it's covered by a passing
deterministic test using the **exact reported title and price**
(`tests/matching/productTypeConflict.test.js`, "TEST 1"): feeding
`compareByProduct()` a fixture containing precisely
`"Samsung Galaxy S26 Ultra 256GB 12GB RAM Motherboard PCB"` at ₹71,999
from `Cellspare`, alongside `"Samsung Galaxy S26 Ultra 5G"` at ₹124,999
from `Amazon.in`, now produces: Cellspare hard-rejected and absent from
`result.results`; Amazon selected as `bestOffer`; `savings` no longer
derived from the ₹71,999 figure. `run-live-tests.js` calls the exact same
`compareService.js`/`compareByProduct` code path, unmodified — so the
live run should reproduce this, but please run it yourself with your
real API key to confirm against live data (command below).

```bash
cd backend
node scripts/run-live-tests.js query "Samsung Galaxy S26 Ultra 12GB 256GB"
```

## 10. Is the Cellspare motherboard now rejected?

**Yes, confirmed by a passing automated test reproducing the exact
reported title, merchant, and price** — not yet confirmed against live
Serper data in this session (see §9).

## 11. Remaining known problems

- **Keyword-table coverage is inherently incomplete.** The classifier is
  rule-based, not a real product catalog — an obscure product line or an
  unusual accessory phrase not in the signal tables will classify as
  `unknown` and pass through (matches spec Step 3's explicit instruction
  that absence of a signal must not itself cause rejection, but it does
  mean coverage will need to grow over time as new false positives are
  found).
- **Word-boundary substring matching has some collision risk** on short,
  generic accessory words (`band`, `stand`, `dock`, `mount`) — e.g. a
  legitimately-named product containing one of these words in an
  unrelated sense could be misclassified as an accessory. This risk
  already existed in the pre-fix `ACCESSORY_WORDS` soft-penalty list; it's
  now a hard reject instead of a soft penalty for these specific words,
  per the request's explicit instruction. No such case surfaced in any of
  the 89 tests.
- **URL resolution is unchanged and still shows `bestDirectOffer: none`**
  in the reported live output (all Google Shopping redirects) — this is
  the pre-existing, separate, feature-flagged-off `merchantUrlResolver`
  behavior (Step 12), explicitly out of scope for this fix and untouched.
- **Image handling (`"image": ""`) is unchanged** — explicitly out of
  scope for this fix (Step 13) and untouched.
- **Live-API verification is still outstanding** (§9) — please run the
  live test with your real key before considering this fully verified in
  production.
