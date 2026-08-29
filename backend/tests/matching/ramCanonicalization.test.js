/**
 * Phase 5 — RAM canonicalization / matching activation
 * ------------------------------------------------------------------
 * Investigation finding (see PHASE5_RAM_CANONICALIZATION_REPORT.md):
 * the Phase 4 report's claim that `canonicalizeProduct` doesn't populate
 * `sourceProduct.ram` at all was WRONG — `extractCanonicalProduct` (used
 * for text queries) and `canonicalizeProduct`'s branded-input path (used
 * for AI Find) have both called `extractRamAndStorage` and included `ram`
 * in their output since before Phase 4. The apparent "gap" was a single
 * diagnostic console.log line in compareEngine.js that simply never
 * printed the `ram` field it already had (fixed).
 *
 * Real, narrow bugs found by deeper investigation instead (both fixed):
 *  1. `extractRamAndStorage`'s single-unlabeled-token case always assumed
 *     "storage", even for a plausible RAM-only figure like a bare "12GB"
 *     — contradicting the ticket's own stated expected behavior. Fixed
 *     with a magnitude-based disambiguation (utils/numbers.js).
 *  2. `productMatcher.js` had a `storage_unconfirmed` signal but no
 *     analogous `ram_unconfirmed` one — a candidate that never mentioned
 *     RAM at all was silently treated as if it had been confirmed. Fixed
 *     by adding the missing branch, mirroring the existing storage
 *     pattern exactly.
 *  3. A RAM mismatch's score cap (0.85) landed exactly ON the EXACT_MATCH
 *     boundary, so a wrong-RAM offer could still display as EXACT_MATCH.
 *     Fixed by extending the existing Phase 4 label-downgrade pattern.
 *
 * USAGE: node tests/matching/ramCanonicalization.test.js
 */

const assert = require("assert");
const path = require("path");

const { extractRamAndStorage } = require(path.join(__dirname, "..", "..", "utils", "numbers"));
const { canonicalizeProduct } = require(path.join(__dirname, "..", "..", "comparison", "productIdentity"));
const { computeMatchConfidence } = require(path.join(__dirname, "..", "..", "services", "productMatcher"));

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

// -----------------------------------------------------------------------
// Extraction — the ticket's own "EXPECTED RAM BEHAVIOR" test matrix
// -----------------------------------------------------------------------
console.log("=== extractRamAndStorage / canonicalizeProduct — extraction matrix ===");

test("1. '12GB 256GB' -> ram=12gb, storage=256gb", () => {
    const r = extractRamAndStorage("Samsung Galaxy S26 Ultra 12GB 256GB");
    assert.strictEqual(r.ram, "12gb");
    assert.strictEqual(r.storage, "256gb");
});

test("2. '12GB 512GB' -> ram=12gb, storage=512gb", () => {
    const r = extractRamAndStorage("Samsung Galaxy S26 Ultra 12GB 512GB");
    assert.strictEqual(r.ram, "12gb");
    assert.strictEqual(r.storage, "512gb");
});

test("3. '16GB 1TB' -> ram=16gb, storage=1tb", () => {
    const r = extractRamAndStorage("Samsung Galaxy S26 Ultra 16GB 1TB");
    assert.strictEqual(r.ram, "16gb");
    assert.strictEqual(r.storage, "1tb");
});

test("4. storage-only query ('256GB') -> storage=256gb, ram=null", () => {
    const r = extractRamAndStorage("Samsung Galaxy S26 Ultra 256GB");
    assert.strictEqual(r.storage, "256gb");
    assert.strictEqual(r.ram, null);
});

test("5. RAM-only query ('12GB', nothing else) -> ram=12gb, storage=null", () => {
    const r = extractRamAndStorage("Samsung Galaxy S26 Ultra 12GB");
    assert.strictEqual(r.ram, "12gb", "a bare small GB figure with no other context must be read as RAM, not storage");
    assert.strictEqual(r.storage, null);
});

test("8. storage extraction is unaffected for realistic single storage figures (32/64/128/256/512GB, 1TB, 2TB)", () => {
    assert.strictEqual(extractRamAndStorage("Product 32GB").storage, "32gb", "32GB alone is still ambiguous-but-plausible as storage (budget device) and stays the historical default");
    assert.strictEqual(extractRamAndStorage("Product 64GB").storage, "64gb");
    assert.strictEqual(extractRamAndStorage("Product 128GB").storage, "128gb");
    assert.strictEqual(extractRamAndStorage("Product 256GB").storage, "256gb");
    assert.strictEqual(extractRamAndStorage("Product 512GB").storage, "512gb");
    assert.strictEqual(extractRamAndStorage("Product 1TB").storage, "1tb");
    assert.strictEqual(extractRamAndStorage("Product 2TB").storage, "2tb");
});

