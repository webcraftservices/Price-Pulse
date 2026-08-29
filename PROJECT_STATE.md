# PROJECT_STATE.md

**Snapshot date:** repository as inspected in this session (no timestamp metadata exists in the repo itself — this reflects file contents at time of audit, not a live/continuous state).

**Purpose:** this document is the single reconciling source of truth for PricePulse V2's actual current state. It exists because this repository has accumulated **three separate, non-overlapping "Phase N" numbering schemes** from different work sessions that do not correspond to one another (see §11). Read this file, not any individual phase number, to understand what's actually true.

---

## 1. Project Overview

PricePulse V2 is a Node.js/Express backend + static HTML/CSS/vanilla-JS frontend that compares real-time product prices across Indian e-commerce retailers, built around a single live data source (Google Shopping via Serper) plus a merchant URL upgrade layer.

**Current comparison flow** (query → frontend result):

```
User input (text query OR product URL)
  → routes/compare.js | routes/compareText.js
  → services/compareService.js
      canonicalizeProduct()            [comparison/productIdentity.js]
      buildSearchQuery()                [comparison/productNormalizer.js]
      queryActiveAdapters()             [comparison/compareEngine.js]
        → general query via ACTIVE_ADAPTERS (only google_shopping is active)
        → Phase 8.1 bounded trusted-retailer coverage (comparison/trustedRetailerCoverage.js)
      offerExtractor.js                 (normalize raw Serper items → offers)
      variantMatcher.js / services/productMatcher.js   (Gate 0/1: type + identity/variant matching)
      offerQuality.js / qualityScorer.js (Gate 2: price/data quality, quality/urlConfidence scores)
      attemptSecondaryUrlResolution()   [comparison/urlResolver.js] (Google-redirect → real merchant URL, bounded)
      offerDeduplicator.js              (by merchant, by URL)
      offerRanker.js buildComparison()  (eligibility gates, bestOffer/bestDirectOffer/bestTrustedOffer/bestTrustedDirectOffer)
      trusted-pool re-run (same buildComparison(), filtered to registry-trusted merchants)
  → JSON response → js/compare.js (IDLE/COMPARING/RESULTS/FULL_INTERNET state machine)
```

A parallel, independent feature — **AI Find** (`routes/imageSearch.js` → `services/vision.js` + `services/search/`) — identifies a product from an uploaded photo via Gemini and searches for it. It shares no code with the comparison pipeline above and was not touched by any work this document describes.

---

## 2. Current Technology / Architecture

- **Runtime:** Node.js, CommonJS (`"type": "commonjs"` in `package.json`), Express 5.
- **Dependencies (from `package.json`):** `axios`, `cheerio`, `cors`, `dotenv`, `express`, `multer`, `openai`. No test framework dependency — all tests are hand-rolled Node scripts (see §6).
- **No TypeScript, no build step, no linter config** — `npm test` is an unconfigured placeholder (`"echo \"Error: no test specified\" && exit 1"`); real tests are run individually via `node <path>`.
- **Directories:**
  - `backend/comparison/` — the live V2 comparison engine (16 files): `compareEngine.js`, `productIdentity.js`, `productNormalizer.js`, `productTypeClassifier.js`, `variantMatcher.js`, `candidateCollector.js`, `searchPlanner.js`, `trustedRetailerCoverage.js`, `offerExtractor.js`, `offerQuality.js`, `qualityScorer.js`, `offerEligibility.js`, `offerDeduplicator.js`, `offerRanker.js`, `urlResolver.js`, `comparisonCache.js`.
  - `backend/services/` — `compareService.js` (API-facing orchestrator, called by routes), `vision.js` + `search/` (AI Find, independent), and **legacy files kept for regression-test lineage only** (see below): `productMatcher.js`, `priceComparator.js`, `search_old.js`, `stores/`.
  - `backend/services/stores/` — provider adapters: `googleShopping.js` (live), `amazon.js` (stub), `flipkart.js` (stub), `index.js` (registers `ACTIVE_ADAPTERS`), plus two confirmed-dead files: `storeAdapter.js` (a documentation-only interface contract, intentionally never imported), `merchantUrlResolver.js` (V1 predecessor of `comparison/urlResolver.js` — superseded, not required anywhere).
  - `backend/providers/serper/` — `serperClient.js`, `shoppingSearch.js`, `webSearch.js` (the actual Serper HTTP calls).
  - `backend/providers/merchants/merchantRegistry.js` — single source of truth for merchant `trusted`/`tier`/`domains` metadata.
  - `backend/routes/` — `compare.js`, `compareText.js`, `imageSearch.js`.
  - `backend/tests/` — `comparison/`, `matching/`, `retailers/`, `urls/` (12 test files total, all currently passing — see §6). No files exist yet under `tests/normalization/` or `tests/ranking/` as separate directories; that coverage lives inside `matching/` and `scripts/regression-tests.js` instead.
  - `backend/scripts/` — `regression-tests.js`, `regression-dedup-test.js` (fixture-based, no network), `run-live-tests.js`, `replay-reported-live-data.js` (both require a real `SERPER_API_KEY` / network access).

