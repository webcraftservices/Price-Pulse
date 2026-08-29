# PricePulse V2 — Phase 2 Precision Fix (Gate 1: Product Identity)

## 1. Root cause

Gate 0 (`comparison/productTypeClassifier.js`, from the prior fix) correctly
answers "is this candidate even the same **kind** of thing?" (phone vs.
motherboard). It never had a counterpart for "is this the same **model**?"

Inside `services/productMatcher.js`'s `computeMatchConfidence`, a wrong
generation/model-number/variant was only ever a **score cap** applied
partway through scoring:

```js
// (old code)
if (candidateVersionTokens.length > 0 && !sourceVersionTokens.some(...)) {
    score = Math.min(score, 0.2);          // <-- capped here
    primaryIssue = "generation_mismatch";
}
...
if (candidateStorage === sourceStorage) {
    score += 0.1;                           // <-- but recoverable here
}
if (candidateRam === sourceRam) {
    score += 0.05;                          // <-- and here
}
```

Two compounding problems:

1. **The cap wasn't final.** Brand match (+0.15) ran *before* the
   generation-mismatch cap, and storage/RAM/color bonuses ran *after* it,
   using plain `score +=`. For `"Samsung Galaxy S25 Ultra 256GB 12GB RAM"`
   against an S26 Ultra 256GB/12GB request: jaccard overlap (~0.6) + brand
   match (+0.15) → capped to 0.2 by the generation mismatch → then storage
   match (+0.1) and RAM match (+0.05) pushed it back up to **0.35**.
2. **Eligibility never looked at the cap.** `offerEligibility.isEligibleForResults`
   only checked `hardReject` (a boolean set exclusively by Gate 0). Any
   non-hard-rejected offer — 0.35, 0.2, even 0.05 — still flowed into
   `results` / `possibleMatches` / final offers via `offerRanker.buildComparison`.

That's exactly how `Samsung Galaxy S25/S24/S21 Ultra` and `Samsung Galaxy
A56` kept reappearing as `matchDecision: UNCERTAIN`, `isPossibleMatch:
true` for an S26 Ultra request in the reported live run — despite being a
different generation/family entirely, and despite the storage/RAM figures
happening to match.

## 2. Architecture change

Added **Gate 1 — Product Identity (model/generation/variant)**, sitting
between Gate 0 (product type) and the existing token-overlap/storage/RAM/
color scoring, matching the pipeline the spec asked for:

```
Candidate
   ↓
Gate 0: Product Type            (unchanged — comparison/productTypeClassifier.js)
   ↓
Gate 1: Product Identity        (NEW — evaluateVariantIdentity in services/productMatcher.js)
   ↓
Gate 2/3: Specifications        (unchanged — storage/RAM/color soft demotion)
   ↓
Gate 4: Existing token scoring  (unchanged — jaccard/brand/model bonuses)
   ↓