test("9. unrelated numeric attributes are never parsed as RAM/storage (display size, camera MP, battery mAh, network gen)", () => {
    assert.deepStrictEqual(extractRamAndStorage("Samsung Galaxy S26 Ultra 6.9 inch Display"), { ram: null, storage: null });
    assert.deepStrictEqual(extractRamAndStorage("Samsung Galaxy S26 Ultra 200MP Camera"), { ram: null, storage: null });
    assert.deepStrictEqual(extractRamAndStorage("Samsung Galaxy S26 Ultra 5000mAh Battery"), { ram: null, storage: null });
    assert.deepStrictEqual(extractRamAndStorage("Samsung Galaxy S26 Ultra 5G"), { ram: null, storage: null });
    assert.deepStrictEqual(extractRamAndStorage("Samsung Exynos 2400 Processor"), { ram: null, storage: null });
    // A real listing combining several of these plus a genuine RAM/storage
    // pair — confirms none of the noise numbers gets mistaken for either.
    const combined = extractRamAndStorage("Samsung Galaxy S26 Ultra 5G 6.9 inch 200MP Camera 5000mAh 12GB RAM 256GB Storage");
    assert.strictEqual(combined.ram, "12gb");
    assert.strictEqual(combined.storage, "256gb");
});

console.log("\n=== canonicalizeProduct wiring (confirms RAM was always wired in — logging was the only gap) ===");

test("canonicalizeProduct populates ram for a plain text query, exactly like storage", () => {
    const canonical = canonicalizeProduct({ name: "Samsung Galaxy S26 Ultra 12GB 256GB" });
    assert.strictEqual(canonical.ram, "12gb");
    assert.strictEqual(canonical.storage, "256gb");
});

test("canonicalizeProduct fills ram/storage gaps for an already-branded (AI Find style) input too", () => {
    const canonical = canonicalizeProduct({ brand: "Samsung", name: "Samsung Galaxy S26 Ultra 12GB 256GB", model: "Galaxy S26 Ultra" });
    assert.strictEqual(canonical.ram, "12gb");
    assert.strictEqual(canonical.storage, "256gb");
});

// -----------------------------------------------------------------------
// Matching — the ticket's own "CRITICAL MATCHING REQUIREMENT" scenarios
// -----------------------------------------------------------------------
console.log("\n=== productMatcher — RAM matching activation ===");
const REQUEST_12_256 = { brand: "Samsung", model: "Galaxy S26 Ultra", productName: "Galaxy S26 Ultra", storage: "256GB", ram: "12GB" };

test("6. RAM mismatch candidate (8GB vs requested 12GB) is NOT an exact variant match", () => {
    const r = computeMatchConfidence(REQUEST_12_256, "Samsung Galaxy S26 Ultra 8GB 256GB");
    console.log(`      confidence=${r.confidence} primaryIssue=${r.primaryIssue} matchDecision=${r.matchDecision}`);
    assert.strictEqual(r.primaryIssue, "ram_mismatch");
    assert.notStrictEqual(r.matchDecision, "EXACT_MATCH", "a RAM mismatch must never display as an exact variant match");
    assert.strictEqual(r.hardReject, false, "a RAM mismatch remains a soft demotion, never a hard rejection (unchanged Gate 1 semantics)");
    assert.ok(r.confidence >= 0.5, "must not be pushed all the way to a possible/uncertain match either — still strong product identity");
});

test("exact match: candidate confirms both RAM and storage exactly", () => {
    const r = computeMatchConfidence(REQUEST_12_256, "Samsung Galaxy S26 Ultra 12GB 256GB");
    assert.strictEqual(r.primaryIssue, null);
    assert.strictEqual(r.matchDecision, "EXACT_MATCH");
    assert.strictEqual(r.confidence, 1);
});