**Important dead-code finding (verified, not assumed):** `services/productMatcher.js` is **not** legacy — it is actively `require()`d by `comparison/variantMatcher.js` and is the real underlying Gate 0/1 matching implementation. By contrast, `services/priceComparator.js` is only referenced by one specific assertion inside `scripts/regression-tests.js` (a `bestDirectOffer`-vs-`bestOffer` invariant check against the pre-extraction V1 function) and is not required anywhere in the live server/routes path. `services/search_old.js` and `services/stores/merchantUrlResolver.js` are confirmed dead (grep-verified: zero `require()` references anywhere in the codebase outside their own file and descriptive comments about their lineage).

---

## 3. Completed Work

| Area | Status | Evidence | Notes |
|---|---|---|---|
| Gate 0 — product type classification | Complete | `comparison/productTypeClassifier.js`; `PRODUCT_TYPE_FIX_REPORT.md`; `tests/matching/productTypeConflict.test.js` (51/51) | |
| Gate 1 — product identity / variant matching | Complete | `services/productMatcher.js` + `comparison/variantMatcher.js`; `PHASE2_PRECISION_FIX_REPORT.md`; `tests/matching/productIdentityConflict.test.js` (38/38) | Report calls this "Phase 2 Precision Fix (Gate 1)" |
| Gate 2 — offer/price quality | Complete | `comparison/offerQuality.js`, `qualityScorer.js`; `PHASE2_GATE2_OFFER_QUALITY_REPORT.md`, `PHASE2_GATE2_VALIDATION_REPORT.md`; `tests/matching/offerQuality.test.js` (20/20) | Two report files exist for this one area — a build report and a separate validation-pass report |
| Merchant URL resolution & direct buy links | **Complete / Closed** | `comparison/urlResolver.js`; `PHASE3_MERCHANT_URL_RESOLUTION_REPORT.md` (incl. §17 closure); `tests/urls/*.test.js` (33/33) | See §4 — documented separately, now closed with real live validation |
| Live-data review fixes (title/RAM matching edge cases) | Complete | `PHASE4_LIVE_FIXES_REPORT.md`; `tests/matching/phase4LiveFixes.test.js` (8/8) | |
| RAM canonicalization | Complete | `PHASE5_RAM_CANONICALIZATION_REPORT.md`; `tests/matching/ramCanonicalization.test.js` (17/17) | Resolved the RAM-population gap `PHASE4` had flagged as a future concern — verified in `productIdentity.js`/`variantMatcher.js` |
| Variant-suffix/chipset-context handling | Complete | `tests/matching/variantSuffixContext.test.js` (32/32) | No dedicated top-level `.md` report exists for this specifically; conversational label was "Phase 6" (see §11) — treated as complete on test evidence, not a report |
| Offer-quality outlier detection / savings integrity | Complete | `tests/matching/phase7OfferQualityAndOutliers.test.js` (13/13) | No dedicated `.md` report exists; conversational label was "Phase 7" (see §11) |
| Trusted-retailer-first display layer + registry | Complete | `providers/merchants/merchantRegistry.js`; `tests/retailers/trustedRetailerRegistry.test.js` (19/19) | No dedicated `.md` report exists; conversational label was "Phase 8" (see §11) |
| Bounded adaptive trusted-retailer coverage | Complete | `comparison/trustedRetailerCoverage.js`; `tests/retailers/trustedRetailerCoverage.test.js` (15/15) | No dedicated `.md` report exists; conversational label was "Phase 8.1" (see §11) |
| Frontend comparison state machine (IDLE/COMPARING/RESULTS/FULL_INTERNET) + reset behavior | Complete | `js/compare.js` (`setState`, `resetComparisonState`) | Verified by static code inspection, not an automated test (frontend has no test harness in this repo) |
| Original multi-query search-planner refactor (V2 flag) | Complete, gated off by default | `comparison/searchPlanner.js`; `IMPLEMENTATION_REPORT.md`; `tests/comparison/searchPlanner.test.js` (6/6) | `COMPARISON_ENGINE_V2=false` in current `.env` — see §7 |

