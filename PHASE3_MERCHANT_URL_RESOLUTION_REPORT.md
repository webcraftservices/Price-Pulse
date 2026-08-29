# PricePulse V2 — Phase 3: Merchant URL Resolution & Direct Buy Links

## 1. Files inspected

`services/compareService.js`, `comparison/compareEngine.js`,
`comparison/offerExtractor.js`, `comparison/offerRanker.js`,
`comparison/offerEligibility.js`, `comparison/urlResolver.js`,
`comparison/searchPlanner.js`, `comparison/candidateCollector.js`,
`comparison/qualityScorer.js`, `comparison/offerQuality.js`,
`services/stores/merchantUrlResolver.js`,
`providers/merchants/merchantRegistry.js`, `providers/serper/webSearch.js`,
`providers/serper/serperClient.js`, `utils/url.js`, `utils/numbers.js`,
`tests/urls/urlRecognition.test.js`, `scripts/regression-tests.js`
(TEST U–AF), `scripts/run-live-tests.js`,
`scripts/replay-reported-live-data.js`, `.env.example`.

### Audit findings (Phase 1) — answers before any code was touched

1. **Where Google Shopping URLs enter**: `comparison/offerExtractor.js`
   calls `resolveMerchantUrl(item)` (in `urlResolver.js`) per raw Serper
   Shopping item. Live evidence confirms Serper's `link` field is always
   a `google.com/search?ibp=oshop` redirect.