Final match decision
```

`evaluateVariantIdentity(sourceProduct, candidateTitle)` runs a boolean
decision — not a score nudge — using the **existing** token-extraction
utilities (`extractModelNumberTokens`, `extractPlainModelNumbers`,
`extractVariantSuffixes` in `utils/numbers.js`, unchanged), in this order:

1. **Generation tokens** (`s26` vs `s25`, `m4` vs `m3`, `ps5` vs `ps4`) —
   letter+digit tokens glued together, no space.
2. **Bare model numbers** (`15`/`16`/`17` for iPhone, `990`/`980` for SSDs,
   `5070`/`4070` for GPUs) — digits with no letter prefix and no GB/TB/MB
   unit attached.
3. **Variant/family suffix words** (Ultra/Plus/Pro/Max/Air/Slim/Ti/Evo/...)
   — symmetric: missing OR extra variant words on either side both count
   (`S26 Ultra` vs plain `S26` is exactly as wrong as plain `S26` vs `S26
   Ultra`).

Each check only fires when **both sides** have a token to compare —
absence of signal is never treated as a conflict (this was already the
rule in the old capping code; Gate 1 preserves it exactly). A hit at any
of the three steps returns `{ hardReject: true, primaryIssue, reason }`
immediately, **before** any jaccard/brand/storage/RAM/color scoring runs —
so nothing downstream can ever recover it. The old capping blocks for
these three signals were deleted from `computeMatchConfidence`'s scoring
section entirely (they can no longer fire, since Gate 1 already filtered
those candidates out) — this closes the "recoverable cap" bug directly,
architecturally, rather than patching around it.

No changes were needed in `offerEligibility.js` or `offerRanker.js` — both
already treat any `hardReject: true` offer identically regardless of
*which* gate set it (Gate 0 or Gate 1), and already keep a hard-rejected
offer out of `results`, `possibleMatches`, `bestOffer`, `bestDirectOffer`,
and `savings`. That existing machinery is exactly what the spec's "a
rejected candidate must stay rejected" requirement needed — Gate 1 only
had to start setting `hardReject` correctly for these cases.

**Storage/RAM/color are deliberately untouched** — they remain soft
Gate-2/3 demotions (`storage_mismatch`, `ram_mismatch`), never hard
rejections, exactly as the spec requires ("Samsung Galaxy S26 Ultra 256GB
→ 512GB must NOT automatically become a hard reject").

## 3. Files changed

**New:**
- `tests/matching/productIdentityConflict.test.js` — 38 new deterministic
  tests: the full Samsung/iPhone/MacBook/GPU/PS5/SSD matrix from the spec,
  plus an end-to-end pipeline test that replays the exact reported bug
  (S26 Ultra request against a fixture containing every reported false
  positive) through the real, unmodified `compareByProduct`.

**Modified:**
- `services/productMatcher.js` — added `evaluateVariantIdentity` (Gate 1),
  wired it into `computeMatchConfidence` right after Gate 0, deleted the
  three now-dead capping blocks (generation/model-number/variant) from the
  scoring section, exported the new function.
- `utils/numbers.js` — added `"slim"`, `"ti"`, `"evo"` to
  `VARIANT_SUFFIX_WORDS` (PS5 Slim, RTX xx70 Ti, Samsung SSD EVO lines are
  named variant families in the spec's own test matrix that the existing
  word list didn't cover).
- `comparison/productTypeClassifier.js` — added `"cooling fan"` /
  `"replacement fan"` / `"fan replacement"` / `"case fan"` to the Gate 0
  accessory signal list (the spec's own RTX/PS5 test cases named these
  phrases explicitly; the existing list only had `"cooling accessory"` /
  `"cooling pad"` / `"water block"` / `"heatsink"`).
- `comparison/compareEngine.js` — generalized the rejected-offer log block
  (previously hardcoded `"Reason: PRODUCT_TYPE_CONFLICT"` for every
  rejection) to report the actual `matchIssue` for both gates, and added
  the `[COMPARE] PRODUCT IDENTITY: ... Decision: HARD_REJECT Reason: ...`
  line the spec asked for.
- `comparison/variantMatcher.js` — re-exported `evaluateVariantIdentity`
  for direct testability, alongside the existing `evaluateProductIdentity`.

## 4. Existing-test conflict: `scripts/regression-tests.js` Test J

**Conflict found and resolved as instructed** (identify → explain → add/
update a regression test for the intended behavior → smallest change):

Test J's original assertion required `"Samsung Galaxy S26 5G"` (no
"Ultra") to survive as a visible **possible match**
(`isPossibleMatch: true`, `matchIssue: "variant_mismatch"`) against an
`"S26 Ultra"` request — that was deliberate V2-era behavior, matching the
old soft-demotion-only policy.

The Phase 2 spec explicitly supersedes this ("Samsung Galaxy S26 Ultra and
Samsung Galaxy S26+ ... should NOT be considered a useful match" — the
same relationship as S26 Ultra vs. plain S26). Under Gate 1 this candidate
is now correctly `HARD_REJECT` / `variant_mismatch`, and — per the
existing, unmodified `offerEligibility`/`offerRanker` — is excluded from
`results` entirely rather than shown as a possible match.

Test J was updated (not silently — see the comment block directly above it
in `scripts/regression-tests.js`) to assert the new intended behavior: the
genuine S26 Ultra listing still scores 1.0/`EXACT_MATCH`, the plain-S26
listing is confirmed absent from `result.results`, and
`computeMatchConfidence` on that exact title is asserted to be
`HARD_REJECT` / `variant_mismatch` / confidence `0`. `bestOffer` and
`savings` assertions were kept and tightened (savings must not be inflated
by the now-excluded wrong-variant offer).

No other existing test needed to change — see the full pass/fail
accounting below.

## 5. Tests before / after / new

| Suite | Before | After |
|---|---|---|
| `tests/matching/productTypeConflict.test.js` (Gate 0) | 51/51 | 51/51 (unchanged) |
| `scripts/searchPlanner... / tests/comparison/searchPlanner.test.js` | 6/6 | 6/6 (unchanged) |
| `tests/urls/urlRecognition.test.js` | 11/11 | 11/11 (unchanged) |
| `scripts/regression-tests.js` (Test A–AF) | 32/32 | 32/32 (Test J updated, see §4; all others unchanged) |
| `scripts/regression-dedup-test.js` | PASS | PASS (unchanged) |
| `tests/matching/productIdentityConflict.test.js` (**new**, Gate 1) | — | **38/38** |

**Total: 100/100 pre-existing tests still pass, unmodified in behavior
except the one documented, deliberate Test J update; 38 new tests added,
all passing. 138/138 overall.**

## 6. Live test result

This sandbox has no `node_modules` installed and no route to
`serper.dev` (network egress is allow-listed to package
registries/GitHub only — confirmed by `node scripts/run-live-tests.js`
failing on `Cannot find module 'dotenv'` before it could even attempt a
network call). This is the same limitation the prior Gate-0 fix's report
already documented for this environment.

As the closest available substitute, `scripts/replay-reported-live-data.js`
(pre-existing, offline, replays the *exact* merchant names/titles/prices
originally reported) was run against the real, unmodified
`compareService.js`:

```
Cellspare present in result.results: false PASS (excluded)
bestOffer: Amazon ₹124999
bestOffer is Cellspare: PASS
savings: 39076.98 OK
```

That fixture only contained the Gate-0 motherboard false positive, not the
wrong-generation offers from the later part of the bug report — so the new
`tests/matching/productIdentityConflict.test.js`'s **"Samsung E2E"** test
is the direct, deterministic equivalent for Gate 1: it replays the
reported false positives (`S26+`, `S25 Ultra`, `S24 Ultra`,
`S21 Ultra 256GB 12GB RAM`, `A56`, plus the Cellspare motherboard) as a
Serper fixture through the real, unmodified `compareByProduct`, and
asserts the full pipeline output end to end:

```
[COMPARE] CONFIDENT MATCHES: 2 (Amazon, MRV electronics)
[COMPARE] POSSIBLE MATCHES: 1 (Croma)
[COMPARE] FINAL OFFERS: 3
[COMPARE] REJECTED (identity conflict): 6
[COMPARE] PRODUCT IDENTITY:
  Requested: Galaxy S26 Ultra
  Candidate: Samsung Galaxy S26+
  Decision: HARD_REJECT
  Reason: VARIANT_MISMATCH
