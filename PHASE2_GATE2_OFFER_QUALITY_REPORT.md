# PricePulse V2 — Phase 2 Precision Fix (Gate 2: Offer / Price Quality)

## A. Files changed

**New:**
- `comparison/offerQuality.js` — the new gate itself: `evaluateOfferQuality`,
  `attachOfferQuality`, plus the two exported sub-checks
  (`assessTitleQuality`, `assessPriceOutlier`) for direct testability.
- `tests/matching/offerQuality.test.js` — 15 new deterministic tests
  (the spec's TEST 1–13, plus a §15 bookkeeping regression test and one
  extra hardReject-passthrough test).

**Modified:**
- `comparison/offerEligibility.js` — `isEligibleForComparison` (the
  bestOffer/bestDirectOffer gate) now also requires
  `offer.usableForBestOffer !== false`. `isEligibleForResults` (the
  results/possibleMatches gate) is **untouched** — a suspicious/invalid
  offer still shows up there, exactly as spec section 3 requires.
- `comparison/compareEngine.js` — calls `attachOfferQuality` right after
  the existing `attachQualityScores` step, before `buildComparison`; adds
  the `[COMPARE] OFFER QUALITY: ...` log block for flagged offers only.
  Existing Gate 0/1 rejection logging is unchanged.
- `comparison/offerRanker.js` — the confident/possible split (§15 fix,
  see below). No change to bestOffer/savings/rejectedOffers logic itself
  — `isEligibleForComparison` already owns that, and it was updated in
  `offerEligibility.js` above.
- `services/compareService.js` — `toFrontendOffer` now also exposes
  `offerQuality`, `offerQualityScore`, `offerQualityReasons`,
  `usableForBestOffer`. No existing field removed or renamed.

**Gate 0 and Gate 1 were not touched** — `productTypeClassifier.js`,
`productMatcher.js`'s `evaluateProductIdentity`/`evaluateVariantIdentity`,
and their call order are exactly as the prior Phase 2 fix left them.

## B. New architecture

```
Candidate
   ↓
Gate 0: Product Type            (unchanged)
   ↓
Gate 1: Product Identity        (unchanged)
   ↓
Gate 2/3: Specifications        (unchanged — storage/RAM/color soft demotion)
   ↓
Gate 4: Existing token scoring  (unchanged)
   ↓
NEW: Offer / Price Quality      (comparison/offerQuality.js)
   ↓
Eligibility                     (offerEligibility.js — now checks BOTH
                                  hardReject AND usableForBestOffer)
   ↓
Ranking / Best Offer / Savings  (offerRanker.js — unchanged selection
                                  logic, now fed a pool that has already
                                  excluded untrustworthy prices)
```

`attachOfferQuality` runs once per comparison, over the full
already-Gate-0/1-scored offer list:

1. Build the price cluster from every `hardReject: false`, priced offer
   in the batch (this is what makes it category-agnostic and immune to
   raw-Serper noise — wrong-generation/wrong-type offers are already gone
   by this point, spec section 6).
2. For each non-hard-rejected offer, evaluate three independent signal
   groups (title quality, condition/pricing keywords, price-vs-cluster
   ratio) and combine them into `{ status, score, reasons,
   usableForBestOffer }`.
3. Hard-rejected offers are passed straight through, untouched — no
   `offerQuality` field at all, since they're already fully excluded
   upstream and evaluating them would be wasted, meaningless work.

`isEligibleForComparison` (the bestOffer/bestDirectOffer gate) now reads
`usableForBestOffer` alongside its existing checks. `isEligibleForResults`
(the broader results/possibleMatches gate) is untouched, so a suspicious
offer stays fully visible — never silently dropped, per spec section 3.

## C. Offer-quality signals implemented

