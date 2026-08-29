# PricePulse V2 — Phase 2 Gate 2 Validation Pass

This was a validation task, not a rebuild: audit the already-implemented
Offer/Price Quality gate against real (not just self-reported-passing)
behavior, and fix whatever's actually wrong. One real bug was found and
fixed. Everything else audited came back correct.

## 1. Files inspected

`comparison/offerQuality.js`, `comparison/offerEligibility.js`,
`comparison/offerRanker.js`, `comparison/compareEngine.js`,
`services/compareService.js`, `services/productMatcher.js`,
`comparison/productTypeClassifier.js`, `comparison/variantMatcher.js`,
`comparison/offerDeduplicator.js`, `comparison/offerExtractor.js`,
`utils/numbers.js`, `utils/text.js`, `tests/matching/offerQuality.test.js`,
`tests/matching/productIdentityConflict.test.js`,
`tests/matching/productTypeConflict.test.js`,
`scripts/regression-tests.js`, `scripts/run-live-tests.js`,
`scripts/replay-reported-live-data.js`, `.env.example`, `package.json`.

Traced the full execution path by hand against the actual source (not
filenames/docstrings): `compareByProduct`/`compareByQuery`
(`compareService.js`) → `runComparison` (`compareEngine.js`) →
`canonicalizeProduct` → `buildSearchQuery` → `queryActiveAdapters`
(`searchPlanner.js` + `candidateCollector.js`, Serper) →
`deduplicateByMerchant` → `scoreOffers` (`variantMatcher.js` →
`productMatcher.js`'s `computeMatchConfidence`, which runs Gate 0 then
Gate 1 then spec/token scoring internally) → `attemptSecondaryUrlResolution`
→ `attachQualityScores` → `attachOfferQuality` (Gate 2) →
`buildComparison` (`offerRanker.js`, using `offerEligibility.js`) →
`toFrontendOffer` (`compareService.js`).

## 2. Files changed

- **`comparison/offerQuality.js`** — the one real fix (§3 below).
- **`tests/matching/offerQuality.test.js`** — 5 new tests: 2 that
  reproduce the bug directly, 2 controls proving the real signals still
  fire correctly after the fix, and 1 full Phase-10 combined-fixture
  end-to-end test (legit + suspicious + wrong-generation + wrong-type
  offers all in one comparison, proving Gate 0/1/2 compose correctly
  together, not just individually).

