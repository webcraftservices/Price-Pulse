# PricePulse V2 — Phase 5: RAM Canonicalization Audit

## 1. Files inspected

`comparison/productIdentity.js` (`canonicalizeProduct`,
`extractCanonicalProduct`), `utils/numbers.js` (`extractRamAndStorage`
and every other extractor in the file), `services/productMatcher.js`
(the full `storage`/`ram` scoring blocks and `matchDecision` logic),
`comparison/compareEngine.js` (the canonical-product logging line),
`services/compareService.js`, `comparison/offerEligibility.js`,
`tests/matching/phase4LiveFixes.test.js`, `scripts/regression-tests.js`
(TEST S/T, the existing RAM tests), and every existing test file for any
single-digit-GB storage usage that a magnitude-based fix could disturb.

Traced the full flow by hand and, critically, **by direct execution** —
not just reading — at every stage:
`user query → canonicalizeProduct/extractCanonicalProduct →
extractRamAndStorage → sourceProduct.{ram,storage} → productMatcher's
storage/ram scoring blocks → primaryIssue/matchDecision → (unchanged)
offerEligibility → (unchanged) offerRanker`.

## 2. Root cause of the RAM canonicalization gap

**The originally-reported gap does not exist as described.** Direct
execution proves it:

```js
canonicalizeProduct({ name: "Samsung Galaxy S26 Ultra 12GB 256GB" })
// -> { ..., storage: "256gb", ram: "12gb", ... }   <- ram WAS already there
```

`extractCanonicalProduct` (used for any plain-text query — i.e. exactly
the `node scripts/run-live-tests.js query "..."` path the Phase 4 report
was looking at) has called `extractRamAndStorage(cleaned)` and included
`ram` in its return object since before Phase 4.
`canonicalizeProduct`'s other branch (already-branded input, e.g. AI
Find) *also* already calls `extractRamAndStorage` to fill any missing
`ram`/`storage` gap. **Both entry points were already correctly wired.**

**What actually caused the Phase 4 report's finding**: a single
diagnostic `console.log` line in `compareEngine.js` that printed
`{name, brand, model, storage, color}` — it simply never included `ram`
in the list of fields to print, even though the underlying
`canonicalProduct` object already had it. The *live console output*
looked like RAM was missing; the *actual data* never was. This is a
narrow logging-only bug, now fixed (§4).

