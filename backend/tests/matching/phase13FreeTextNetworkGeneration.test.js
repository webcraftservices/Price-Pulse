/**
 * Phase 13 — Free-Text Network-Generation Evidence Preservation
 * ------------------------------------------------------------------
 * VERDICT: B — Gap was not reproducible; no code change was made.
 *
 * Phase 12 correctly observed that canonicalizeProduct's free-text
 * branch (extractCanonicalProduct, comparison/productIdentity.js) runs
 * stripDescriptors() — which removes "4g"/"5g" — before computing `core`,
 * and assigns that stripped `core` to BOTH .productName and .model. In
 * isolation this is true: detectNetworkGeneration(canonical.model) does
 * return null for a free-text "Samsung Galaxy M14 5G" query.
 *
 * But Phase 12's conclusion (that this breaks the end-to-end conflict
 * check) does not hold, because extractCanonicalProduct ALSO returns
 * `.name: cleaned` — the lightly-cleaned title, deliberately NOT run
 * through stripDescriptors() — and evaluateVariantIdentity's
 * sourceIdentityText is built as:
 *   [sourceProduct.model, sourceProduct.productName, sourceName]
 *     .filter(Boolean).join(" ")
 * where sourceName falls back to `sourceProduct.name` FIRST. So the
 * intact "5g"/"4g" token already reaches detectNetworkGeneration via
 * .name, through a pre-existing fallback that was never specific to
 * this phase — it was already there to support Gate 0 classification
 * and jaccard title-overlap for the exact same reason.
 *
 * This suite exists to PROVE that with real code (not to fix anything),
 * and to lock the behavior down as a permanent regression guard, since
 * it depends on an interaction between two functions (extractCanonical-
 * Product and evaluateVariantIdentity) that isn't obvious from reading
 * either one in isolation.
 *
 * USAGE: node tests/matching/phase13FreeTextNetworkGeneration.test.js
 */

const assert = require("assert");
const { canonicalizeProduct } = require("../../comparison/productIdentity");
const { computeMatchConfidence } = require("../../services/productMatcher");
const { detectNetworkGeneration } = require("../../utils/text");

const results = [];
function test(name, fn) {
    try {
        fn();
        results.push({ name, pass: true });
        console.log(`PASS  ${name}`);
    } catch (err) {
        results.push({ name, pass: false, error: err.message });
        console.log(`FAIL  ${name}`);
        console.log(`      ${err.message}`);
    }
}

function freeText(name) {
    return canonicalizeProduct({ name });
}

// -----------------------------------------------------------------
// Test 1/2 — canonicalization retains generation info (via .name,
// NOT via .model/.productName — that distinction is the whole point)
// -----------------------------------------------------------------
test("Test 1: free-text '...4G' retains generation evidence in .name", () => {
    const c = freeText("Samsung Galaxy M14 4G");
    assert.strictEqual(detectNetworkGeneration(c.model), null, "confirms Phase 12's isolated observation: .model IS stripped");
    assert.strictEqual(detectNetworkGeneration(c.name), "4g", ".name preserves it — this is what evaluateVariantIdentity actually reads");
});

test("Test 2: free-text '...5G' retains generation evidence in .name", () => {
    const c = freeText("Samsung Galaxy M14 5G");
    assert.strictEqual(detectNetworkGeneration(c.model), null);
    assert.strictEqual(detectNetworkGeneration(c.name), "5g");
});

// -----------------------------------------------------------------
// Test 3/4 — free-text explicit conflict, both directions (Case A/C)
// -----------------------------------------------------------------
test("Test 3: free-text 'M14 4G' request rejects a 'M14 5G' candidate", () => {
    const r = computeMatchConfidence(freeText("Samsung Galaxy M14 4G"), "Samsung Galaxy M14 5G");
    assert.strictEqual(r.hardReject, true);
    assert.strictEqual(r.primaryIssue, "network_generation_mismatch");
});

test("Test 4: free-text 'M14 5G' request rejects a 'M14 4G' candidate (reverse)", () => {
    const r = computeMatchConfidence(freeText("Samsung Galaxy M14 5G"), "Samsung Galaxy M14 4G");
    assert.strictEqual(r.hardReject, true);
    assert.strictEqual(r.primaryIssue, "network_generation_mismatch");
});

// -----------------------------------------------------------------
// Test 5 — source silent remains compatible (Case B), free-text form
// -----------------------------------------------------------------
test("Test 5: free-text silent source ('S26 Ultra') still matches a '5G' candidate", () => {
    const r = computeMatchConfidence(freeText("Samsung Galaxy S26 Ultra"), "Samsung Galaxy S26 Ultra 5G");
    assert.strictEqual(r.hardReject, false);
    assert.notStrictEqual(r.primaryIssue, "network_generation_mismatch");
    assert.strictEqual(r.matchDecision, "EXACT_MATCH");
});

// -----------------------------------------------------------------
// Test 6 — structured-input behavior unchanged (Phase 12 baseline)
// -----------------------------------------------------------------
test("Test 6: structured {brand, model: 'Galaxy M14 4G'} still rejects a 5G candidate", () => {
    const r = computeMatchConfidence(canonicalizeProduct({ brand: "Samsung", model: "Galaxy M14 4G" }), "Samsung Galaxy M14 5G");
    assert.strictEqual(r.hardReject, true);
    assert.strictEqual(r.primaryIssue, "network_generation_mismatch");
});

// -----------------------------------------------------------------
// Test 7 — existing flagship descriptor behavior remains intact
// -----------------------------------------------------------------
test("Test 7: structured silent source ('S26 Ultra') still matches '5G' candidate (Phase 9-11 baseline)", () => {
    const r = computeMatchConfidence(canonicalizeProduct({ brand: "Samsung", model: "Galaxy S26 Ultra", storage: "256GB" }), "Samsung Galaxy S26 Ultra 5G");
    assert.strictEqual(r.hardReject, false);
    assert.strictEqual(r.matchDecision, "STRONG_MATCH");
    assert.strictEqual(r.primaryIssue, "storage_unconfirmed");
});

// -----------------------------------------------------------------
// Test 8 — non-network descriptors remain unaffected (no accidental
// preservation/removal change from this phase, since no code changed)
// -----------------------------------------------------------------
test("Test 8: non-network descriptor ('Unlocked') is still stripped and never treated as a variant conflict", () => {
    const c = freeText("Samsung Galaxy M14 Unlocked");
    assert.strictEqual(c.model, "Galaxy M14", "descriptor stripping for non-network words is untouched by this phase");
    const r = computeMatchConfidence(c, "Samsung Galaxy M14");
    assert.strictEqual(r.hardReject, false, "'Unlocked' must never cause a false variant/generation rejection");
});

console.log("\n=== SUMMARY ===");
const passed = results.filter((r) => r.pass).length;
console.log(`${passed}/${results.length} passed`);
if (passed !== results.length) process.exitCode = 1;