test("7. RAM-unconfirmed candidate (storage confirmed, RAM never mentioned) is NOT treated as an exact RAM match", () => {
    const r = computeMatchConfidence(REQUEST_12_256, "Samsung Galaxy S26 Ultra 256GB");
    console.log(`      confidence=${r.confidence} primaryIssue=${r.primaryIssue} matchDecision=${r.matchDecision}`);
    assert.strictEqual(r.primaryIssue, "ram_unconfirmed", "must be flagged unconfirmed, not silently treated as confirmed");
    assert.notStrictEqual(r.matchDecision, "EXACT_MATCH", "must not overclaim an exact RAM match that was never verified");
    assert.strictEqual(r.hardReject, false);
});

test("eligibility control: the RAM-mismatch/unconfirmed label changes do NOT affect bestOffer eligibility — only the string changed", () => {
    const { isEligibleForComparison } = require(path.join(__dirname, "..", "..", "comparison", "offerEligibility"));
    const mismatch = computeMatchConfidence(REQUEST_12_256, "Samsung Galaxy S26 Ultra 8GB 256GB");
    const unconfirmed = computeMatchConfidence(REQUEST_12_256, "Samsung Galaxy S26 Ultra 256GB");
    assert.strictEqual(isEligibleForComparison({ hardReject: mismatch.hardReject, matchConfidence: mismatch.confidence, price: 100000, availability: "in_stock", productUrl: "https://x", usableForBestOffer: true }), true, "RAM mismatch offer remains fully eligible — only its display label changed");
    assert.strictEqual(isEligibleForComparison({ hardReject: unconfirmed.hardReject, matchConfidence: unconfirmed.confidence, price: 100000, availability: "in_stock", productUrl: "https://x", usableForBestOffer: true }), true, "RAM unconfirmed offer remains fully eligible — only its display label changed");
});

// -----------------------------------------------------------------------
// 10. Regression control — existing Samsung/iPhone Phase 4 behavior
// -----------------------------------------------------------------------
console.log("\n=== 10. Regression: existing Phase 4 Samsung/iPhone behavior is unchanged ===");

test("Phase 4 regression: storage_unconfirmed (no ram requested) still downgrades EXACT_MATCH -> STRONG_MATCH exactly as before", () => {
    const requestNoRam = { brand: "Samsung", model: "Galaxy S26 Ultra", productName: "Galaxy S26 Ultra", storage: "256GB" };
    const r = computeMatchConfidence(requestNoRam, "Samsung Galaxy S26 Ultra 5G");
    assert.strictEqual(r.primaryIssue, "storage_unconfirmed");
    assert.strictEqual(r.matchDecision, "STRONG_MATCH");
});

test("Phase 4 regression: genuinely-confirmed exact variant (iPhone Cosmic Orange, storage present, no ram requested) still reaches EXACT_MATCH", () => {
    const r = computeMatchConfidence(
        { brand: "Apple", model: "iPhone 17 Pro", productName: "iPhone 17 Pro", storage: "256GB" },
        "Apple iPhone 17 Pro ( 256GB ) Cosmic Orange"
    );
    assert.strictEqual(r.primaryIssue, null);
    assert.strictEqual(r.matchDecision, "EXACT_MATCH", "this fix must never create a false negative for a genuinely fully-confirmed match");
});

test("Phase 4 regression: storage_mismatch stays a soft demotion, unaffected by any Phase 5 change", () => {
    const r = computeMatchConfidence(REQUEST_12_256, "Samsung Galaxy S26 Ultra 12GB 512GB");
    assert.strictEqual(r.primaryIssue, "storage_mismatch");
    assert.strictEqual(r.hardReject, false);
    assert.notStrictEqual(r.matchDecision, "EXACT_MATCH");
});

test("Phase 4 regression: variant/generation hard-rejects (Gate 1) are completely unaffected by RAM changes", () => {
    const wrongVariant = computeMatchConfidence(REQUEST_12_256, "Samsung Galaxy S26+");
    assert.strictEqual(wrongVariant.hardReject, true);
    assert.strictEqual(wrongVariant.primaryIssue, "variant_mismatch");

    const wrongGen = computeMatchConfidence(REQUEST_12_256, "Samsung Galaxy S25 Ultra");
    assert.strictEqual(wrongGen.hardReject, true);
    assert.strictEqual(wrongGen.primaryIssue, "generation_mismatch");
});

console.log("\n=== SUMMARY ===");
const passed = results.filter((r) => r.pass).length;
console.log(`${passed}/${results.length} passed`);
if (passed !== results.length) process.exitCode = 1;