2. **How `productUrl` is assigned**: `resolveMerchantUrl` checks a
   defensive list of alternate fields (`ALT_URL_FIELDS`, none confirmed
   to exist in Serper's real schema) and nested seller objects first;
   falls back to `item.link` (the confirmed redirect) if nothing else.
3. **How Google redirects are detected**: `utils/url.js`'s `isGoogleHost`
   — regex against the hostname for `google.<tld>` and
   `googleusercontent.com`.
4. **`isGoogleRedirect`**: set at extraction time in `offerExtractor.js`
   from `resolveMerchantUrl`'s return value.
5. **`isDirectMerchantUrl`**: computed in `compareService.js`'s
   `toFrontendOffer` as `!!offer.productUrl && !offer._isGoogleRedirectUrl`.
6. **`urlConfidence`**: computed in `comparison/qualityScorer.js` — before
   this task, a flat binary (`direct: 100` / `redirect: 50` / `none: 0`).
7. **`bestDirectOffer`**: `offerRanker.js`'s `eligibleForDirectBest =
   eligibleForBest.filter(o => !o._isGoogleRedirectUrl)`, cheapest of that
   filtered set.
8. **`ENABLE_MERCHANT_URL_RESOLVER` gating**: see §7 below — traced fully,
   not assumed.
9. **Partial pre-existing resolution**: **yes** — a Part 2 (`comparison/
   urlResolver.js`'s `resolveDirectMerchantUrl`) already existed: bounded,
   cached, but **allowlist-only** — it could only ever attempt resolution
   for merchants in `merchantRegistry.js`'s small static domain table
   (Amazon, Flipkart, Croma, Reliance Digital, Vijay Sales, Myntra — 6
   domains). Critically, **"MRV electronics" — the actual current live
   bestOffer — is not in that table**, so the pre-existing resolver could
   never have resolved it under any configuration. This is the concrete
   gap this task's design change (§4) closes.
10. **Mechanism**: a scoped Serper **web search** (`site:domain query`),
    never a raw HTTP fetch/redirect-follow of the candidate URL itself —
    confirmed by reading `providers/serper/webSearch.js` end to end; the
    only outbound HTTP call anywhere in this path is to `api.serper.dev`
    (a fixed, non-attacker-controlled endpoint). This matters directly for
    §5 (SSRF): there is no code path that ever fetches an attacker-
    influenced destination URL.
11. **Max resolver requests**: previously a bare hardcoded
    `MAX_RESOLUTION_ATTEMPTS = 5` constant in `compareEngine.js`.
12. **Parallel or sequential**: `Promise.all(candidates.map(...))` —
    parallel, already bounded by the slice above.
13. **Timeout protection**: `providers/serper/webSearch.js` passes
    `timeoutMs: 6000` to the underlying Serper POST.
14. **Caching**: yes — an in-memory `Map` in `urlResolver.js`, previously
    keyed by `${domain}::${query}` (only worked when a domain was already
    known, i.e. only for allowlisted merchants).
15. **Failure isolation**: yes, already correct — a try/catch around the
    resolution call meant a failure never removed the offer or affected
    `matchConfidence`. Confirmed by TEST AE (`scripts/regression-tests.js`,
    pre-existing, still passing unmodified).

## 2. Files modified

- **`utils/url.js`** — added `isPrivateOrLocalHost`/`isSafeExternalUrl`
  (Phase 11 SSRF-safety primitives).
- **`comparison/urlResolver.js`** — added the MEDIUM-confidence dynamic
  discovery path, page-shape validation, merchant-name/hostname fuzzy
  verification, and the `{url, confidence}` detailed return shape (§3/§4).
- **`comparison/qualityScorer.js`** — `urlConfidenceFor` now reads the new
  `high`/`medium`/`low`/`none` confidence level when present, with the old
  binary logic kept as a fallback.
- **`comparison/offerExtractor.js`** — initializes the new
  `_urlConfidenceLevel`/`_urlResolutionStatus` diagnostic fields at
  extraction time.
- **`comparison/compareEngine.js`** — reordered the pipeline (Gate 2
  before URL resolution — see §8 "regression found"), rewrote the
  resolver's candidate-selection filter/sort per spec Phase 5, added the
  `MERCHANT_URL_RESOLVER_MAX_OFFERS` env knob.
- **`services/compareService.js`** — exposes the new
  `urlResolutionStatus` field; all pre-existing fields unchanged.
- **`.env.example`** — documented the new `MERCHANT_URL_RESOLVER_MAX_OFFERS`
  variable.

**New:**
- **`tests/urls/merchantUrlResolution.test.js`** — 22 deterministic tests
  (the spec's TEST 1–20, consolidating 4/18 and 8/17 which test the same
  mechanism, plus 2 extra tests proving the new MEDIUM-confidence path
  and SSRF-safety checks).

**Not touched**: Gate 0 (`productTypeClassifier.js`), Gate 1
(`productMatcher.js`'s identity gates), Gate 2 (`offerQuality.js`'s
signals/thresholds), `offerEligibility.js`'s `isEligibleForComparison`
logic itself (its existing 6 clauses already correctly gate
`bestDirectOffer` — see §8), `offerRanker.js`'s selection logic, savings
calculation, or `merchantRegistry.js`'s allowlist (kept exactly as the
HIGH-confidence tier).

## 3. Exact implementation

`comparison/urlResolver.js`'s `resolveDirectMerchantUrlDetailed` now tries
two strategies, in order, per offer:

**(a) HIGH confidence — allowlisted domain** (unchanged from before this
task, just relabeled): for the small pre-vetted `merchantRegistry.js`
domain set, a scoped `site:domain query` Serper search. The domain itself
is already trusted, so only relevance (Phase 9) and page-shape (Phase 7)
need checking.

**(b) MEDIUM confidence — dynamic discovery** (new): for every other
merchant — which in practice means most real merchants, including
"MRV electronics" — an unscoped `${merchantName} ${query}` Serper search,
with the resulting URL's hostname **independently fuzzy-verified** against
the merchant name (`merchantNameMatchesHostname`) before being trusted at
all. This is verification of what Serper's own search independently
found, never a guessed/assumed domain (Phase 18) — nothing is accepted
just because Serper returned *something*.

Both strategies apply the same three checks before accepting a candidate:
- `isSafeExternalUrl` (protocol + not-Google + not-private/local, Phase 11)
- `looksLikeGenericOrSearchPage` rejection (Phase 7)
- `matchValidator` relevance check, reusing the *exact same* Gate 1
  identity logic (`computeMatchConfidence`) the rest of the pipeline
  already uses — a wrong-generation candidate page is rejected by the
  URL resolver for the identical reason a wrong-generation offer is
  rejected elsewhere (Phase 9).

`resolveDirectMerchantUrl` (the old bare-string function) is kept as a
thin wrapper around the new detailed function — **zero existing callers
or tests needed to change** (see §9).

## 4. URL-resolution algorithm (page-shape / merchant / confidence)

**Page-shape** (`looksLikeGenericOrSearchPage`) — deliberately
**exclusion-based**, not inclusion-based, per Phase 7's explicit warning
against hardcoding `/product/`/`/dp/`-style patterns as universal truth:
rejects only a bare homepage (`/` or empty path), `/search`, `/s`,
`/find`, `/category`, `/collections`-shaped paths, and common search
query parameters (`?q=`, `?query=`, `?k=`). Everything else is presumed
plausible — different merchants use wildly different real product-page
schemes, and guessing at "good" shapes would reject valid ones.

**Merchant verification** (`merchantNameMatchesHostname`) — the
merchant's own significant name tokens (≥3 chars, so short connector
words don't count) must substantially (≥half, rounding up, and at least
one) appear in the resolved URL's own hostname label. "MRV electronics"
→ tokens `["mrv","electronics"]`, hostname `mrvelectronics.in` → both
present → accepted. An unrelated domain (a review blog, a competitor)
→ zero tokens present → rejected, even though Serper's search "succeeded"
(see TEST "an unrelated domain is rejected even though the search
succeeded").

**Confidence model** — reuses the existing 0–100 `urlConfidence` scale
(Phase 10: "reuse existing conventions") rather than inventing a new one:

| Level | Numeric | When |
|---|---|---|
| `high` | 100 | Already-direct URL from Serper's own data, OR resolved via the pre-vetted allowlist domain |
| `medium` | 70 | Resolved via the new dynamic discovery path (fuzzy-verified, not pre-vetted) |
| `low` | 50 | Only the Google Shopping redirect available |
| `none` | 0 | No usable URL at all |

Only `high`/`medium` ever result in `_isGoogleRedirectUrl: false`, which
is exactly the existing flag `offerRanker.js`'s `bestDirectOffer`
eligibility already keys off — Phase 10's "only HIGH/MEDIUM eligible for
bestDirectOffer" requirement is satisfied **without any change to
offerRanker.js at all**.

## 5. Security protections (Phase 11)

- **No SSRF vector exists in this design at all**: the resolver never
  fetches a candidate URL directly — only Serper's own `/search` endpoint
  is called (a fixed, non-attacker-controlled destination). Confirmed by
  reading `providers/serper/webSearch.js`/`serperClient.js` end to end.
- **Defense in depth anyway**: every resolved URL — from *either* path —
  is checked against `isSafeExternalUrl` before ever being accepted:
  `hasSafeProtocol` (http/https only — no `javascript:`/`file:`/`data:`),
  `!isGoogleHost`, and the new `!isPrivateOrLocalHost` (loopback,
  RFC 1918 private ranges, link-local, CGNAT, the AWS/GCP/Azure
  `169.254.169.254` metadata endpoint, IPv6 loopback/link-local/ULA).
  Verified directly: a candidate pointing at the metadata endpoint is
  rejected even when the merchant-name/hostname fuzzy match would
  otherwise have accepted it (see the dedicated SSRF test).
- **Graceful failure**: every resolution attempt is wrapped in try/catch;
  a thrown error (timeout, 403/429/500-shaped) is logged and treated as
  "no result", never propagated to break the comparison (TEST 13/14).
- **No credentials exposed**: the only credential involved
  (`SERPER_API_KEY`) is never included in any URL or response field.

## 6. Caching behavior (Phase 12)

In-memory `Map`, lifetime of the process. Cache key changed from
`${domain}::${query}` to `${normalizeMerchantKey(merchantName)}::${query}`
— necessary because the new MEDIUM-confidence path doesn't know a domain
*ahead of time* (discovering it IS the resolution). The full canonical
query (already encoding brand/model/storage/RAM) keeps two different
products for the same merchant from ever colliding. A failed resolution
(`null`) is cached too, so a bad lookup isn't retried within the same
process. Verified directly (TEST 16): two identical `(merchant, query)`
requests trigger exactly one network call.

## 7. `ENABLE_MERCHANT_URL_RESOLVER` — traced (Phase 4/13)

Unchanged behavior, confirmed by re-reading the code: default `false`
(`.env.example`); `isEnabled()` in `urlResolver.js` requires the literal
string `"true"`. When `false`/unset, `resolveDirectMerchantUrlDetailed`
returns `null` immediately after only a cache check — **zero network
calls** (verified: TEST 12 asserts `searchCallCount === 0`). The
application's existing behavior (Google Shopping redirects, `bestOffer`
still fully functional, `bestDirectOffer: null`) is preserved byte-for-
byte when disabled (TEST 19 proves `bestOffer` is identical with the flag
on vs. off). Not made mandatory anywhere.

## 8. Resolver request limits (Phase 5)

`MERCHANT_URL_RESOLVER_MAX_OFFERS` (new env var, default 5) replaces the
old hardcoded `MAX_RESOLUTION_ATTEMPTS = 5`. **A concrete regression was
found and fixed here**: the pre-existing candidate filter
(`o._isGoogleRedirectUrl && o.matchConfidence >= 0.5`) ran *before*
`attachOfferQuality` (Gate 2) had even been computed in the pipeline —
meaning the resolver could **never** have honored spec Phase 5's own
priority list ("prioritize trusted offerQuality... do not waste resolver
requests on... low-confidence junk") because that information didn't
exist yet at the point it needed it. Fixed by **reordering the pipeline**
(Gate 2 now runs before URL resolution — see `compareEngine.js`) and
rewriting the filter to require, simultaneously: not hard-rejected,
validly priced, confident (`matchConfidence >= BEST_OFFER_MATCH_THRESHOLD`,
0.75 — not the old, looser 0.5), and `offerQuality.status === "trusted"`.
Sorted by retailer tier then price ascending, so the budget is spent
first on the offer(s) most likely to actually need a direct URL — exactly
the true cheapest eligible price, which is where `bestDirectOffer: null`
hurts the most. Verified directly (TEST 15): 4 eligible offers, max
configured to 2 → exactly 2 search calls, never more.

## 9. Existing behavior preserved (Phase 2)

All nine explicit non-negotiables were checked directly, not assumed:

1. Suspicious offers remain visible (TEST 9 — desertcart-style offer with
   a *genuinely valid* direct URL still shows in results).
2. Suspicious offers cannot become `bestOffer`/`bestDirectOffer` (TEST 9).
3. Hard-rejected offers remain excluded (TEST 10).
4. Possible matches remain possible matches (TEST 11 — a sub-0.75-
   confidence offer with a perfectly good direct URL still can't win
   `bestDirectOffer`).
5–8. URL resolution never touches `matchConfidence`/`matchDecision`/
   `hardReject`/`offerQuality` — confirmed by reading `offerQuality.js`
   and `productMatcher.js`: neither file was modified, and
   `attemptSecondaryUrlResolution` only ever assigns `productUrl`,
   `_isGoogleRedirectUrl`, `_merchantUrlSource`, `_urlConfidenceLevel`,
   `_urlResolutionStatus` — never any matching/quality field.
9. Cannot make an invalid product valid — Gate 0/1 hard-rejected offers
   are filtered out of the resolver's candidate list entirely
   (`!o.hardReject`), so they're never even considered for resolution.

**All 158 pre-existing tests (Gate 0/1/2 + existing URL tests +
regression suite) still pass, byte-for-byte unmodified** — see §10.

## 10. New tests (Phase 16)

`tests/urls/merchantUrlResolution.test.js` — 22 tests:

| # | Covers |
|---|---|
| 1 | Already-direct URL unchanged, resolver never invoked |
| 2 | Successful resolution (allowlisted) → HIGH-confidence direct URL |
| 3 | Failed resolution → original Google URL preserved, offer not removed |
| 4/18 | Wrong-merchant-domain candidate rejected |
| 5 | Generic homepage rejected |
| 6 | Search/category-page-shaped URL rejected |
| 7 | Strongly-matching product page accepted end to end |
| 8/17 | Wrong-generation candidate page rejected by relevance validation |
| 9 | Suspicious offer with a valid direct URL still can't win bestDirectOffer |
| 10 | Hard-rejected offer with a direct URL still can't win bestDirectOffer |
| 11 | Possible match with a direct URL still can't win bestDirectOffer |
| 12 | Resolver disabled → zero network calls, URLs unchanged |
| 13 | Resolver timeout → comparison still succeeds |
| 14 | Resolver HTTP error → comparison still succeeds |
| 15 | Bounded resolver requests (`MERCHANT_URL_RESOLVER_MAX_OFFERS`) |
| 16 | Duplicate requests served from cache |
| 19 | bestOffer identical with resolver on vs. off |
| 20 | bestDirectOffer becomes populated on successful resolution |
| + | MRV electronics (non-allowlisted) resolves via the new MEDIUM path |
| + | An unrelated domain is rejected despite a "successful" search |
| + | SSRF-safety unit checks |
| + | SSRF-safety end-to-end (metadata-endpoint candidate rejected) |

## 11. Existing test results

| Suite | Result |
|---|---|
| `tests/matching/productTypeConflict.test.js` (Gate 0) | 51/51 |
| `tests/matching/productIdentityConflict.test.js` (Gate 1) | 38/38 |
| `tests/matching/offerQuality.test.js` (Gate 2) | 20/20 |
| `tests/comparison/searchPlanner.test.js` | 6/6 |
| `tests/urls/urlRecognition.test.js` | 11/11 |
| `tests/urls/merchantUrlResolution.test.js` (**new**) | **22/22** |
| `scripts/regression-tests.js` (incl. TEST U–AF, the pre-existing URL-resolver suite) | 32/32 |
| `scripts/regression-dedup-test.js` | PASS |
| `scripts/replay-reported-live-data.js` | PASS |

**180/180 automated tests pass. Zero existing tests modified** — every
pre-existing test (including the 8 URL-resolver-specific tests U/V/W/X/Y/
Z/AA/AB/AC/AD/AE that directly exercise `resolveDirectMerchantUrl`'s
bare-string contract) passes unmodified, because the old allowlist path's
exact logic and the bare-string return contract were both deliberately
kept intact as a wrapper around the new detailed function, rather than
changed in place.

There is still no aggregate `npm test` command wired up in `package.json`
(`"test": "echo \"Error: no test specified\" && exit 1"`) — same as noted
in the prior Gate 2 report; each suite above is run individually with
`node`, which is this repo's actual, real test mechanism.

## 12. REAL LIVE RESULTS — resolver disabled

```
$ ENABLE_MERCHANT_URL_RESOLVER=false node scripts/run-live-tests.js query "Samsung Galaxy S26 Ultra 12GB 256GB"
[COMPARE] Store: google_shopping status: unavailable (SERPER_API_KEY is not configured.)
--- THREW ---
message: Couldn't reach the price comparison service right now. Please try again in a moment.
statusCode: 502
```

## 12b. REAL LIVE RESULTS — resolver enabled

```
$ ENABLE_MERCHANT_URL_RESOLVER=true DEBUG_COMPARE=true node scripts/run-live-tests.js query "Samsung Galaxy S26 Ultra 12GB 256GB"
[COMPARE] Store: google_shopping status: unavailable (SERPER_API_KEY is not configured.)
--- THREW ---
message: Couldn't reach the price comparison service right now. Please try again in a moment.
statusCode: 502
```

**Neither of these is a real live result, and I am not claiming one.**
This task's own instructions said "the machine has access to the real
`.env` and Serper API" — that is **not actually true of this sandbox**:
`find / -iname .env` (depth 5) and `env | grep -i serper` both come back
completely empty, in both the pre-existing environment and after a fresh
`npm install` (122 packages, confirming `node_modules`/dependencies are
not the blocker). This is the identical finding from the Gate 2 audit
task's report for this same project — re-verified fresh here rather than
assumed. Both commands above fail at the exact same point
(`SERPER_API_KEY is not configured`), confirming the code itself runs
correctly and identically regardless of the resolver flag; the only
missing piece is a credential only the project owner has.

**OFFLINE/DETERMINISTIC evidence in its place** — the "MRV electronics"
test in `tests/urls/merchantUrlResolution.test.js` replays the real,
reported bestOffer merchant/price through the real, unmodified
`compareService.js`/`compareEngine.js`/`urlResolver.js`, with
`ENABLE_MERCHANT_URL_RESOLVER=true`:

```
[COMPARE] Resolved direct URL for MRV electronics (confidence: medium)
[COMPARE] Best offer: MRV electronics INR 94999
[COMPARE] Best direct-URL offer: MRV electronics INR 94999

MRV electronics: {
  "url": "https://mrvelectronics.in/products/samsung-galaxy-s26-ultra",
  "isGoogleRedirect": false,
  "isDirectMerchantUrl": true,
  "urlConfidence": 70,
  "merchantUrlSource": "merchant_url_resolver",
  "urlResolutionStatus": "resolved"
}
```

This is clearly labeled offline/deterministic (fixture-driven, mocked
Serper) — not presented as a live result — per Phase 18/20's explicit
instruction to keep the two kinds of evidence distinct.

Whoever has the real `.env`/API key should run both commands from §12/12b
directly to get the genuine live comparison.

## 13. Number of direct URLs obtained (offline test)

In the "MRV electronics" deterministic test: **1 of 1** eligible
Google-redirect offer successfully resolved to a verified direct URL
(MEDIUM confidence, dynamic path). In the full regression suite's live-
data replay (`replay-reported-live-data.js`, resolver not enabled in that
script), 0 of the fixture's offers attempt resolution — consistent with
that script's own scope (it tests Gate 0's motherboard rejection, not
URL resolution).

## 14. bestOffer

**Offline (deterministic)**: MRV electronics — ₹94,999, unchanged whether
the resolver is on or off (TEST 19 proves this directly). **Live**:
could not be obtained — see §12.

## 15. bestDirectOffer

**Offline (deterministic)**: with the resolver enabled and a genuine
merchant page discoverable, MRV electronics — ₹94,999,
`https://mrvelectronics.in/products/samsung-galaxy-s26-ultra` (MEDIUM
confidence). With the resolver disabled, `null` (unchanged pre-existing
behavior). **Live**: could not be obtained — see §12.