**Two genuine, separate, narrow bugs were found instead**, via the
deeper investigation the ticket asked for (deliberately testing every
example in its own "EXPECTED RAM BEHAVIOR" and "CRITICAL MATCHING
REQUIREMENT" sections by direct execution, not assumption):

- **Bug A** — `extractRamAndStorage`'s single-unlabeled-token case always
  defaulted to "storage," even for a query like "Samsung Galaxy S26
  Ultra 12GB" (nothing else in the text) — contradicting the ticket's own
  stated expected output (`ram: "12gb", storage: null`). Confirmed by
  direct execution: it returned `{storage: "12gb", ram: null}` before
  this fix.
- **Bug B** — `productMatcher.js` had a `storage_unconfirmed` signal
  (added in Phase 4) but no equivalent `ram_unconfirmed` signal at all.
  A candidate that never mentioned RAM was silently scored as if RAM had
  been confirmed — no penalty, no primaryIssue, `matchDecision:
  "EXACT_MATCH"`, `confidence: 1`. This bug was **latent/invisible**
  before Phase 5 specifically because `sourceProduct.ram` was so rarely
  populated in the reviewed live captures' printed logs — but it was
  never actually inactive; it was just untested for the unconfirmed case
  because nobody had looked at it with `ram` actually populated. Once
  properly exercised, it reproduced exactly the concern the ticket's
  "CRITICAL MATCHING REQUIREMENT" section warned about.
- **Bug C** (found alongside B, same code region) — a RAM mismatch's
  score cap (`Math.min(score, 0.85)`) lands exactly on the `EXACT_MATCH`
  threshold (`confidence >= 0.85`), so a candidate with the *wrong* RAM
  could still display as `EXACT_MATCH`. Confirmed by direct execution:
  `Samsung Galaxy S26 Ultra 8GB 256GB` against a `12GB 256GB` request
  scored exactly `confidence: 0.85, matchDecision: "EXACT_MATCH"` before
  this fix — precisely the outcome the ticket said "should NOT be
  treated as an exact variant match."

## 3. Whether RAM extraction could confuse other numeric attributes

Investigated and confirmed **safe by construction**, unchanged by this
task: `extractRamAndStorage`'s regex requires a literal `gb`/`tb`/`mb`
unit immediately after the digits (`/(\d+)\s?(gb|tb|mb)\b/`). This
structurally excludes every other numeric attribute the ticket asked
about:

| Attribute | Example | Why it can't match |
|---|---|---|
| Display size | `6.9-inch` | No `gb`/`tb`/`mb` unit at all |
| Camera megapixels | `200MP` | Unit is `mp`, not `mb`/`gb`/`tb` |
| Battery capacity | `5000mAh` | Unit is `mah`, not `mb` |
| Network generation | `5G` | Unit is bare `g`, not `gb` |
| Processor/model numbers | `Snapdragon 8`, `S26` | No unit suffix at all |

Verified directly (new test "9. unrelated numeric attributes...") with a
single combined title containing all five of these *plus* a genuine
`12GB RAM 256GB Storage` pair — confirms none of the noise numbers is
picked up, and the real RAM/storage pair still resolves correctly. This
required no code change — the existing regex was already correctly
unit-scoped; only the single-token fallback (Bug A) needed fixing.

## 4. Files changed

- **`utils/numbers.js`** — Bug A: single-unlabeled-token magnitude
  disambiguation.
- **`services/productMatcher.js`** — Bugs B and C: added the missing
  `ram_unconfirmed` branch (mirroring the existing `storage_unconfirmed`
  pattern exactly), and extended the existing Phase 4
  `EXACT_MATCH`→`STRONG_MATCH` label-downgrade check to also cover
  `ram_unconfirmed` and `ram_mismatch`.
- **`comparison/compareEngine.js`** — the logging-only fix: added `ram`
  to the `[COMPARE] Canonical product:` diagnostic line.

**New:**
- **`tests/matching/ramCanonicalization.test.js`** — 17 deterministic
  tests covering the ticket's full 10-item test list plus the
  extraction/matching matrices from its "EXPECTED RAM BEHAVIOR" and
  "CRITICAL MATCHING REQUIREMENT" sections.

**Not touched**: `canonicalizeProduct`/`extractCanonicalProduct` (already
correct — confirmed by investigation, not modified), Gate 0/1/2 logic,
`hardReject` semantics, `offerEligibility.js`, `offerRanker.js`,
`savings`, URL resolution, the Phase 4 `roundCurrency`/live-test-script
fixes.

## 5. Exact logic changed

**Bug A fix** (`utils/numbers.js`): in the `tokens.length === 1` branch,
an unlabeled figure now only defaults to storage if either its unit is
`tb`/`mb`, or its unit is `gb` and its numeric value exceeds a new
`RAM_ONLY_MAX_PLAUSIBLE_GB` constant (24 — the highest RAM size that
ships in any mainstream phone/laptop today; the smallest realistic
storage tier, 32GB, sits safely above it). A `gb` figure at or below 24
is read as RAM instead. This is a magnitude heuristic, not a
category/product-type check — deliberately, since the function has no
knowledge of what kind of product it's parsing, consistent with every
other extractor in this file.

**Why this can't misclassify a genuine small storage figure**: verified
directly (test 8) that every realistic single storage mention — 32GB,
64GB, 128GB, 256GB, 512GB, 1TB, 2TB — is completely unaffected (all stay
`storage`, byte-for-byte the pre-existing behavior). The only values that
changed classification are ≤24GB `gb`-unit figures, which were never a
realistic standalone storage capacity in the first place — they were
being systematically misread as storage before this fix, not correctly
read.

**Bugs B/C fix** (`services/productMatcher.js`): added an `else` branch
to the `if (sourceProduct.ram)` block — when the candidate title has no
RAM figure at all, apply the same `-0.05` penalty and
`primaryIssue = "ram_unconfirmed"` that the existing (Phase 4) storage
block already applies for the parallel case. Then extended the existing
Phase 4 label-only downgrade (`if (matchDecision === "EXACT_MATCH" &&
primaryIssue === "storage_unconfirmed") matchDecision = "STRONG_MATCH"`)
to also fire for `"ram_unconfirmed"` and `"ram_mismatch"`. **Numeric
confidence, hardReject, and every eligibility rule are completely
untouched by this** — verified with a dedicated "eligibility control"
test showing a RAM-mismatch/unconfirmed offer remains exactly as
eligible for `bestOffer` as before; only the displayed string changed.

## 6. Tests added

`tests/matching/ramCanonicalization.test.js` — 17 tests, covering the
ticket's exact 10-item list:

| # | Covers |
|---|---|
| 1 | 12GB + 256GB extraction |
| 2 | 12GB + 512GB extraction |
| 3 | 16GB + 1TB extraction |
| 4 | Storage-only query |
| 5 | RAM-only query (the fixed Bug A case) |
| 6 | RAM mismatch candidate (fixed Bug C) |
| 7 | RAM-unconfirmed candidate (fixed Bug B) |
| 8 | Storage extraction unaffected (32GB–2TB, all realistic tiers) |
| 9 | Unrelated numbers never parsed as RAM (display/camera/battery/5G/CPU) |
| 10 | Regression: existing Phase 4 Samsung/iPhone behavior unchanged |
| + | `canonicalizeProduct` wiring confirmation (both entry points) |
| + | Exact-match control (both RAM and storage confirmed) |
| + | Eligibility-unaffected control |
| + | Gate 1 hard-reject controls (variant/generation still unaffected) |

## 7. Full test results

| Suite | Result |
|---|---|
| `tests/matching/productTypeConflict.test.js` (Gate 0) | 51/51 |
| `tests/matching/productIdentityConflict.test.js` (Gate 1) | 38/38 |
| `tests/matching/offerQuality.test.js` (Gate 2) | 20/20 |
| `tests/matching/phase4LiveFixes.test.js` | 8/8 |
| `tests/matching/ramCanonicalization.test.js` (**new**) | **17/17** |
| `tests/comparison/searchPlanner.test.js` | 6/6 |
| `tests/urls/urlRecognition.test.js` | 11/11 |
| `tests/urls/merchantUrlResolution.test.js` | 22/22 |
| `scripts/regression-tests.js` | 32/32 |
| `scripts/regression-dedup-test.js` | PASS |
| `scripts/replay-reported-live-data.js` | PASS |

**205/205 automated tests pass (up from the 188/188 Phase 4 baseline).
Zero existing tests modified or removed.**

## 8. Live Samsung result

**LIVE TEST: BLOCKED.**

This sandbox has no `SERPER_API_KEY` anywhere (`find / -iname .env` and
`env | grep -i serper` both empty — re-checked fresh for this task).
The ticket describes a Windows machine with a real `.env` already
configured — that is not this environment. I reinstalled `node_modules`
(confirming dependencies aren't the blocker) and ran the exact command
to verify the code itself is correct:

```
$ node scripts/run-live-tests.js query "Samsung Galaxy S26 Ultra 12GB 256GB"
[COMPARE] Canonical product: {"name":"Samsung Galaxy S26 Ultra 12GB 256GB","brand":"Samsung","model":"Galaxy S26 Ultra","storage":"256gb","ram":"12gb","color":null}
[COMPARE] Store: google_shopping status: unavailable (SERPER_API_KEY is not configured.)
--- THREW ---
message: Couldn't reach the price comparison service right now. Please try again in a moment.
statusCode: 502
```

Note the log line now correctly shows `"ram":"12gb"` — direct
confirmation the logging fix (§4) works in the real invocation path, not
just in isolated testing. This is not a live price-comparison result and
I am not claiming one; it fails at the exact same credential step every
prior phase's live-test attempt has failed at in this sandbox. **Must be
re-run on the machine with the real `.env`.**

## 9. Live iPhone result

**LIVE TEST: BLOCKED** — identical reason as §8:

```
$ node scripts/run-live-tests.js query "Apple iPhone 17 Pro 256GB"
[COMPARE] Canonical product: {"name":"Apple iPhone 17 Pro 256GB","brand":"Apple","model":"iPhone 17 Pro","storage":"256gb","ram":null,"color":null}
[COMPARE] Store: google_shopping status: unavailable (SERPER_API_KEY is not configured.)
--- THREW ---
message: Couldn't reach the price comparison service right now. Please try again in a moment.
statusCode: 502
```

`"ram":null` here is correct — the iPhone query text never mentions a
RAM figure, so nothing should be inferred (consistent with §3's "never
guess" requirement).

**Offline substitute** (direct execution, shown in full in §2/§5 above)
reproduces every scenario from both live datasets exactly as the ticket
specified, and is captured permanently in
`tests/matching/ramCanonicalization.test.js`.

## 10. Remaining issues

- **Live validation is still blocked by environment, not code** — same
  root cause as every prior phase's report for this project. All fixes
  are proven via direct execution and a permanent test suite; the actual
  live commands must be run on the machine with the real credential.
- **The `RAM_ONLY_MAX_PLAUSIBLE_GB = 24` threshold is a deliberate,
  documented trade-off**, not a perfect rule. A hypothetical future
  device with >24GB of RAM mentioned as a lone unlabeled figure would
  still default to "storage" (matching today's pre-existing behavior,
  not a new failure). A hypothetical device advertised with ≤24GB of
  *storage* as a lone figure (extremely rare/legacy) would now be
  misread as RAM. Both edges are inherent to the fact that a single bare
  number is genuinely ambiguous without more context — the threshold was
  chosen to match every example the ticket itself gave and to leave
  every existing realistic storage tier (32GB and up) completely
  unaffected, verified directly (test 8).
- **`STRONG_MATCH` now covers three distinct underlying causes**
  (merely-confident 0.75–0.85 identity match, `storage_unconfirmed`, and
  now `ram_unconfirmed`/`ram_mismatch`) — same observation the Phase 4
  report already flagged for `storage_unconfirmed` alone, now broadened.
  Still intentional per the ticket's own suggested semantics and the
  "be conservative" instruction; a future phase might want a more
  granular decision value if the frontend ever needs to distinguish
  these causes explicitly.
