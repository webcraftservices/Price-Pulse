/**
 * Phase 11 (Live Validation) — "XL" Variant-Suffix Fix
 * ------------------------------------------------------------------
 * Root cause: VARIANT_SUFFIX_WORDS (utils/numbers.js) was missing "xl".
 * A real live 4-product resolver run (product: {brand: Google, model:
 * "Pixel 10 Pro", storage: "256GB"}) surfaced this concretely:
 *   - Flipkart's "Google Pixel 10 Pro XL" (₹124,999) scored a perfect
 *     variant match against the requested "Pixel 10 Pro" and was
 *     included in trustedOffers.
 *   - GameLoot's "Google Pixel 10 Pro XL" (₹55,000, Google-redirect,
 *     unresolved) became bestOffer for a "Pixel 10 Pro" request.
 *   - Cashify's "Google Pixel 10 Pro XL" (₹78,899, resolved direct URL)
 *     became bestDirectOffer for the same "Pixel 10 Pro" request.
 * Confirmed via web search that Pixel 10 Pro and Pixel 10 Pro XL are
 * genuinely distinct, separately priced/specced phones (6.3" vs 6.8"
 * display, different battery, $999 vs $1,199 starting price) — the same
 * category of naming as the already-recognized Pro/Ultra/Plus/Fe/
 * Enterprise suffixes, just never added for "xl".
 *
 * Fix: add "xl" to VARIANT_SUFFIX_WORDS. Symmetric consequence (by
 * design, see evaluateVariantIdentity's comment): a request FOR "Pro XL"
 * against a plain "Pro" candidate must now also hard-reject.
 *
 * USAGE: node tests/matching/phase11XlVariantSuffix.test.js
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

const requestedPro = canonicalizeProduct({ brand: "Google", model: "Pixel 10 Pro", storage: "256GB" });
const requestedProXl = canonicalizeProduct({ brand: "Google", model: "Pixel 10 Pro XL", storage: "256GB" });

test("Live repro: 'Pixel 10 Pro' request rejects a 'Pixel 10 Pro XL' candidate", () => {
    const r = computeMatchConfidence(requestedPro, "Google Pixel 10 Pro XL");
    assert.strictEqual(r.hardReject, true);
    assert.strictEqual(r.primaryIssue, "variant_mismatch");
});

test("Live repro: rejects the exact live GameLoot title that wrongly became bestOffer", () => {
    const r = computeMatchConfidence(requestedPro, "Google Pixel 10 Pro XL");
    assert.strictEqual(r.hardReject, true, "this exact title incorrectly became bestOffer (₹55,000) before the fix");
});

test("Symmetric: 'Pixel 10 Pro XL' request rejects a plain 'Pixel 10 Pro' candidate", () => {
    const r = computeMatchConfidence(requestedProXl, "Google Pixel 10 Pro 5G");
    assert.strictEqual(r.hardReject, true);
    assert.strictEqual(r.primaryIssue, "variant_mismatch");
});

test("No regression: genuine 'Pixel 10 Pro' candidate still matches a 'Pixel 10 Pro' request", () => {
    const r = computeMatchConfidence(requestedPro, "Google Pixel 10 Pro 5G");
    assert.strictEqual(r.hardReject, false);
    assert.strictEqual(r.matchDecision, "STRONG_MATCH");
    assert.strictEqual(r.primaryIssue, "storage_unconfirmed");
});

test("No regression: genuine 'Pixel 10 Pro XL' candidate still matches a 'Pixel 10 Pro XL' request", () => {
    const r = computeMatchConfidence(requestedProXl, "Google Pixel 10 Pro XL Moonstone");
    assert.strictEqual(r.hardReject, false);
});

console.log("\n=== SUMMARY ===");
const passed = results.filter((r) => r.pass).length;
console.log(`${passed}/${results.length} passed`);
if (passed !== results.length) process.exitCode = 1;
