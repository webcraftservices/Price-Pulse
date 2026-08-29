# PricePulse V2 — Phase 4: Live-Data Review Fixes

## 1. Root cause of the iPhone test failure

**Not an engine bug — the live test SCRIPT's own assertion was stale.**

`scripts/run-live-tests.js`'s `summarize()` computed its "eligible for
bestOffer" set as:

```js
const eligible = confident.filter((r) => r.price !== null && r.availability !== "out_of_stock");
```

This predates the Phase 2 Offer/Price Quality gate — it has no idea
`usableForBestOffer` exists. So it counted the refurbished icluster
technologies offer (₹113,900) as "eligible," computed `min = 113900`,
and flagged a FAIL because the real engine (correctly) picked MRV
electronics (₹117,999) instead — the refurbished offer's
`usableForBestOffer: false` correctly excluded it, exactly as designed
in Phase 2. The engine was right; the test's copy of the eligibility
rule was incomplete and had drifted out of sync with
`offerEligibility.js`'s actual `isEligibleForComparison`, which has
required `usableForBestOffer !== false` since Phase 2.

## 2. Files changed

- **`scripts/run-live-tests.js`** — Issue #1 fix.
- **`utils/numbers.js`** — added `roundCurrency` (Issue #2).
- **`comparison/offerRanker.js`** — applies `roundCurrency` to `savings`;
  strengthened the doc comment to state the definition explicitly
  (Issue #2).
- **`services/compareService.js`** — applies `roundCurrency` to every
  offer's `price` field at the API boundary (Issue #2).
- **`services/productMatcher.js`** — `matchDecision` label fix for
  `storage_unconfirmed` (Issue #3).

**New:**
- **`tests/matching/phase4LiveFixes.test.js`** — 8 deterministic tests
  reproducing all three reported scenarios exactly (including the exact
  reported numbers: savings 50643.81, the 47562.79999999999 float
  artifact).

**Not touched**: Gate 0/1/2 matching/scoring logic itself, hardReject
rules, `offerEligibility.js`'s eligibility rules, `offerRanker.js`'s
selection logic, URL resolution, savings' *definition* (only its
floating-point presentation).

## 3. Exact logic changed

**Issue #1** (`scripts/run-live-tests.js`): replaced the hand-rolled
eligibility filter with a call to the real, exported
`isEligibleForComparison` (via a small field-name adapter — the public
API response uses `url`/no-`hardReject`, the internal function expects
`productUrl`/`hardReject` — see the adapter's own comment for why it's
needed). This means the check can never drift out of sync with the
engine's actual rule again, and is fully generic (works for future
products/reasons for ineligibility, not just refurbished offers).

**Issue #2**: no business-logic change — `savings` is still exactly
`max(eligible prices) - min(eligible prices)`, confirmed correct (see
§4). Added `roundCurrency(value) = Math.round((value + EPSILON) * 100) / 100`
in `utils/numbers.js`, applied to `savings` in `offerRanker.js` and to
every offer's `price` in `compareService.js`'s `toFrontendOffer` — i.e.
at the actual API boundary, not deep inside matching (where full
precision is harmless and unnecessary to touch).

**Issue #3**: in `productMatcher.js`'s `computeMatchConfidence`, after
computing `matchDecision` from the numeric confidence as before, one
additional check: if the computed label is `"EXACT_MATCH"` AND
`primaryIssue === "storage_unconfirmed"`, downgrade the **label only**
to `"STRONG_MATCH"`. The numeric `confidence`, `hardReject`, and
therefore every bestOffer/bestDirectOffer/savings eligibility decision
(which only ever reads the numeric confidence, never the string label)
are completely unaffected.

## 4. Was the Samsung savings value actually a bug?

**No — audited and confirmed correct**, not a bug.

`offerRanker.js`'s `savings` has always been `max(eligible prices) -
min(eligible prices)` — the spread across the *entire* eligible/trusted
price range for the product, not "bestOffer vs. one specific benchmark
merchant." There is no single fixed "benchmark" field anywhere in the
codebase (checked `savings` usages across `compareService.js`, the
frontend `js/compare.js`, and every test that asserts a `savings` value
— all consistent with max−min).

The ticket's own math confirms this once the right operands are used:
`89355.19 (Mygsm.me, min) ` vs. **`139999` (Manik Mobile Shopee, the
actual max of the eligible set)**, not `124999` (Amazon) as the ticket
assumed: `139999 − 89355.19 = 50643.81` — exactly the reported value.
The ticket's own iPhone example independently confirms the same formula:
`165561.80 − 117999 = 47562.8`, matching the reported
`47562.79999999999` (modulo the float artifact, which was real and is
now fixed — see §2).

Reproduced exactly in the new test suite (`phase4LiveFixes.test.js`,
"Samsung repro" test) using the ticket's own reported merchants/prices —
`result.savings === 50643.81`.

## 5. What changed regarding `storage_unconfirmed` / `EXACT_MATCH`

**Architecture preserved, one label corrected.** The existing
architecture already correctly distinguished "product identity" from
"exact variant identity" at the *numeric/eligibility* level — a
storage-unconfirmed offer was never treated as more eligible than it
should be, and was never silently assumed to be the exact requested
storage for any actual decision (bestOffer selection only ever reads the
raw confidence number, not any label). The one real gap was purely
**display semantics**: the `matchDecision` STRING could say
`"EXACT_MATCH"` for an offer that never confirmed a requested attribute
at all, which overstates what was verified to a person reading it.

Per the ticket's own suggested (and here, precisely followed) semantics:
- `EXACT_MATCH` now genuinely means every requested variant attribute
  was confirmed.
- `STRONG_MATCH` now correctly represents "strong product identity, one
  requested attribute (storage) unconfirmed" — exactly the ticket's own
  proposed definition.
- `POSSIBLE_MATCH`/`HARD_REJECT` semantics: **unchanged** — no reason to
  touch them, since neither was implicated in the reported issue.

This is deliberately conservative and narrowly scoped, per the ticket's
explicit "be conservative" instruction: **only** the
`EXACT_MATCH` + `storage_unconfirmed` combination is affected.
`storage_mismatch` was already correctly demoted well below EXACT_MATCH
range before this fix (score capped at 0.15) and needed no change.
`ram_mismatch`/`ram_unconfirmed` were not touched — the live data showed
`sourceProduct.ram` is not currently populated by
`canonicalizeProduct`/`productIdentity.js` for either reported query (the
canonical-product JSON in both live captures has no `ram` field at all,
even though the Samsung query text included "12GB"), so RAM was never a
live factor in these two specific reported EXACT_MATCH cases — this is
noted as a separate, pre-existing gap in §9, not something this
conservative fix attempts to address.

**Verified no false negatives introduced**: the genuinely-confirmed
iPhone case (MRV electronics, "Cosmic Orange ... 256GB" — storage
literally present in the title) still correctly reaches `EXACT_MATCH`
(new control test, `phase4LiveFixes.test.js`).

## 6. iPhone live test result

**Could not be run against the real Serper API from this environment.**
`find / -iname .env` (depth 5) and `env | grep -i serper` both come back
completely empty in this sandbox — confirmed fresh for this task, not
assumed from a prior report. This ticket's own instructions describe a
Windows machine (`C:\Users\Nishant\Desktop\...`) with a real `.env`
already in place — that is the user's own machine, not this sandbox,
which has no credential at all.

I reinstalled `node_modules` (122 packages, confirming dependencies
aren't the blocker) and ran the exact command to at least verify the
code itself is correct and error-free:

```
$ node scripts/run-live-tests.js query "Apple iPhone 17 Pro 256GB"
[COMPARE] Store: google_shopping status: unavailable (SERPER_API_KEY is not configured.)
--- THREW ---
message: Couldn't reach the price comparison service right now. Please try again in a moment.
statusCode: 502
```

This confirms the script runs correctly end-to-end up to the exact point
a real API key would be needed — no syntax errors, no crashes from any
of the changes in this task. It is **not** a live result, and I am not
claiming one. **This must be re-run on the actual machine with the real
`.env`** to get genuine numbers; the offline reproduction below is the
verifiable substitute.

**Offline reproduction** (`phase4LiveFixes.test.js`, "iPhone repro"
test) — the exact reported titles/prices/merchants, through the real,
unmodified engine:

```
[COMPARE] OFFER QUALITY:
  Merchant: icluster technologies
  Candidate: Refurbished Apple iPhone 17 Pro (eSIM) Deep blue / 256GB / Excellent
  Price: INR 113900
  Decision: SUSPICIOUS
  Usable for best offer: false
  Reasons: USED_OR_REFURBISHED
[COMPARE] Best offer: MRV electronics INR 117999

bestOffer: MRV electronics ₹117999   ✓ matches the ticket's expected result exactly
```

## 7. Samsung live test result

**Same limitation as §6** — could not be run live from this sandbox:

```
$ ENABLE_MERCHANT_URL_RESOLVER=true DEBUG_COMPARE=true node scripts/run-live-tests.js query "Samsung Galaxy S26 Ultra 12GB 256GB"
[COMPARE] Store: google_shopping status: unavailable (SERPER_API_KEY is not configured.)
--- THREW ---
message: Couldn't reach the price comparison service right now. Please try again in a moment.
statusCode: 502
```

**Offline reproduction** (`phase4LiveFixes.test.js`, "Samsung repro"
test) — the exact reported merchants/prices:

```
[COMPARE] Best offer: Mygsm.me INR 89355.19
bestOffer: Mygsm.me ₹89355.19, savings: 50643.81   ✓ matches the ticket's reported values exactly
```

Confirms the Samsung behavior the ticket described as "currently
passing" continues to pass unchanged, and that the reported savings
figure is correct under the audited (unchanged) definition.

## 8. Unit/integration test results

| Suite | Result |
|---|---|
| `tests/matching/productTypeConflict.test.js` (Gate 0) | 51/51 |
| `tests/matching/productIdentityConflict.test.js` (Gate 1) | 38/38 |
| `tests/matching/offerQuality.test.js` (Gate 2) | 20/20 |
| `tests/matching/phase4LiveFixes.test.js` (**new**) | **8/8** |
| `tests/comparison/searchPlanner.test.js` | 6/6 |
| `tests/urls/urlRecognition.test.js` | 11/11 |
| `tests/urls/merchantUrlResolution.test.js` | 22/22 |
| `scripts/regression-tests.js` | 32/32 |
| `scripts/regression-dedup-test.js` | PASS |
| `scripts/replay-reported-live-data.js` | PASS |

**188/188 automated tests pass. Zero existing tests modified.**

## 9. Remaining issues before the next phase

- **Live validation is still blocked by environment, not code** — this
  sandbox has no `SERPER_API_KEY` anywhere. All three fixes are proven
  via exact offline reproductions of the reported live data, but the
  actual live commands (§6/§7) must be re-run on the machine that has
  the real `.env` to get genuine current numbers.
- **`sourceProduct.ram` is not currently populated** by
  `canonicalizeProduct`/`productIdentity.js` for a query like "Samsung
  Galaxy S26 Ultra 12GB 256GB" — both live captures show `canonicalProduct`
  with a `storage` field but no `ram` field at all, even though the RAM
  figure is present in the query text. This means the existing RAM
  matching code in `productMatcher.js` (the `if (sourceProduct.ram)`
  block) is effectively dead for these queries today — not a bug this
  ticket asked me to fix (explicitly conservative scope: "storage" was
  the reported concern, not RAM extraction), but worth flagging as a
  real gap for a future phase, since a "12GB" request could in principle
  currently match an 8GB or 16GB listing without any RAM-based
  demotion at all if the title happens to omit a RAM figure the matcher
  would otherwise have caught.
- **`STRONG_MATCH` is now used for two different situations** — a
  merely-confident (0.75–0.85) match, and now also a `storage_unconfirmed`
  match that would otherwise have scored ≥0.85. Both are legitimately
  "strong identity, something not fully nailed down," so this is
  intentional per the ticket's own suggested semantics, but a future
  phase might want a more granular label (e.g. a dedicated
  `EXACT_IDENTITY_UNCONFIRMED_VARIANT` decision) if the frontend ever
  needs to distinguish the two STRONG_MATCH causes explicitly. Not done
  here, per the "be conservative, don't make broad changes" instruction.
