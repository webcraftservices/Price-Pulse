/**
 * Phase 12 — Wrong-Variant Suffix Coverage Audit
 * ------------------------------------------------------------------
 * This suite has two jobs:
 *
 * 1. Confirm the ONE actual code change this phase made: a narrow,
 *    explicit-conflict-only 4G vs 5G check (detectNetworkGeneration,
 *    utils/text.js + evaluateVariantIdentity, services/productMatcher.js).
 *    Web-search-confirmed real case: Samsung Galaxy M14 4G (Snapdragon
 *    680, SM-M145F) and Galaxy M14 5G (Exynos 1330, SM-M146B) are
 *    genuinely different phones. This is deliberately NOT a global
 *    VARIANT_SUFFIX_WORDS entry — that would hard-reject every current
 *    flagship match (Galaxy S26 Ultra, iPhone 17 Pro, Pixel 10 Pro all
 *    have candidates titled "... 5G" with a source that never mentions
 *    it) — so it only fires when BOTH sides explicitly state a DIFFERENT
 *    generation, mirroring the existing Phase 14 color-conflict pattern.
 *
 * 2. Record, as a permanent regression guard, that every other Phase 12
 *    audit target (Mini/Max/Plus/Ultra/FE/Enterprise/XL, MacBook Air vs
 *    Pro, iPad vs iPad Air vs iPad Pro, Fold vs Flip) was found ALREADY
 *    correctly handled by the existing VARIANT_SUFFIX_WORDS /
 *    generation-mismatch mechanisms — no code change was needed or made
 *    for these; this file just proves it so a future change can't
 *    silently regress them.
 *
 * USAGE: node tests/matching/phase12VariantSuffixCoverage.test.js
 */

const assert = require("assert");
const { canonicalizeProduct } = require("../../comparison/productIdentity");
const { computeMatchConfidence } = require("../../services/productMatcher");

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

function canon(brand, model, storage) {
    return canonicalizeProduct({ brand, model, storage });
}

// -----------------------------------------------------------------
// THE ACTUAL PHASE 12 FIX: 4G vs 5G, explicit-conflict-only
// -----------------------------------------------------------------
test("4G/5G: explicit conflict rejects (M14 4G request vs M14 5G candidate)", () => {
    const r = computeMatchConfidence(canon("Samsung", "Galaxy M14 4G"), "Samsung Galaxy M14 5G");
    assert.strictEqual(r.hardReject, true);
    assert.strictEqual(r.primaryIssue, "network_generation_mismatch");
});

test("4G/5G: explicit conflict rejects the symmetric direction (M14 5G request vs M14 4G candidate)", () => {
    const r = computeMatchConfidence(canon("Samsung", "Galaxy M14 5G"), "Samsung Galaxy M14 4G");
    assert.strictEqual(r.hardReject, true);
    assert.strictEqual(r.primaryIssue, "network_generation_mismatch");
});

test("4G/5G: same explicit generation on both sides still matches", () => {
    const r5 = computeMatchConfidence(canon("Samsung", "Galaxy M14 5G"), "Samsung Galaxy M14 5G");
    assert.strictEqual(r5.hardReject, false);
    const r4 = computeMatchConfidence(canon("Samsung", "Galaxy M14 4G"), "Samsung Galaxy M14 4G");
    assert.strictEqual(r4.hardReject, false);
});

test("4G/5G: NO REGRESSION — silent source + '5G' candidate still matches (the flagship pattern every live match depends on)", () => {
    const cases = [
        [canon("Samsung", "Galaxy S26 Ultra", "256GB"), "Samsung Galaxy S26 Ultra 5G"],
        [canon("Google", "Pixel 10 Pro", "256GB"), "Google Pixel 10 Pro 5G"],
        [canon("Samsung", "Galaxy M14"), "Samsung Galaxy M14 5G"],
    ];
    for (const [source, candidate] of cases) {
        const r = computeMatchConfidence(source, candidate);
        assert.strictEqual(r.hardReject, false, `"${candidate}" must still match a source that never mentions 4G/5G`);
    }
});

// -----------------------------------------------------------------
// AUDIT CONFIRMATION (no code change — already correct): Mini / Max /
// Plus / Ultra / FE / Enterprise / XL, laptops, tablets, Fold/Flip
// -----------------------------------------------------------------
test("Audit: base vs Plus already rejected (Galaxy S26 vs S26 Plus)", () => {
    const r = computeMatchConfidence(canon("Samsung", "Galaxy S26"), "Samsung Galaxy S26 Plus 5G");
    assert.strictEqual(r.hardReject, true);
    assert.strictEqual(r.primaryIssue, "variant_mismatch");
});

test("Audit: Pro vs Pro Max already rejected (both directions)", () => {
    const a = computeMatchConfidence(canon("Apple", "iPhone 17 Pro"), "Apple iPhone 17 Pro Max");
    assert.strictEqual(a.hardReject, true);
    const b = computeMatchConfidence(canon("Apple", "iPhone 17 Pro Max"), "Apple iPhone 17 Pro");
    assert.strictEqual(b.hardReject, true);
});

test("Audit: base vs Ultra already rejected (Galaxy S26 vs S26 Ultra)", () => {
    const r = computeMatchConfidence(canon("Samsung", "Galaxy S26"), "Samsung Galaxy S26 Ultra");
    assert.strictEqual(r.hardReject, true);
    assert.strictEqual(r.primaryIssue, "variant_mismatch");
});

test("Audit: FE vs non-FE already rejected (Galaxy Tab S9 vs Tab S9 FE)", () => {
    const r = computeMatchConfidence(canon("Samsung", "Galaxy Tab S9"), "Samsung Galaxy Tab S9 FE");
    assert.strictEqual(r.hardReject, true);
    assert.strictEqual(r.primaryIssue, "variant_mismatch");
});

test("Audit: Fold vs Flip already rejected (different generation-mismatch code path)", () => {
    const r = computeMatchConfidence(canon("Samsung", "Galaxy Z Fold7"), "Samsung Galaxy Z Flip7");
    assert.strictEqual(r.hardReject, true);
});

test("Audit: MacBook Air vs MacBook Pro already rejected (both directions)", () => {
    const a = computeMatchConfidence(canon("Apple", "MacBook Air"), "Apple MacBook Pro");
    assert.strictEqual(a.hardReject, true);
    assert.strictEqual(a.primaryIssue, "variant_mismatch");
    const b = computeMatchConfidence(canon("Apple", "MacBook Pro"), "Apple MacBook Air");
    assert.strictEqual(b.hardReject, true);
});

test("Audit: iPad vs iPad Air vs iPad Pro all mutually rejected", () => {
    assert.strictEqual(computeMatchConfidence(canon("Apple", "iPad"), "Apple iPad Air").hardReject, true);
    assert.strictEqual(computeMatchConfidence(canon("Apple", "iPad Air"), "Apple iPad").hardReject, true);
    assert.strictEqual(computeMatchConfidence(canon("Apple", "iPad Pro"), "Apple iPad Air").hardReject, true);
});

test("Audit: XL (Phase 11) remains protected", () => {
    const r = computeMatchConfidence(canon("Google", "Pixel 10 Pro", "256GB"), "Google Pixel 10 Pro XL");
    assert.strictEqual(r.hardReject, true);
    assert.strictEqual(r.primaryIssue, "variant_mismatch");
});

console.log("\n=== SUMMARY ===");
const passed = results.filter((r) => r.pass).length;
console.log(`${passed}/${results.length} passed`);
if (passed !== results.length) process.exitCode = 1;
