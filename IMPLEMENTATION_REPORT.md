# PricePulse — Compare Prices Backend V2 Architecture
## Implementation Report

---

## 1. Architecture created

A modular `comparison/` + `providers/` layer sits between the existing
Express routes and the existing store adapters:

```
backend/
├── comparison/              ← NEW: the engine
│   ├── compareEngine.js         orchestrator (identity → search → match →
│   │                            dedup → URL resolution → quality → ranking)
│   ├── productIdentity.js       canonical {brand, model, storage, ram, color}
│   ├── productNormalizer.js     builds the search query string
│   ├── searchPlanner.js         1 query by default, up to 3 under V2
│   ├── candidateCollector.js    runs planned queries, merges, caches (V2)
│   ├── variantMatcher.js        V2-facing surface over productMatcher.js
│   ├── offerExtractor.js        raw Serper item → NormalizedOffer
│   ├── urlResolver.js           redirect-vs-direct-URL logic
│   ├── offerDeduplicator.js     merchant dedup + cross-query URL dedup
│   ├── offerRanker.js           tier/URL/price ranking, best vs. best-direct
│   ├── qualityScorer.js         qualityScore + urlConfidence (Part 18)
│   └── comparisonCache.js       in-memory TTL cache
├── providers/                ← NEW: provider abstraction
│   ├── serper/
│   │   ├── serperClient.js      low-level HTTP (base URL, API key, timeout)
│   │   ├── shoppingSearch.js    /shopping wrapper, raw items only
│   │   └── webSearch.js         /search wrapper (used by urlResolver)
│   └── merchants/
│       └── merchantRegistry.js  single source of truth: tiers + domains
├── utils/                    ← NEW: shared primitives
│   ├── text.js                  normalization, tokenize, brand/color detect
│   ├── numbers.js                storage/RAM/model-number/price parsing
│   ├── url.js                    Google-host, protocol, domain helpers
│   └── errors.js                 CompareError (message, statusCode, code)
├── services/                 ← EXISTING, now thin
│   ├── compareService.js        public API + scraping + response shaping
│   ├── productMatcher.js        weighted-evidence scoring (unchanged logic)
│   ├── priceComparator.js       shim → comparison/offerRanker.js
│   └── stores/
│       ├── googleShopping.js       thin adapter → provider + extractor
│       └── merchantUrlResolver.js  shim → comparison/urlResolver.js
└── tests/                    ← NEW: expanded regression coverage
    ├── comparison/searchPlanner.test.js
    └── urls/urlRecognition.test.js
```

This is close to the target structure in the original brief, adapted where
the existing codebase already had a working, reusable shape (e.g.
`services/stores/*` "store adapter" abstraction was kept rather than
replaced — see §5).

---

## 2. Files created

**Phase 1:** `utils/text.js`, `utils/numbers.js`, `utils/url.js`,
`providers/merchants/merchantRegistry.js`

**Phase 2:** `providers/serper/serperClient.js`, `shoppingSearch.js`,
`webSearch.js`, `comparison/offerExtractor.js`, `comparison/urlResolver.js`

**Phase 3:** `comparison/productIdentity.js`, `productNormalizer.js`,
`variantMatcher.js`, `offerDeduplicator.js`, `offerRanker.js`,
`compareEngine.js`, `utils/errors.js`

**Phase 4:** `comparison/searchPlanner.js`, `candidateCollector.js`,
`qualityScorer.js`, `comparisonCache.js`,
`tests/comparison/searchPlanner.test.js`

**Phase 5:** `tests/urls/urlRecognition.test.js`, this report

## 3. Files modified

`services/compareService.js` (rewritten — now the API/response-shaping
adapter layer only), `services/productMatcher.js` (delegates to
`utils/text.js`/`utils/numbers.js`), `services/stores/googleShopping.js`
(thin adapter over provider + extractor), `services/stores/merchantUrlResolver.js`
(shim over `comparison/urlResolver.js`), `services/priceComparator.js`
(shim over `comparison/offerRanker.js`)

## 4. Files intentionally untouched