| Signal | Trigger | Weight | Note |
|---|---|---|---|
| `malformed_title` | ≥30% of raw whitespace-split title tokens contain **no** letter/digit at all (e.g. `&`, `&&`, `()`) — checked on the **raw** title, since `normalizeTitle()` would silently strip exactly this garbage | −0.35 | Not "short titles" (spec §7) — a short-but-meaningful title like "PS5 Pro" is fine |
| `used_or_refurbished` | title contains a condition keyword (`refurbished`, `renewed`, `open box`, `used`, `pre-owned`, ...) | −0.30 | Small, reused list — deliberately does **not** duplicate Gate 0's accessory/part words (those already hard-reject before this stage even runs) |
| `installment_or_partial_price` | title contains an EMI/partial-price keyword (`emi`, `/month`, `installment`, `down payment`, `starting from`, ...) | −0.40 | Checked against both normalized and raw-lowercase title, since `₹`/`/` get stripped by normalization |
| `extreme_price_outlier` | price < 0.3× the median of the **other** identity-valid priced offers, **with ≥3 other data points** | −0.60 | Statistical-support guard — see TEST 5/6 |
| `price_below_cluster` | price in [0.3×, 0.5×) median, **with ≥3 other data points** | −0.25 | A genuine 30–40% discount (ratio ≥0.5) never fires this — TEST 4 |
| `price_below_cluster_low_confidence` | price < 0.3× the only 1–2 other data points available | −0.15 | Downgrade, not a hard signal, when there isn't enough evidence — spec §6 |

`status` is decided from the discrete reason list, not a single opaque
score cutoff (spec §4's "do not use a simplistic rule" applies to the
whole decision):
- **`invalid`** — no usable price (`null`/`≤0`) or no usable title at all.
  Nothing else about the offer matters at that point.
- **`suspicious`** — has a real price and title, but ≥1 signal fired.
  This is exactly where the desertcart ₹5,389 case lands (`status:
  "suspicious"`, matching the spec's own worked example — not `"invalid"`,
  since it does have a parseable price/title).
- **`trusted`** — no signals fired.

`score` is still computed and exposed (`0..1`) for diagnostics/logging,
but never used as the sole basis for the status decision.

## D. Exact bestOffer eligibility rules

`isEligibleForComparison` (unchanged structure, one clause added):

```js
function isEligibleForComparison(offer) {
    return (
        !offer.hardReject &&
        offer.matchConfidence >= BEST_OFFER_MATCH_THRESHOLD &&   // 0.75
        offer.price !== null &&
        offer.availability !== "out_of_stock" &&
        !!offer.productUrl &&
        offer.usableForBestOffer !== false                        // NEW
    );
}
```

`usableForBestOffer` is `true` only when `offerQuality.status ===
"trusted"`. This applies identically to `bestOffer` and `bestDirectOffer`
(both are built from `eligibleForBest`/`eligibleForDirectBest`, which
both derive from `isEligibleForComparison` — unchanged in
`offerRanker.js`), and to `savings` (computed only from
`eligibleForBest`, so an excluded offer's price never enters the
max/min calculation).

## E. Tests before / after

| Suite | Before this task | After |
|---|---|---|
| `tests/matching/productTypeConflict.test.js` (Gate 0) | 51/51 | 51/51 (unchanged) |
| `tests/matching/productIdentityConflict.test.js` (Gate 1) | 38/38 | 38/38 (unchanged) |
| `tests/comparison/searchPlanner.test.js` | 6/6 | 6/6 (unchanged) |
| `tests/urls/urlRecognition.test.js` | 11/11 | 11/11 (unchanged) |
| `scripts/regression-tests.js` | 32/32 | 32/32 (**unchanged — 0 tests modified**) |
| `scripts/regression-dedup-test.js` | PASS | PASS (unchanged) |
| `tests/matching/offerQuality.test.js` (**new**, Gate 2) | — | **15/15** |

**Total: 138/138 pre-existing tests still pass, byte-for-byte
unmodified; 15 new tests added, all passing. 153/153 overall.**

## F. Intentionally updated tests — none this time