---

## 4. Merchant URL Resolution — Current Final State

**MERCHANT URL RESOLUTION = COMPLETE / CLOSED.**

What was implemented (`comparison/urlResolver.js`, orchestrated from `comparison/compareEngine.js`'s `attemptSecondaryUrlResolution`):

- **HIGH-confidence allowlisted path:** a small, pre-vetted domain table; a `site:domain query` Serper web-search is issued and any result on that exact domain is trusted without further heuristics.
- **MEDIUM-confidence dynamic discovery path:** for any other (non-allowlisted) merchant, a `merchantName query` Serper web-search is issued and the resulting hostname is fuzzy-matched against the merchant's name before being accepted.
- **Page-shape validation:** generic homepage/search/listing pages are rejected even on the correct domain.
- **Merchant hostname verification:** the resolved URL's domain must correspond to the expected merchant; Google/other search-engine hosts are always rejected outright.
- **Match-confidence validation as a gating input, not an output:** identity matching happens first and independently; a resolved URL never increases `matchConfidence`, and a failed resolution never triggers `hardReject`.
- **SSRF protections:** `isSafeExternalUrl` (in `utils/url.js`) rejects unsafe protocols, localhost, private/internal IP ranges, and metadata endpoints before any candidate URL is ever followed.
- **Caching:** identical `(merchant, query)` lookups are cached within a single process/comparison run.
- **Enable/disable behavior:** gated entirely behind `ENABLE_MERCHANT_URL_RESOLVER`. Currently **`true`** in the working `backend/.env` (flipped from `false` during this project's validation pass — see below). `.env.example` still ships `false` as its documented default.
- **Resolver request budget:** `MERCHANT_URL_RESOLVER_MAX_OFFERS`, default 5 — only the top N most-promising Google-redirect candidates (sorted by `_retailerTier` then price) are attempted per comparison.
- **Failure isolation:** wrapped in try/catch; a timeout or resolution failure logs and leaves the offer's original Google Shopping URL and eligibility completely intact — never throws out of `compareByQuery()`.
- **`bestDirectOffer`/`bestTrustedDirectOffer` behavior:** both are selected only from offers with a verified, non-Google direct URL, independently of `bestOffer`/`bestTrustedOffer` (which consider all eligible offers regardless of URL type). Confirmed via `scripts/regression-tests.js`'s dedicated assertion (`buildComparison` from `priceComparator.js`) that a cheaper Google-redirect offer never displaces a verified direct offer as `bestDirectOffer`.
- **Test coverage:** `tests/urls/urlRecognition.test.js` (11/11) + `tests/urls/merchantUrlResolution.test.js` (22/22) — direct-URL preservation, successful/failed resolution, wrong-domain/wrong-merchant rejection, SSRF safety, budget/caching enforcement, and `bestOffer`/`bestDirectOffer` invariants under both resolver-on and resolver-off conditions.
- **Real live validation (documented, not fabricated):** a real `node backend/scripts/run-live-tests.js query "Dell XPS 13"` run (performed outside this session's own sandbox, which cannot reach `google.serper.dev`) showed: Cashify and Tradeindia resolved to real direct merchant URLs at MEDIUM confidence; Ace Infocom was attempted, found nothing usable, and correctly kept its original Google Shopping URL; `bestOffer` and `bestDirectOffer` both correctly resolved to Tradeindia at ₹78,500; Amazon and Flipkart's listings remained `urlResolutionStatus: "not_attempted"` because their `matchConfidence` was below the 0.75 confident-match bar the resolver's candidate filter requires — traced conclusively to the same threshold `bestOffer`/`bestTrustedOffer` already use, not a resolver defect. This evidence and reasoning is recorded in full in `PHASE3_MERCHANT_URL_RESOLUTION_REPORT.md` §17.

**Known limitation, explicitly not a defect:** Amazon and Flipkart products can still surface with a *direct* URL through this mechanism whenever Serper's Google Shopping aggregation happens to already return one, or whenever the resolver's dynamic MEDIUM-confidence path happens to find one and the offer is confident enough to be attempted — but this is opportunistic upgrading of already-discovered offers, not the same thing as a direct Amazon/Flipkart provider integration (see §5). Do not reopen merchant URL resolution work based on Amazon/Flipkart coverage gaps alone; that is a provider-integration question, addressed separately below.

---

## 5. Provider Status

| Provider | Current Status | Implemented? | How it obtains data | Blocker / Notes |
|---|---|---:|---|---|
| Google Shopping (via Serper) | Live, sole active data source | Yes | `services/stores/googleShopping.js` → `providers/serper/shoppingSearch.js` → real Serper `/shopping` HTTP call | Requires `SERPER_API_KEY`. This is the only entry in `ACTIVE_ADAPTERS`. |
| Amazon | **Stub — blocked by external prerequisites** | No (`implemented: false`) | N/A — `searchProduct()` throws if called | Not "next phase" by repo evidence — no repo document schedules this. A separate feasibility investigation (conversational, not yet committed to any `.md` file in the repo) found: Amazon's PA-API 5.0 was retired May 15, 2026; its replacement, the Creators API, requires an active Associates account with 10 qualifying sales in the trailing 30 days (a rolling business precondition PricePulse cannot satisfy through engineering work alone), plus an unresolved question of whether pure price-comparison use fits the program's permitted use cases. |
| Flipkart | **Stub — requires architectural work, feasibility unconfirmed** | No (`implemented: false`) | N/A — `searchProduct()` throws if called | Not "next phase" by repo evidence. Same feasibility investigation found: Flipkart's Affiliate API is feed-based (bulk category feeds), not query-based — incompatible with the current adapter interface's assumption of a live `searchProduct(query)` call. Would need a new ingestion/local-index sub-architecture, not just filling in the stub. Public documentation is also stale (~2016) and unverified against current Flipkart practice. |

---

## 6. Test Status

All of the following were actually executed in this session, fresh, immediately before writing this document — not assumed from memory.

**Deterministic/fixture-based unit & integration tests (no network required):**

| Test/Suite | Result | Notes |
|---|---|---|
| `backend/scripts/regression-tests.js` | 32/32 passed | Fixture-based, fake HTTP layer |
| `backend/scripts/regression-dedup-test.js` | PASS | Single-assertion dedup check |
| `backend/tests/comparison/searchPlanner.test.js` | 6/6 passed | Includes the V1/Phase-8.1-coexistence invariant |
| `backend/tests/matching/offerQuality.test.js` | 20/20 passed | |
| `backend/tests/matching/phase4LiveFixes.test.js` | 8/8 passed | |
| `backend/tests/matching/phase7OfferQualityAndOutliers.test.js` | 13/13 passed | |
| `backend/tests/matching/productIdentityConflict.test.js` | 38/38 passed | |
| `backend/tests/matching/productTypeConflict.test.js` | 51/51 passed | |
| `backend/tests/matching/ramCanonicalization.test.js` | 17/17 passed | |
| `backend/tests/matching/variantSuffixContext.test.js` | 32/32 passed | |
| `backend/tests/retailers/trustedRetailerCoverage.test.js` | 15/15 passed | |
| `backend/tests/retailers/trustedRetailerRegistry.test.js` | 19/19 passed | |
| `backend/tests/urls/merchantUrlResolution.test.js` | 22/22 passed | |
| `backend/tests/urls/urlRecognition.test.js` | 11/11 passed | |

**Total: 284 deterministic test assertions across 13 files, 100% passing, zero failures, run fresh in this session.**

**Replay tests:** `backend/scripts/replay-reported-live-data.js` exists but was not run in this session (it replays previously-captured live payloads — not exercised here; status UNKNOWN as of this snapshot).

**Live API tests:** `backend/scripts/run-live-tests.js` requires a real `SERPER_API_KEY` and outbound network access to `google.serper.dev`. **This cannot run in this session's environment** (confirmed: the sandbox's network egress proxy explicitly denies `google.serper.dev` with `x-deny-reason: host_not_allowed`). A real local run of this script (performed by the project owner, outside this sandbox) against `"Dell XPS 13"` is documented in `PHASE3_MERCHANT_URL_RESOLUTION_REPORT.md` §17 and summarized in §4 above — that result is real and documented, not something this session fabricated, but this session could not itself reproduce or independently re-verify it.

---

## 7. Configuration / Environment

No secret values are reproduced below or anywhere in this document.

| Variable | Default / current value | Controls | Required? | Enabled by default? |
|---|---|---|---|---|
| `SERPER_API_KEY` | Present in working `backend/.env` (value not reproduced here); empty in `.env.example` | Auth for all Serper calls (Google Shopping search, web search for URL resolution) | Yes — nothing in the comparison pipeline works without it | N/A (secret) |
| `SEARCH_PROVIDER` | `serper` (per `.env.example`) | Selects the search backend for AI Find's `services/search/` | Yes, for AI Find | Yes |
| `GEMINI_API_KEY` | Empty in `.env.example` | AI Find's image identification (`services/vision.js`) | Yes, for AI Find only | N/A (secret) |
| `PORT` | `5000` | Express server port | No (has a code default) | Yes |
| `DEBUG_COMPARE` | `false` | Verbose per-offer match/rejection logging in `compareService.js` | No | No |
| `COMPARISON_ENGINE_V2` | `false` in working `.env`; **not documented in `.env.example` at all** | Enables `searchPlanner.js`'s multi-query fan-out inside `compareEngine.js`'s `queryActiveAdapters` | No | **No — off by default** |
| `ENABLE_MERCHANT_URL_RESOLVER` | **`true`** in working `.env` (flipped from `false` during this project's activation pass); `false` in `.env.example` | Gates the entire secondary URL-resolution pass described in §4 | No | Off by `.env.example`'s documented default, but currently **on** in the actual working `.env` |
| `MERCHANT_URL_RESOLVER_MAX_OFFERS` | Not set in working `.env` → code default `5` | Bounds how many Google-redirect offers the resolver attempts per comparison | No | N/A (has a code default) |
| `MAX_TRUSTED_RETAILER_QUERIES` | Not set in working `.env` → code default `3` | Bounds Phase-8.1 trusted-retailer supplemental queries | No | N/A (has a code default) |
| `TRUSTED_COVERAGE_ENABLED` | Not set in working `.env` → code default effectively `true` | Master on/off for the trusted-retailer-coverage feature | No | **Yes — on by default**, independent of `COMPARISON_ENGINE_V2` |
| `AMAZON_PAAPI_ACCESS_KEY` / `AMAZON_PAAPI_SECRET_KEY` / `AMAZON_PAAPI_PARTNER_TAG` | Not set anywhere | Would activate `services/stores/amazon.js` if implemented | N/A — adapter is a stub | No |
| `FLIPKART_AFFILIATE_ID` / `FLIPKART_AFFILIATE_TOKEN` | Not set anywhere | Would activate `services/stores/flipkart.js` if implemented | N/A — adapter is a stub | No |

**Documentation drift, verified:** `.env.example`'s comment for `ENABLE_MERCHANT_URL_RESOLVER` still references `backend/services/stores/merchantUrlResolver.js` as the file it controls — that file is confirmed dead (§2); the real, active implementation is `backend/comparison/urlResolver.js`. This is a stale comment, not a functional bug (the variable name and behavior are correct) — listed as a housekeeping item in §8C.

---

## 8. Known Limitations

### A. Genuine product/engineering limitations
- Only one live data provider exists (Google Shopping via Serper). No second live provider is implemented.
- Amazon and Flipkart direct URLs depend entirely on opportunistic discovery through Google Shopping's own aggregation plus the resolver's dynamic MEDIUM-confidence path — there is no guarantee either retailer appears, confidently matched, in any given comparison.

### B. External dependency/business limitations
- Amazon: PA-API 5.0 is retired; its replacement (Creators API) requires an active Associates account already generating 10+ qualifying sales per rolling 30 days — a business precondition, not something resolvable by writing code.
- Amazon: whether Creators API's permitted use cases cover a pure price-comparison product (as opposed to affiliate content) is unresolved and requires an external/legal answer, not a technical one.
- Flipkart: current real-world API access terms and behavior are unverified against stale (~2016) public documentation; requires direct confirmation with Flipkart before any further technical scoping is meaningful.

### C. Cosmetic/housekeeping items
- `.env.example`'s comment for `ENABLE_MERCHANT_URL_RESOLVER` references the superseded `services/stores/merchantUrlResolver.js` instead of the actual `comparison/urlResolver.js`.
- `COMPARISON_ENGINE_V2` has no corresponding entry in `.env.example` at all, despite being a real, functioning flag referenced in `IMPLEMENTATION_REPORT.md`.
- `services/search_old.js` and `services/stores/merchantUrlResolver.js` are confirmed dead code, still present in the tree (flagged previously in `IMPLEMENTATION_REPORT.md` §20 as "left in place rather than deleted, per the 'don't delete until confirmed no longer required' migration guidance").
- `services/stores/storeAdapter.js` is an intentional documentation-only file (not a bug — it documents the adapter contract and is deliberately never imported).
- Three empty test-directory scaffolds (`tests/normalization/`, `tests/ranking/`, and a fuller `tests/matching/` that absorbed what those two were presumably meant to hold) — purely organizational, not a coverage gap; the equivalent tests already exist under `tests/matching/` and `scripts/regression-tests.js`.

---

## 9. Open Work

### [Second live price-data provider — Amazon]
Status: Not started (stub only)
Evidence: `backend/services/stores/amazon.js`, `implemented: false`
Why it is unfinished: No live Amazon integration exists; only Google Shopping's own listing of Amazon offers (if any) surfaces Amazon prices today.
Dependencies/blockers: Amazon Creators API requires 10+ qualifying affiliate sales per rolling 30 days before credentials can even be issued — an external business precondition. Permitted-use-case fit for pure price comparison is also unconfirmed.
Scope known/unknown: Unknown until the business precondition is resolvable and Amazon's policy fit is confirmed.
Priority: Cannot be prioritized as engineering work at this time — blocked on a non-engineering precondition.

### [Second live price-data provider — Flipkart]
Status: Not started (stub only)
Evidence: `backend/services/stores/flipkart.js`, `implemented: false`
Why it is unfinished: No live Flipkart integration exists.
Dependencies/blockers: Flipkart's Affiliate API appears to be feed-based, not query-based, which doesn't fit the current adapter interface's `searchProduct(query)` contract — would need a new ingestion/local-index sub-architecture. Current program terms are unverified against stale public docs.
Scope known/unknown: Unknown — a feasibility spike (direct confirmation with Flipkart, not code) is the prerequisite before scope can even be estimated.
Priority: Worth a feasibility spike before any engineering commitment; not currently scheduled by any repo document.

### [Stale `.env.example` comment for `ENABLE_MERCHANT_URL_RESOLVER`]
Status: Not started
Evidence: `.env.example`'s comment references the dead `services/stores/merchantUrlResolver.js`
Why it is unfinished: Simple documentation drift, never corrected after the file was superseded.
Dependencies/blockers: None.
Scope known/unknown: Fully known — a one-line comment fix.
Priority: "OPTIONAL / NOT A CURRENTLY REQUIRED WORK ITEM"

### [Missing `COMPARISON_ENGINE_V2` entry in `.env.example`]
Status: Not started
Evidence: grep-confirmed absence from `.env.example` despite the variable being real and load-bearing
Why it is unfinished: Documentation gap.
Dependencies/blockers: None.
Scope known/unknown: Fully known — a small documentation addition.
Priority: "OPTIONAL / NOT A CURRENTLY REQUIRED WORK ITEM"

### [Dead file cleanup — `search_old.js`, `stores/merchantUrlResolver.js`]
Status: Flagged, not actioned
Evidence: `IMPLEMENTATION_REPORT.md` §20 already flagged this; confirmed still present and still dead in this audit
Why it is unfinished: Left in place pending explicit owner approval to delete, per that report's own stated migration discipline.
Dependencies/blockers: Needs an explicit "yes, delete" decision from the project owner.
Scope known/unknown: Fully known.
Priority: "OPTIONAL / NOT A CURRENTLY REQUIRED WORK ITEM"

**No other genuinely unfinished work was found.** Everything else inspected in this audit (Gates 0/1/2, RAM canonicalization, variant-suffix handling, outlier detection, trusted-retailer logic and coverage, merchant URL resolution, frontend state machine) is complete and test-backed.

---

## 10. Recommended Next Decision

**Currently complete:** the entire matching/quality/ranking/URL-resolution pipeline described in §3, closed and live-validated.

**Genuinely unfinished:** a second live data provider (Amazon and/or Flipkart) — see §9. This is the only substantive open item.

**Requires an external/business decision, not engineering:** whether to pursue Amazon integration at all depends on PricePulse first generating real Amazon affiliate sales volume — an outcome of running the product, not of writing more code. Whether Flipkart integration is worth pursuing depends on directly confirming current Affiliate API terms with Flipkart, which is a business/ops action, not a coding task.

**Requires technical design before implementation (if pursued):** Flipkart integration specifically would need a new provider sub-architecture (scheduled feed ingestion + local index) designed and reviewed before any code is written — this is bigger than "fill in the stub."

**Can safely remain untouched:** the entire comparison engine, matching gates, quality scoring, ranking, trusted-retailer logic, and merchant URL resolver — all closed, tested, and should not be reopened absent a concrete new defect.

There is currently no repo-documented "next phase" to simply pick up and start. The next decision is a business/ops one (Amazon sales volume, Flipkart terms confirmation), not an engineering one.

---

## 11. Phase/Documentation Reconciliation

| Historical Reference | Actual Meaning | Governing Document | Current Status |
|---|---|---|---|
| "Phase 2" (report-file numbering) | Gate 1 identity-matching precision fix, then Gate 2 offer-quality build + validation | `PHASE2_PRECISION_FIX_REPORT.md`, `PHASE2_GATE2_OFFER_QUALITY_REPORT.md`, `PHASE2_GATE2_VALIDATION_REPORT.md` | Complete |
| "Phase 3" (report-file numbering) | Merchant URL resolution & direct buy links | `PHASE3_MERCHANT_URL_RESOLUTION_REPORT.md` | **Complete / Closed** (§4) |
| "Phase 4" (report-file numbering) | Live-data review fixes (title/RAM matching edge cases found in a real run) | `PHASE4_LIVE_FIXES_REPORT.md` | Complete |
| "Phase 5" (report-file numbering) | RAM canonicalization audit | `PHASE5_RAM_CANONICALIZATION_REPORT.md` | Complete |
| "Phase 7", "9", "10", "11", "12", "13", "14", "16", "18" (in-code comment numbering) | Scattered individual task numbers embedded in code comments across `urlResolver.js`, `qualityScorer.js`, `offerQuality.test.js`, etc. (e.g. in-code "Phase 11" = SSRF/URL safety, in-code "Phase 18" = "never guess a domain") | No single `.md` file — only inline code comments | These describe already-implemented, already-tested behavior baked into the current code (see §3/§4); they do **not** correspond to the report-file numbers above despite overlapping numerals |
| "Phase 6" (conversational/session numbering, this project's own memory) | Variant-suffix/chipset-context matching fix | No dedicated `.md` report exists — evidenced only by `tests/matching/variantSuffixContext.test.js` | Complete (test-verified) |
| "Phase 7" (conversational/session numbering) | Offer-quality outlier detection + savings integrity | No dedicated `.md` report exists — evidenced only by `tests/matching/phase7OfferQualityAndOutliers.test.js` | Complete (test-verified) |
| "Phase 8" (conversational/session numbering) | Trusted-retailer-first display layer | No dedicated `.md` report exists — evidenced by `providers/merchants/merchantRegistry.js` + `tests/retailers/trustedRetailerRegistry.test.js` | Complete (test-verified) |
| "Phase 8.1" (conversational/session numbering) | Bounded adaptive trusted-retailer coverage + frontend state-machine overhaul | No dedicated `.md` report exists — evidenced by `comparison/trustedRetailerCoverage.js` + `tests/retailers/trustedRetailerCoverage.test.js` + `js/compare.js` | Complete (test-verified) |
| "IMPLEMENTATION_REPORT.md" (untitled/no phase number) | The original V1→V2 architecture rewrite (provider abstraction, `comparison/` directory structure) that everything above was subsequently built on top of | `IMPLEMENTATION_REPORT.md` | Complete (foundational) |
| "PRODUCT_TYPE_FIX_REPORT.md" (untitled/no phase number) | Gate 0 product-type-conflict fix (predates or sits alongside the "Phase 2" report-numbering) | `PRODUCT_TYPE_FIX_REPORT.md` | Complete |

**No authoritative project-wide phase ledger currently exists.** The three numbering schemes above (report-file numbers, in-code comment numbers, and this project's own conversational/session numbers) were each locally consistent within their own origin but were never reconciled against each other before now. This document is the first attempt at that reconciliation and should be treated as authoritative going forward — future work should reference specific `.md` filenames or specific test files, not bare "Phase N," to avoid recreating this ambiguity.

---

## 12. Repository Integrity

- **`.git` exists:** **No.** Confirmed via `git status` → `fatal: not a git repository (or any of the parent directories): .git`. This is an extracted project directory, not a git working copy.
- **Current branch:** N/A — no git repository.
- **Working tree state:** N/A — no git repository. (File-level integrity was instead verified in this and prior sessions via SHA-256 hashing of specific files before/after edits, where that mattered.)
- **Recent commits:** N/A — no git history exists in this environment.
- **Uncommitted changes:** N/A — cannot be determined without git. If this repository is actually under version control on the machine it originated from, that history is not present in this working copy and this document cannot speak to it.
- **Is this environment actually a Git repository:** No.

---

## 13. Current Project Snapshot

```
PROJECT: PricePulse V2

CURRENT STATE:
- Node.js/Express backend, static HTML/CSS/JS frontend
- Single live data provider: Google Shopping via Serper
- Full matching/quality/ranking/URL-resolution pipeline implemented and closed
- Merchant URL resolution: ENABLED (ENABLE_MERCHANT_URL_RESOLVER=true in working .env)
- 284/284 deterministic tests passing (verified fresh this session)

COMPLETED:
- Gate 0 (product type classification)
- Gate 1 (product identity / variant matching)
- Gate 2 (offer/price quality)
- RAM canonicalization
- Variant-suffix/chipset-context handling
- Offer-quality outlier detection / savings integrity
- Trusted-retailer-first logic + bounded adaptive coverage
- Merchant URL resolution (implemented, activated, regression-tested, live-validated, closed)
- Frontend IDLE/COMPARING/RESULTS/FULL_INTERNET state machine + centralized reset

OPEN:
- Second live data provider (Amazon and/or Flipkart) — see §9
- Minor .env.example documentation drift — optional housekeeping
- Confirmed-dead files (search_old.js, stores/merchantUrlResolver.js) awaiting an explicit delete decision

BLOCKED:
- Amazon direct integration — blocked on external Amazon Associates sales-volume precondition + unresolved policy fit
- Flipkart direct integration — blocked on unverified current API terms + needs new feed-ingestion architecture

OPTIONAL:
- .env.example comment corrections
- Dead-file removal
- Splitting matching/ranking test coverage into the empty tests/normalization/ and tests/ranking/ scaffold directories

DO NOT TOUCH:
- comparison/productIdentity.js, productTypeClassifier.js, variantMatcher.js, services/productMatcher.js (Gate 0/1 — locked, tested)
- comparison/offerQuality.js, qualityScorer.js, offerEligibility.js (Gate 2 — locked, tested)
- comparison/urlResolver.js, offerRanker.js, compareEngine.js, services/compareService.js (merchant URL resolution — closed, do not reopen absent a concrete new defect)
- routes/imageSearch.js, services/vision.js, services/search/ (AI Find — independent feature, out of scope for comparison work)

NEXT DECISION REQUIRED:
- Whether to pursue Amazon/Flipkart direct integration at all, and if so, which one first — this is a business/ops decision (sales volume, terms confirmation), not an engineering one, and should be resolved before any further code is written in this area.
```