`vision.js`, `find.js`-equivalent (`routes/imageSearch.js`), Gemini
configuration, `js/*.js` (entire frontend), `routes/compare.js`,
`routes/compareText.js`, `routes/imageSearch.js`, `services/stores/amazon.js`
/ `flipkart.js` (honest `implemented:false` stubs — no scraping added),
`services/search/*.js` (AI Find's own separate Serper wrapper),
`server.ps1` / `start.bat` (deprecated, not reactivated)

## 5. Old code reused

`productMatcher.js`'s weighted-evidence matching algorithm (brand, model,
generation-token, plain-model-number, variant-suffix, storage/RAM-aware,
color guards) — this was already close to spec and is unchanged, just
relocated to share its text/number primitives. `priceComparator.js`'s
tier/URL/price ranking and best-offer/best-direct-offer split — same
logic, moved into `offerRanker.js`. The `services/stores/*` "store
adapter" abstraction (`ACTIVE_ADAPTERS`/`ALL_ADAPTERS`, `{id, label,
implemented, searchProduct}`) was kept as-is rather than replaced by a
new provider interface — it already cleanly separates "is this adapter
live" from "how does the engine consume it," which is what the spec's
Provider Strategy section asks for.

## 6. Old code replaced

Two duplicated data tables (`PREFERRED_RETAILERS` in `googleShopping.js`
and `MERCHANT_DOMAINS` in `merchantUrlResolver.js`) → one
`merchantRegistry.js`. Inline URL-field-guessing and Google-redirect
detection in `googleShopping.js` → `comparison/urlResolver.js` +
`offerExtractor.js`. The single hard-coded Serper query in
`compareService.js` → `searchPlanner.js` (still single-query by default,
now pluggable).

## 7. API changes

**None** for the existing contract. `routes/compare.js`,
`routes/compareText.js`, and `js/api.js`'s `comparePrices()` /
`compareByText()` / `compareByProduct()` are byte-for-byte unchanged.
Two new fields were *added* (never replacing existing ones) to each
offer in the response: `qualityScore` (0–100, Part 18) and
`urlConfidence` (0/50/100). Existing frontend code that doesn't read
these fields is unaffected.

## 8. Product matching algorithm

Unchanged from the existing V1 (already spec-aligned): weighted evidence
across title-token overlap, brand presence, exact model-number text
match, letter+digit generation tokens (S25 vs S26), plain numeric model
numbers (Airdopes 141 vs 131), variant-suffix words (Pro/Ultra/Plus/
Neo/Max — symmetric add-or-drop mismatch), RAM-aware storage/RAM
extraction, and color. Each check either nudges the score or caps it
(hard ceiling) — never a single fuzzy-string threshold, matching spec
§7's explicit requirement. Output: `matchConfidence` (0–1) +
`matchLabel` (exact/high/medium/low) + `matchIssue` (which specific
guard tripped, for frontend display).

## 9. URL resolution strategy

Two-tier, both honest about what they found:
1. **Extraction time** (`urlResolver.resolveMerchantUrl`): prefers any
   non-Google field Serper's item already contains; falls back to the
   `link` field even if it *is* the Google redirect, flagging
   `isGoogleRedirect: true` rather than hiding it.
2. **Secondary resolution** (`urlResolver.resolveDirectMerchantUrl`,
   off by default via `ENABLE_MERCHANT_URL_RESOLVER`): a bounded (max 5
   offers/request), cached, allowlist-validated (`merchantRegistry`'s
   `domain` field) scoped web search (`site:amazon.in ...`) to upgrade a
   redirect-only offer. Validates both domain (`belongsToDomain`) and
   product relevance (re-runs `variantMatcher` against the candidate's
   title/snippet) before accepting. Any failure/timeout/mismatch leaves
   the original Google URL and honest labeling untouched — never
   fabricates a merchant URL.

## 10. Amazon handling

Amazon (and every merchant) is classified by `merchantRegistry.js`
regardless of URL shape — `amazon.in`, `amzn.in`, `amzn.to` all reach
the extractor as non-Google URLs and are preserved as direct merchant
links (see `tests/urls/urlRecognition.test.js`). No scraping, no
CAPTCHA/bot-protection bypass — all data comes from Serper's authorized
Shopping/Search API.

## 11. Google Shopping handling

Serper (Google Shopping data) is the discovery source, never
automatically the destination — `isGoogleHost()` in `utils/url.js`
gates every URL decision. A Google-redirect-only offer is ranked below
same-tier direct-URL offers (`offerRanker.js`'s `directRank`), is
excluded from `bestDirectOffer` entirely, and is labeled
`isGoogleRedirect: true` / `isDirectMerchantUrl: false` for the
frontend to render honestly ("View on Google Shopping").

## 12. Ranking algorithm

Not price-only. Within confidently-matched offers: (1) validity
(priced, in-stock) → (2) retailer tier (major/known/other) → (3)
verified-direct-URL over Google-redirect → (4) price ascending.
`bestOffer` = cheapest offer clearing a *stricter* match-confidence bar
(0.75) than the display bar (0.5), priced, in-stock, linkable.
`bestDirectOffer` = same, but additionally excludes Google redirects —
kept distinct per spec §20 so a cheaper unresolved redirect never
silently becomes "the deal."

## 13. Deduplication strategy

Two layers: (a) per-query, per-merchant dedup (`offerDeduplicator.
deduplicateByMerchant`) — first-seen listing per store name; (b) under
V2 only, cross-query exact-URL dedup (`deduplicateByUrl`) before
merchant dedup runs, since the same listing can legitimately surface
for two different planned queries. Never merges by fuzzy title
similarity — dedup keys are always merchant identity or exact URL,
never guessed.

## 14. Caching

In-memory, TTL-based (`comparisonCache.js`), namespaced (`search`,
`url`), env-configurable (`SEARCH_CACHE_TTL_MS`, `URL_CACHE_TTL_MS`).
Active **only** under `COMPARISON_ENGINE_V2` — the default single-query
pipeline makes a fresh call every time, unchanged from V1. No Redis;
the interface is narrow enough to swap in a Redis-backed implementation
later without touching call sites.

## 15. Error handling

One error type (`utils/errors.js`'s `CompareError`) with a human
message, HTTP status, and machine code (`INVALID_INPUT`,
`PRODUCT_NOT_IDENTIFIED`, `NO_MATCHING_OFFERS`, `PROVIDER_FAILURE`,
`CONFIGURATION_ERROR`). One failed adapter/query never throws — only
*total* failure (every adapter, every query) raises `PROVIDER_FAILURE`;
partial success returns partial results with `diagnostics.
providersFailed` tracked internally.

## 16. Security improvements

Centralized protocol validation (`utils/url.js`'s `hasSafeProtocol` —
only http/https, tested against `javascript:`/`file:`/`data:`).
Merchant URL resolution stays allowlist-only (`merchantRegistry.
getResolvableDomain` — unknown merchants never attempted). No new
outbound-request surface was added; `axios` calls remain limited to
Serper's own endpoints and the pre-existing product-page scrape (with
existing timeout/redirect-limit config, unchanged). API keys are read
from `process.env` only, never logged (verified — no `SERPER_API_KEY`/
`GEMINI_API_KEY` string appears in any `console.log` call added or
touched in this project).

## 17. Tests added

- `tests/comparison/searchPlanner.test.js` (6 tests): V1 parity (flag
  off ⇒ exactly one Serper call, identical results), V2 behavior
  (multi-query fan-out, cross-query duplicate-URL collapse), quality
  score sanity + ranking correctness.
- `tests/urls/urlRecognition.test.js` (11 tests): Google-host detection
  across TLDs, Amazon short-URL (amzn.in/amzn.to) recognition, unsafe
  protocol rejection, domain-spoofing rejection, invalid-URL/empty-
  search/empty-product input validation, missing-field honesty
  (price/rating/availability never fabricated), cross-generation
  product-family rejection (Sony WH-1000XM5 vs XM4).

## 18. Tests passed

**64/64** across all four suites:
- `scripts/regression-tests.js`: 32/32 (pre-existing, unmodified assertions)
- `scripts/regression-dedup-test.js`: 15/15 (pre-existing)
- `tests/comparison/searchPlanner.test.js`: 6/6 (new)
- `tests/urls/urlRecognition.test.js`: 11/11 (new)

All are fixture-based (fake `axios`), deterministic, and require no
network or `SERPER_API_KEY`.

## 19. Tests that could not be run

**Live Serper/Gemini API verification.** This environment has no
outbound network access to `google.serper.dev` and no configured
`SERPER_API_KEY`/`GEMINI_API_KEY`. `scripts/run-live-tests.js` (already
present in the repo, unmodified) exists for this and must be run in an
environment with real credentials and network access.

**Static/fixture verification completed; live provider verification
still required.**

## 20. Remaining limitations

- Multi-query fan-out (`searchPlanner.js`) is gated behind
  `COMPARISON_ENGINE_V2` and off by default — flip it on and re-run
  `run-live-tests.js` before relying on it in production.
- `ENABLE_MERCHANT_URL_RESOLVER` (secondary URL upgrade) is likewise
  off by default and unverified against the live API — same caveat.
- Only one live provider (Serper/Google Shopping) exists; the
  provider-abstraction boundary (`providers/serper/*`) is in place for
  a second provider, but none is implemented.
- `services/search_old.js` (a Gemini-based, unreferenced legacy search
  path) was found during inspection — confirmed dead (no `require`
  anywhere in the codebase) but left in place rather than deleted, per
  the "don't delete until confirmed no longer required" migration
  guidance; flagging it here for your call.
- `tests/matching/`, `tests/normalization/`, `tests/ranking/` scaffold
  directories exist but are currently empty — the equivalent coverage
  lives in `scripts/regression-tests.js` (matching: tests B–T; ranking:
  test H) rather than being split into per-directory files. Splitting
  them out is a pure reorganization, not a coverage gap, and I left it
  as-is to avoid unnecessary churn.

## 21. Exact commands to run locally

```bash
cd backend
npm install

# Fixture-based regression suites (no network/API key required)
node scripts/regression-tests.js
node scripts/regression-dedup-test.js
node tests/comparison/searchPlanner.test.js
node tests/urls/urlRecognition.test.js

# Live API verification (requires real SERPER_API_KEY in .env)
node scripts/run-live-tests.js

# Start the server (unchanged)
node server.js
# → http://localhost:5000, frontend unchanged, open index.html

# To try the V2 search-planner/cache path (off by default):
# add to backend/.env:
#   COMPARISON_ENGINE_V2=true
# and optionally:
#   ENABLE_MERCHANT_URL_RESOLVER=true
#   SEARCH_PLANNER_MAX_QUERIES=3
#   SEARCH_CACHE_TTL_MS=300000
#   DEBUG_COMPARE=true
```