[COMPARE] PRODUCT IDENTITY:
  Requested: Galaxy S26 Ultra
  Candidate: Samsung Galaxy S25 Ultra
  Decision: HARD_REJECT
  Reason: GENERATION_MISMATCH
[COMPARE] PRODUCT IDENTITY:
  Requested: Galaxy S26 Ultra
  Candidate: Samsung Galaxy S21 Ultra 256GB 12GB RAM
  Decision: HARD_REJECT
  Reason: GENERATION_MISMATCH
[COMPARE] PRODUCT IDENTITY:
  Requested: Galaxy S26 Ultra
  Candidate: Samsung Galaxy A56 5G Samsung
  Decision: HARD_REJECT
  Reason: GENERATION_MISMATCH
[COMPARE] PRODUCT IDENTITY:
  Candidate: Samsung Galaxy S26 Ultra 256GB 12GB RAM Motherboard PCB
  Decision: HARD_REJECT
  Reason: PRODUCT_TYPE_CONFLICT
Best offer: MRV electronics ₹94999
savings: 25000
```

- **Rejected candidates:** S26+, S25 Ultra, S24 Ultra, S21 Ultra
  256GB/12GB RAM, A56, motherboard/PCB — all 6, all `HARD_REJECT`, all
  fully absent from `results`.
- **Valid candidates:** the 3 genuine S26 Ultra listings (exact spec,
  incomplete spec, storage variant) — all present.
- **bestOffer:** MRV electronics ₹94,999 — the cheapest *genuine* S26
  Ultra offer, never the ₹25,000 A56 or ₹35,000 S21 Ultra.
- **Savings:** ₹25,000 (94,999 → 119,999 confident-tier spread), never
  inflated by an excluded wrong-model offer.

## 7. Success criteria — checked against the spec

- ✅ `S26 Ultra motherboard` — hard-rejected (Gate 0, unchanged).
- ✅ `S26 Ultra` (correct model) — remains a strong/valid match.
- ✅ `S26+` (wrong variant) — HARD_REJECT, does not survive as a possible match.
- ✅ `S25 Ultra` / `S24 Ultra` / `S21 Ultra` (wrong generation) — HARD_REJECT, do not survive.
- ✅ `A56` (wrong family) — HARD_REJECT, does not survive.
- ✅ `S26 Ultra 512GB` (spec mismatch) — retains soft-demotion behavior (never hard-rejected).
- ✅ `bestOffer` selected only from legitimate S26 Ultra products.
- ✅ Savings calculated only from legitimate comparison offers.
- ✅ All previously-passing tests remain green, except the one
  intentionally, visibly updated test (§4), because its old behavior
  directly contradicted the new spec.

## 8. Remaining known issues / non-goals

- **WH-1000XM4 vs WH-1000XM5**-style model numbers (digits glued directly
  to a trailing letter suffix with no separating space, e.g. `1000xm4`)
  aren't picked up by Gate 1's token extractors (neither the letter+digit
  regex, which requires the token to *start* with a letter, nor the
  bare-digit regex, which requires the digits to be an isolated word).
  This is pre-existing behavior (confirmed unchanged by
  `tests/urls/urlRecognition.test.js`'s XM4-vs-XM5 test, still passing
  via jaccard/brand scoring alone) and out of scope for this fix — the
  spec's own test matrix (S-series, iPhone, M-series, RTX, PS, SSD) is
  all letter+digit or bare-digit shaped and is fully covered.
- Gate 1 is intentionally conservative about *adding* new variant
  vocabulary (`slim`/`ti`/`evo`) to exactly what the spec's test matrix
  named, rather than guessing at a larger generic list, per the "do not
  create a giant lookup table" instruction — a real-world rollout would
  likely want to grow this list from production `matchIssue` logs.
- No live Serper validation was possible in this sandbox (see §6);
  `scripts/run-live-tests.js` should be re-run against the real API by
  whoever has `.env`/network access, using
  `node scripts/run-live-tests.js query "Samsung Galaxy S26 Ultra 12GB 256GB"`.