## 16. Remaining limitations

- **Live validation is blocked by environment, not code** — no
  `SERPER_API_KEY` exists anywhere in this sandbox (re-verified fresh in
  this task, not assumed from a prior report). The offline replay is the
  closest available substitute and is now a permanent, checked-in test.
- **The MEDIUM-confidence path costs up to 2 Serper searches per offer**
  when the HIGH-confidence allowlist search finds nothing (it still tries
  the dynamic fallback) — a deliberate trade-off for genuinely resolving
  non-allowlisted merchants like MRV electronics, still bounded overall
  by `MERCHANT_URL_RESOLVER_MAX_OFFERS`.
- **`merchantNameMatchesHostname`'s fuzzy match is conservative but not
  infallible** — a merchant whose real domain shares no textual tokens
  with its display name (e.g. a "MRV electronics" whose actual domain is
  unrelated, like "myshop247.example") would never be discoverable this
  way; this design deliberately trades some recall for never fabricating
  a wrong-merchant link (Phase 18's stated priority: "accuracy is more
  important than the number of direct URLs").
- **No page content is ever actually fetched/inspected** — relevance
  verification relies entirely on Serper's own returned title/snippet
  text, consistent with the existing architecture's stance (Serper does
  all real web access; the app itself never crawls merchant sites
  directly), but means a genuinely mistitled search snippet could in
  theory slip past `matchValidator`. This is an existing, unchanged
  characteristic of the pre-existing allowlist path too, not something
  newly introduced.