**Nothing else changed.** Gate 0 (`productTypeClassifier.js`), Gate 1
(`productMatcher.js`'s identity gates), `offerEligibility.js`,
`offerRanker.js`, `compareEngine.js`'s gate order, and `compareService.js`
were all audited line-by-line against the spec's Phase 2–7 requirements
and found correct — see §3 for exactly what was checked and how.

## 3. Exact bug found

**`comparison/offerQuality.js`'s keyword matching had no word-boundary
check** — `CONDITION_SIGNAL_WORDS`/`INSTALLMENT_SIGNAL_WORDS` were matched
with a bare `normalizedTitle.includes(word)`, not a `\b`-bounded regex.

Concretely, before the fix:

```js
> evaluateOfferQuality({ title: "Samsung Galaxy S26 Ultra 256GB Premium Edition", price: 120000 }, [...])
{ status: "suspicious", reasons: ["installment_or_partial_price"], usableForBestOffer: false }
```

`"emi"` is a substring of `"Premium"` (pr-**emi**-um) — an extremely
common, completely legitimate listing word ("Premium Quality", "Premium
Edition", "Premium Build") — so any listing using it was wrongly flagged
as an EMI/installment price and excluded from `bestOffer` eligibility.
Same bug, same mechanism, for `"used"` inside `"Unused"` (`un-used`) via
`used_or_refurbished`.

This is exactly the failure mode the task asked me to hunt for: it's
invisible to every existing deterministic test (none of them happen to
use the word "Premium" or "Unused" in a title), passes 100% of the
existing suite, and would have silently excluded a real, possibly
*cheapest*, offer from ever becoming `bestOffer` in production — directly
violating Phase 14's "Do not hard-reject legitimate products merely
because their price differs" in spirit (here: because of an unrelated
adjective in the title, not even the price).

I found it by directly adversarially testing the two keyword lists rather
than trusting that "the tests pass" meant the lists were safe — see the
raw repro:

```
$ node -e "... evaluateOfferQuality({title:'... Premium Edition', price:120000}, ...) ..."
Samsung Galaxy S26 Ultra 256GB Premium Edition -> {"status":"suspicious","score":0.6,"reasons":["installment_or_partial_price"],"usableForBestOffer":false}
Samsung Galaxy S26 Ultra 256GB Unused Box Opened -> {"status":"suspicious","score":0.7,"reasons":["used_or_refurbished"],"usableForBestOffer":false}
```

### Everything else audited (Phases 2–7) came back correct — specifics:

- **Gate order** (Phase 2): confirmed by reading `compareEngine.js` top
  to bottom — `scoreOffers` (Gate 0+1+spec scoring) runs, THEN
  `attachOfferQuality` (Gate 2), THEN `buildComparison` (eligibility +
  ranking). Not asserted from a comment — read the actual call sequence.
- **Price cluster exclusions** (Phase 2/4): `attachOfferQuality` builds
  its cluster from `scoredOffers.filter(o => !o.hardReject && typeof
  o.price === "number" && o.price > 0)` — hard-rejected and unpriced
  offers are excluded by construction, and `assessPriceOutlier` further
  excludes the candidate itself (`o !== offer`) from its own reference
  median. Verified directly with the Phase 10 fixture (§10) — S25/S21
  Ultra/A56/motherboard prices (₹70k/₹35k/₹25k/₹10k) do not shift
  desertcart's outlier classification at all.
- **Status logic** (Phase 3): confirmed `status` is derived purely from
  `reasons.length` (0 → trusted, else → suspicious), never from `score`
  directly; `invalid` is a separate, earlier return path gated only on
  missing/non-positive price or missing/empty title. Matches the spec's
  exact required 3-way split.
- **Outlier thresholds** (Phase 4): confirmed the exact formula —
  `ratio < 0.3` → extreme (with ≥3 other priced offers), `0.3 ≤ ratio <
  0.5` → mild, `ratio ≥ 0.5` → no signal; with 1–2 other offers, `ratio <
  0.3` → the low-confidence variant, nothing else. Matches the spec's
  Phase 4 pseudocode exactly, including strict `<` at the boundaries.
- **Title check** (Phase 5): confirmed it runs on the **raw**, pre-
  `normalizeTitle()` token shape (fraction of whitespace-split tokens
  with no letter/digit at all, ≥30% → malformed), and confirmed directly
  that `"PS5 Pro"`, `"iPhone 16 Pro Max"`, `"Samsung Galaxy S26 Ultra"`,
  and `"RTX 5070 Ti"` all correctly score 0% symbol-ratio (not malformed)
  while `"Samsung Galaxy S26 Ultra & && ()"` scores 43% (3 of 7 raw
  tokens are pure symbols) — correctly malformed.
- **`isEligibleForComparison`** (Phase 6): confirmed all 6 required
  clauses are present verbatim, including `usableForBestOffer !== false`,
  and confirmed a suspicious offer is excluded from `bestOffer`/
  `bestDirectOffer`/`savings` but stays in `results`/`possibleMatches`
  (`isEligibleForResults` only checks `hardReject`, untouched).
- **Ranking/bookkeeping** (Phase 7): confirmed `offerRanker.js` classifies
  confident vs. possible using `matchConfidence >= BEST_OFFER_MATCH_THRESHOLD`
  (0.75) — the same canonical bar `matchDecision`/`matchTier` already use
  elsewhere — not a second, independently-drifted threshold; confirmed
  `attachOfferQuality` never touches `matchConfidence`/`matchDecision`/
  `hardReject`, so Gate 2 genuinely cannot turn a legitimate match into an
  identity rejection.
- **Env flags** (Phase 13): see §7/§8 below — traced, not assumed.

## 4. Exact fix made

`comparison/offerQuality.js` — split each keyword list into a
`\b`-bounded "words" bucket (single words prone to substring
false-positives: `emi`, `used`, `refurbished`, `renewed`, `installment`,
`installments`, `subscription`) and a plain-substring "phrases" bucket
(multi-word/symbol phrases with no realistic false-positive risk at that
length: `per month`, `/month`, `down payment`, `open box`, `pre-owned`,
`second hand`, `starting from`, `from rs`, ...). `findKeywordSignal` now
checks the words bucket with `new RegExp(\`\\b${w}\\b\`, "i")` before
falling back to substring checks on the phrases bucket. No signal names,
weights, or thresholds changed — only how a word is matched.

```
Before: "Premium Edition"  -> installment_or_partial_price (FALSE POSITIVE)
        "Unused Box Opened" -> used_or_refurbished (FALSE POSITIVE)
After:  "Premium Edition"  -> trusted
        "Unused Box Opened" -> trusted
        "(Refurbished)"     -> used_or_refurbished (still correctly fires)
        "EMI ... /month"    -> installment_or_partial_price (still correctly fires)
```

## 5. Test results

| Suite | Result |
|---|---|
| `tests/matching/productTypeConflict.test.js` (Gate 0) | 51/51 |
| `tests/matching/productIdentityConflict.test.js` (Gate 1) | 38/38 |
| `tests/matching/offerQuality.test.js` (Gate 2) | **20/20** (15 existing + 5 new) |
| `tests/comparison/searchPlanner.test.js` | 6/6 |
| `tests/urls/urlRecognition.test.js` | 11/11 |
| `scripts/regression-tests.js` | 32/32 |
| `scripts/regression-dedup-test.js` | PASS |
| `scripts/replay-reported-live-data.js` | PASS |

**158/158 automated tests pass. Zero existing tests modified** (no
conflict with the new fix was found — the word-boundary fix is strictly
more correct, and nothing in the existing suite depended on the buggy
substring behavior).

Note on "`npm test`" (Phase 11): the repo's `package.json` has
`"test": "echo \"Error: no test specified\" && exit 1"` — there is no
single aggregate test command wired up; the actual, real test mechanism
is running each file in `tests/`/`scripts/` individually with `node`, as
done above and in every prior report for this codebase.

## 6. Real live-test result

**Ran `npm install`** (network access to `registry.npmjs.org` worked;
122 packages installed) and **re-tested network reachability directly**:
`https://api.serper.dev` is in fact reachable from this sandbox (a raw
HTTPS request returns `403`, Serper's standard "missing/invalid API key"
response — not a network-level block). This corrects what my two prior
reports for this project said about network access; I verified it fresh
this time rather than repeating the earlier claim.

However: **no `.env` file and no `SERPER_API_KEY` exist anywhere in this
environment** (checked `find / -iname .env`, `env | grep -i serper`, both
empty). Running the actual command:

```
$ node scripts/run-live-tests.js query "Samsung Galaxy S26 Ultra 12GB 256GB"
◇ injected env (0) from .env
Running compareByQuery("Samsung Galaxy S26 Ultra 12GB 256GB") against the REAL Serper API...
[COMPARE] Store: google_shopping status: unavailable (SERPER_API_KEY is not configured.)
--- THREW ---
message: Couldn't reach the price comparison service right now. Please try again in a moment.
statusCode: 502
```

This is a clean, honest diagnosis: the code runs correctly and fails for
exactly the right, expected reason (no credential) — not a network
problem, not a code bug. Per Phase 12's explicit instruction ("Do NOT
claim a live result unless this command actually succeeds"), **I am not
claiming a live result** — genuine Serper validation requires the actual
API key, which only the project owner has.

In its place, the offline **Phase 10 test** (`tests/matching/offerQuality.test.js`)
replays the exact reported live scenario — same merchant names, same
malformed desertcart title/price, same wrong-generation/wrong-type noise
(S25/S21 Ultra, A56, motherboard) — through the real, unmodified
`compareService.js`/`compareEngine.js`:

```
[COMPARE] Matched: desertcart -> "Samsung Galaxy S26 Ultra & && ()" confidence=1 (exact)
[COMPARE] Matched: OldStore1 -> "Samsung Galaxy S25 Ultra" confidence=0 (low) — GENERATION_MISMATCH
[COMPARE] Matched: Cellspare -> "Samsung Galaxy S26 Ultra Motherboard" confidence=0 (low) — PRODUCT_TYPE_CONFLICT
[COMPARE] REJECTED (identity conflict): 4
[COMPARE] OFFER QUALITY:
  Merchant: desertcart
  Price: INR 5389
  Decision: SUSPICIOUS
  Usable for best offer: false
  Reasons: MALFORMED_TITLE, EXTREME_PRICE_OUTLIER
[COMPARE] Best offer: MRV electronics INR 94999

results: [Amazon ₹117600 trusted, Flipkart ₹124999 trusted, desertcart ₹5389 suspicious/NOT usable,
          MRV electronics ₹94999 trusted, myG ₹124999 trusted]
bestOffer: MRV electronics ₹94999
bestDirectOffer: MRV electronics ₹94999
savings: 30000
```

Whoever has the real `.env`/API key should still run the exact live
command to confirm against the current actual Serper response:
```
node scripts/run-live-tests.js query "Samsung Galaxy S26 Ultra 12GB 256GB"
```

## 7. `COMPARISON_ENGINE_V2` — actual behavior (traced, not assumed)

Read every reference in the codebase (`compareEngine.js`,
`searchPlanner.js`, `candidateCollector.js`, plus every test file that
sets/unsets it). Its **entire** effect:

```js
// compareEngine.js
function isV2Enabled() {
    return (process.env.COMPARISON_ENGINE_V2 || "").trim().toLowerCase() === "true";
}
async function queryActiveAdapters(canonicalProduct, query) {
    const multiQuery = isV2Enabled();
    const queries = multiQuery ? planQueries(canonicalProduct, { multiQuery: true }) : [query];
    ...
}
```

It controls **only** whether `searchPlanner.js` fans out to up to
`MAX_QUERIES` (default 3) targeted Serper queries instead of one, and
whether `candidateCollector.js` uses its result cache. **It does not gate
Gate 0, Gate 1, or Gate 2 in any way** — `scoreOffers`
(Gate 0+1+scoring), `attachOfferQuality` (Gate 2), and `buildComparison`
(eligibility+ranking) all run unconditionally on every request regardless
of this flag's value. It isn't even present in `.env.example`, so it's
unset (`false`) by default in every environment unless someone explicitly
adds it.

**Conclusion**: the live test I could not run would have exercised Gate
0/1/2 fully either way — this flag has zero bearing on whether the new
gates run. Per the task's own instruction ("If the new pipeline works
regardless of this flag, leave it unchanged"), it was left untouched.

## 8. `ENABLE_MERCHANT_URL_RESOLVER` — actual behavior (traced, not assumed)

```js
// urlResolver.js
function isEnabled() {
    return (process.env.ENABLE_MERCHANT_URL_RESOLVER || "").trim().toLowerCase() === "true";
}
// compareEngine.js
async function attemptSecondaryUrlResolution(scoredOffers, ...) {
    if (!isMerchantResolverEnabled()) return;
    ... // upgrade up to 5 Google-redirect URLs to real merchant URLs, via a bounded secondary Serper web-search
}
```

Default `false` (confirmed in `.env.example`). Controls only whether the
engine attempts to upgrade a `google.com/search?ibp=oshop` redirect URL
into a real merchant page URL for up to 5 of the highest-confidence
Google-redirect offers — this affects `productUrl`/`_isGoogleRedirectUrl`,
which in turn affects `bestDirectOffer` (which requires a non-redirect
URL) but **has no bearing on Gate 0/1/2 identity or quality decisions**
at all. Left unchanged, per the same instruction as §7.

## 9. Final bestOffer (Phase 10 fixture, offline — see §6 for why not live)

**MRV electronics @ ₹94,999** — the cheapest offer that is simultaneously
Gate-0-valid, Gate-1-valid, and Gate-2-`trusted`.

## 10. Final savings

**₹30,000** (₹1,24,999 − ₹94,999, across the 4 trusted offers:
Amazon/Flipkart/MRV/myG). Confirmed **not** ₹1,34,610 (what desertcart's
₹5,389 would have produced) and **not** inflated by the wrong-generation
S25/S21 Ultra or wrong-type motherboard prices, which never entered the
eligible pool at all.

## 11. Are suspicious offers still visible?

**Yes.** desertcart appears in `result.results` with
`offerQuality: "suspicious"`, full `offerQualityReasons`, and
`usableForBestOffer: false` — never hidden, never silently dropped. This
was true before this validation pass and remains true after the fix
(the fix only changed *which* offers correctly get flagged, not
*whether* flagged offers stay visible).

## 12. Are wrong-generation products still excluded?

**Yes**, confirmed directly in the Phase 10 fixture: S25 Ultra (₹70,000),
S21 Ultra (₹35,000), A56 (₹25,000, wrong family), and the motherboard
(₹10,000, wrong type) are all fully absent from `result.results` —
`GENERATION_MISMATCH`/`PRODUCT_TYPE_CONFLICT` hard rejections, exactly as
Gate 1/Gate 0 were designed before this task and left untouched.

## 13. Remaining limitations

- The genuine live Serper API call could not be performed in this
  environment — no credential is available (see §6). This is a hard
  environment limitation, not a code limitation; the offline Phase 10
  replay is the closest available substitute and uses the exact reported
  merchant names/titles/prices.
- The keyword-boundary fix (§3/§4) closes the specific false-positive
  found (`emi`⊂`premium`, `used`⊂`unused`) but the word lists themselves
  are still necessarily finite (spec §8's "do not create a giant keyword
  dictionary" constraint) — a differently-worded condition/installment
  phrase not on the list still won't be caught. The fix makes matching
  *correct* for the words that are listed; it doesn't make the list
  exhaustive, which was never the goal.
- As noted in the prior report, `offerExtractor.js` backs a missing
  Serper title with the source product's own search query
  (`title: item.title || fallbackTitle`) — this is pre-existing V1
  behavior unrelated to Gate 2, but it does mean a genuinely blank-titled
  Serper item would never trigger `malformed_title` (it'd inherit a
  clean fallback title instead). The `extreme_price_outlier` signal still
  independently protects against exactly this shape of bad offer, so this
  is noted as a limitation, not a live vulnerability.