Unlike the Gate 1 task, **no existing test needed to change**. The one
place that looked like a conflict — `scripts/regression-tests.js` TEST AF
(`buildComparison` called directly with hand-built offer objects that
don't set `matchDecision`) — is why the §15 bookkeeping fix was
implemented as "compare `matchConfidence` against the same
`BEST_OFFER_MATCH_THRESHOLD` (0.75) every other part of the codebase
already treats as the canonical 'confident/strong' bar" rather than as
"switch to reading the `matchDecision` string field". Both approaches
fix the JioMart/Hariom bug identically (see the passing bookkeeping
regression test in §H below); the threshold-based version additionally
doesn't require every direct/hand-built `scoredOffers` fixture in the
codebase to also populate `matchDecision`, so TEST AF needed no change
at all. This is the smaller, more conservative fix of the two.

## G. Live-test result

Same limitation as the prior Gate 0/Gate 1 reports: this sandbox has no
`node_modules` and no route to `serper.dev` — confirmed again this run:

```
$ node scripts/run-live-tests.js query "Samsung Galaxy S26 Ultra 12GB 256GB"
Error: Cannot find module 'dotenv'
```

Per the spec's explicit instruction ("If live API access is unavailable,
do NOT fake a live result. Use deterministic fixtures and clearly report
that live validation could not be performed"), **no live result is
claimed**. In its place, TEST 13 in `tests/matching/offerQuality.test.js`
replays the exact reported live data — same merchant names, same
malformed desertcart title, same ₹5,389 price, same legitimate price
band (₹94,999–₹1,24,999) — through the real, unmodified
`compareService.js`/`compareEngine.js`, with no shortcuts:

```
[COMPARE] CONFIDENT MATCHES: 5 (Amazon, Flipkart, JioMart, desertcart, MRV electronics)
[COMPARE] OFFER QUALITY:
  Merchant: desertcart
  Candidate: Samsung Galaxy S26 Ultra & && ()
  Price: INR 5389
  Decision: SUSPICIOUS
  Usable for best offer: false
  Reasons: MALFORMED_TITLE, EXTREME_PRICE_OUTLIER
[COMPARE] Best offer: MRV electronics INR 94999
```

Someone with `.env`/network access should still re-run the real live
command to confirm against the actual current Serper response, per the
spec's checklist:
```
node scripts/run-live-tests.js query "Samsung Galaxy S26 Ultra 12GB 256GB"
```

## H. Known limitations

- The price-outlier thresholds (0.3×/0.5× median, 3-offer statistical
  floor) are reasonable, conservative defaults chosen to satisfy the
  spec's own test matrix (a 36% discount must pass, a 96% "discount"
  must not) — not empirically tuned against a large real-world price
  distribution. A production rollout would likely want to revisit these
  once real `offerQuality` logs accumulate.
- `installment_or_partial_price`/`used_or_refurbished` are small,
  deliberately-scoped keyword lists (spec §8's "do not hardcode a giant
  lookup table"), not a generalized NLP classifier — a differently-worded
  EMI phrase not in the list won't be caught. Same trade-off Gate 0's own
  accessory list already made.
- `offerQuality` is computed once per comparison, from the batch of
  offers already collected for that single query — it has no memory
  across separate comparisons/requests, so it can't (and isn't meant to)
  catch a merchant that's suspicious across many different products,
  only a price that looks wrong relative to its own comparison batch.
- As in the prior two reports, live Serper validation could not be
  performed in this sandbox (§G) — the offline TEST 13 replay is the
  closest available substitute, using the exact reported data.

## I. The ₹5,389 desertcart offer, end to end (proof, not a claim)

Fixture: identical to the real reported query — 4 legitimate S26 Ultra
listings (₹94,999–₹1,24,999) plus the exact desertcart listing
(`"Samsung Galaxy S26 Ultra & && ()"`, ₹5,389).

**Before this task** (Gate 0/1 only): desertcart passes both — real
smartphone, correct model/generation/variant — `matchConfidence: 1`,
`EXACT_MATCH`. Nothing stops it from winning bestOffer purely on price.

**After this task**, running the real pipeline end-to-end:

```
desertcart: price=5389 matchConfidence=1
            offerQuality=suspicious
            reasons=["malformed_title","extreme_price_outlier"]
            usableForBestOffer=false

bestOffer: MRV electronics ₹94999
savings: 30000
```

- desertcart is **still visible** in `result.results` (confidence 1,
  genuinely a correct product identity match — that part of the pipeline
  was never wrong) — it is not hidden or silently dropped, per spec §3.
- Its `offerQuality` is `"suspicious"` with both real reasons named.
- `usableForBestOffer: false` — it is excluded from `bestOffer`,
  `bestDirectOffer`, and the `savings` calculation.
- `bestOffer` correctly lands on **MRV electronics @ ₹94,999** — the
  cheapest *trusted* offer.
- `savings` is **₹30,000** (₹1,24,999 − ₹94,999, across the 4 trusted
  offers) — not the ₹1,34,610 the ₹5,389 price would have produced.