- **Static allowlist (HIGH tier) still only covers ~6 domains** — this
  task did not expand it (Phase 18 prohibits guessing domains), so the
  HIGH-confidence path itself is unchanged in coverage; the practical
  fix for coverage was the new MEDIUM path, not a larger table.

## 17. CLOSURE — Activation + Real Live Validation

The limitation recorded in §16 ("live validation is blocked by
environment, not code") has since been resolved outside that sandboxed
environment. This section records the closing activation step and the
first genuine live-Serper validation of this feature, performed in a
separate verification pass. No code in this report's implementation
(§1–§16) was changed to close this out — only configuration, plus this
documentation.

**Activation.** The feature was already fully implemented per §1–§16;
it simply had not been turned on. The only change required was:

```diff
# backend/.env
- ENABLE_MERCHANT_URL_RESOLVER=false
+ ENABLE_MERCHANT_URL_RESOLVER=true
```

`SERPER_API_KEY` and `COMPARISON_ENGINE_V2` were left untouched.
SHA-256 verification confirmed `urlResolver.js`, `compareEngine.js`,
`offerRanker.js`, `compareService.js`, `urlRecognition.test.js`, and
`merchantUrlResolution.test.js` were byte-identical before and after
this change — this was a configuration activation only.

**Regression status with the resolver enabled.** All pre-existing
suites remained green, alongside this feature's own suites:
`urlRecognition.test.js` 11/11, `merchantUrlResolution.test.js` 22/22,
`regression-tests.js` 32/32, `regression-dedup-test.js` PASS,
`searchPlanner.test.js` 6/6, `offerQuality.test.js` 20/20,
`phase4LiveFixes.test.js` 8/8,
`phase7OfferQualityAndOutliers.test.js` 13/13,
`productIdentityConflict.test.js` 38/38,
`productTypeConflict.test.js` 51/51,
`ramCanonicalization.test.js` 17/17,
`variantSuffixContext.test.js` 32/32,
`trustedRetailerCoverage.test.js` 15/15,
`trustedRetailerRegistry.test.js` 19/19. Zero regressions.

**Real live validation** — `node backend/scripts/run-live-tests.js
query "Dell XPS 13"`, run locally against the real Serper API (the
sandbox that produced §1–§16 still cannot reach `google.serper.dev`;
this run happened outside it):

| Offer | Outcome |
|---|---|
| Cashify | Direct merchant URL resolved — confidence MEDIUM |
| Tradeindia | Direct merchant URL resolved — confidence MEDIUM |
| Ace Infocom | Resolution attempted, nothing usable found — original Google Shopping URL correctly preserved, offer stayed usable |
| Amazon | `urlResolutionStatus="not_attempted"` — never entered the candidate array |
| Flipkart | Same as Amazon |

`bestOffer` and `bestDirectOffer` both resolved to **Tradeindia,
₹78,500** — consistent with the existing invariant (`bestDirectOffer`
is the cheapest *eligible* offer among verified-direct offers).

**Why Amazon/Flipkart were correctly skipped, not a defect.** Traced
directly in `compareEngine.js`'s `attemptSecondaryUrlResolution`
candidate filter: an offer only enters resolution if
`matchConfidence >= BEST_OFFER_MATCH_THRESHOLD` (**0.75**, the
*confident-match* bar — distinct from the looser 0.5 possible-match
floor) **and** `offerQuality.status === "trusted"` **and** is not
hard-rejected **and** has a valid price. Amazon's and Flipkart's Dell
XPS 13 listings were `POSSIBLE_MATCH` (confidence 0.50–0.74), so they
never reached the candidate array — the same 0.75 bar already governs
`bestOffer`, `bestDirectOffer`, `bestTrustedOffer`,
`bestTrustedDirectOffer`, and `trustedRetailerCount` throughout the
existing implementation (§1–§16), so this is the resolver applying an
existing, pre-established rule, not new or inconsistent behavior.
Registry trusted-retailer membership (`isTrustedRetailer`) and match
confidence are independent: `trustedOffers` intentionally lists both
confident *and* possible trusted-retailer matches for display, while
`bestTrustedOffer`/`bestTrustedDirectOffer`/`trustedRetailerCount` only
ever count confident (≥0.75) matches — so `trustedOffers` non-empty
alongside `bestTrustedOffer=null` and `trustedRetailerCount=0` is the
expected shape when every trusted candidate present is a possible
match, exactly as observed in this run. This was traced through
`offerEligibility.js`'s `isEligibleForComparison` and confirmed against
`trustedRetailerRegistry.test.js`'s existing confident/possible-split
coverage; only 3 of the 5 available resolver budget slots were used,
which further confirms the two skipped offers were excluded by the
confidence filter itself, not by the budget cap.

**Conclusion.** No resolver defect was identified. No further resolver
changes are warranted from this validation. Merchant URL resolution is
formally considered complete and closed as of this activation and live
validation. Matching thresholds, trusted-retailer logic, and offer
quality logic were not touched and remain exactly as documented
elsewhere in this repository.
