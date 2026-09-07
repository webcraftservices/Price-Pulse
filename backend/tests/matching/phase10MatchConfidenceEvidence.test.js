/**
 * Match Confidence & Variant Evidence tests — Phase 10 ("Match
 * Confidence & Variant Evidence Audit")
 * ------------------------------------------------------------------
 * Root cause fixed: canonicalizeProduct()'s structured-input branch
 * (comparison/productIdentity.js) never populated name/productName from
 * a caller-supplied `model` field — unlike the free-text branch just
 * below it, which has always kept productName and model in sync. That
 * silently starved two signals of evidence the caller already gave us:
 *   - evaluateProductIdentity's Gate-0 sourceName (product-type
 *     classification of the REQUEST fell back to "unknown" instead of
 *     e.g. "smartphone")
 *   - computeMatchConfidence's title-overlap jaccard score (fell back to
 *     brand-only tokens, discarding the model text entirely, even though
 *     the separate +0.25 model-match bonus a few lines later already
 *     read sourceProduct.model directly and DID see it)
 *
 * This is evidence RECOVERY, not confidence manufacturing: brand+model
 * were already caller-supplied, verbatim, unchanged. Storage/RAM
 * confirmation logic is completely untouched — an offer with no storage
 * evidence in its title still gets primaryIssue "storage_unconfirmed"
 * exactly as before; this fix only means a candidate that legitimately
 * confirms brand+model can now cross BEST_OFFER_MATCH_THRESHOLD (0.75)
 * on that confirmed evidence, which the resolver-eligibility filter in
 * compareEngine.js needs in order to ever attempt these offers at all
 * (see PHASE10_MATCH_CONFIDENCE_AUDIT_REPORT.md for the live 0.60 ->
 * 1.0 Reliance Digital repro this fixes).
 *
 * Every hard-reject safety rail (variant, generation, product-type) is
 * re-verified unchanged in this same suite, using the exact live
 * candidates from the Phase 10 task brief.
 *
 * USAGE: node tests/matching/phase10MatchConfidenceEvidence.test.js
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

const SOURCE = { brand: "Samsung", model: "Galaxy S26 Ultra", storage: "256GB" };
const canonical = canonicalizeProduct(SOURCE);

// -----------------------------------------------------------------
// Canonicalization itself: model recovered into productName, storage
// untouched, no fabricated field.
// -----------------------------------------------------------------
test("canonicalizeProduct recovers productName from model for structured input", () => {
    assert.strictEqual(canonical.productName, "Galaxy S26 Ultra");
    assert.strictEqual(canonical.model, "Galaxy S26 Ultra");
    assert.strictEqual(canonical.storage, "256GB");
    assert.strictEqual(canonical.name, undefined, "must not fabricate a .name field that wasn't there");
});

test("canonicalizeProduct leaves an explicit name/productName completely untouched", () => {
    const withName = canonicalizeProduct({ brand: "Samsung", name: "Samsung Galaxy S26 Ultra 256GB", model: "Galaxy S26 Ultra", storage: "256GB" });
    assert.strictEqual(withName.name, "Samsung Galaxy S26 Ultra 256GB");
});

// -----------------------------------------------------------------
// TEST A — exact storage: confident identity
// -----------------------------------------------------------------
test("TEST A: exact storage -> EXACT_MATCH, no matchIssue", () => {
    const r = computeMatchConfidence(canonical, "Samsung Galaxy S26 Ultra 5G 256GB");
    assert.strictEqual(r.hardReject, false);
    assert.strictEqual(r.primaryIssue, null);
    assert.strictEqual(r.matchDecision, "EXACT_MATCH");
    assert.ok(r.confidence >= 0.75, `expected confident match, got ${r.confidence}`);
});

// -----------------------------------------------------------------
// TEST B — storage unknown: must NOT become 256GB, but IS now a
// confidently-identified STRONG_MATCH (the actual Phase 10 fix)
// -----------------------------------------------------------------
test("TEST B: storage unknown -> stays storage_unconfirmed, never fabricated as a match", () => {
    const r = computeMatchConfidence(canonical, "Samsung Galaxy S26 Ultra 5G");
    assert.strictEqual(r.hardReject, false);
    assert.strictEqual(r.primaryIssue, "storage_unconfirmed", "must remain honestly unconfirmed, never silently become 256GB");
    assert.notStrictEqual(r.matchDecision, "EXACT_MATCH", "unconfirmed storage must never claim EXACT_MATCH (Phase 4 rule)");
    assert.ok(r.confidence >= 0.75, `Phase 10 fix: confirmed brand+model should now clear the resolver-eligibility bar (got ${r.confidence})`);
});

// -----------------------------------------------------------------
// TEST C — wrong storage: must remain rejected/uncertain
// -----------------------------------------------------------------
test("TEST C: wrong storage (512GB) -> capped low, never a confident 256GB match", () => {
    const r = computeMatchConfidence(canonical, "Samsung Galaxy S26 Ultra 5G 512GB");
    assert.strictEqual(r.primaryIssue, "storage_mismatch");
    assert.ok(r.confidence < 0.75, `wrong storage must stay below the confident bar, got ${r.confidence}`);
});

// -----------------------------------------------------------------
// TEST D — RAM figure must never be misread as storage
// -----------------------------------------------------------------
test("TEST D: '12GB RAM' is not interpreted as 12GB storage", () => {
    const r = computeMatchConfidence(canonical, "Samsung Galaxy S26 Ultra 12GB RAM");
    assert.strictEqual(r.primaryIssue, "storage_unconfirmed", "12GB RAM must not satisfy the 256GB storage requirement");
});

// -----------------------------------------------------------------
// TEST E — wrong variant: hard reject, unaffected by the fix
// -----------------------------------------------------------------
test("TEST E: Galaxy S26+ -> VARIANT_MISMATCH hard reject", () => {
    const r = computeMatchConfidence(canonical, "Samsung Galaxy S26+");
    assert.strictEqual(r.hardReject, true);
    assert.strictEqual(r.primaryIssue, "variant_mismatch");
    assert.strictEqual(r.confidence, 0);
});

// -----------------------------------------------------------------
// TEST F — wrong generation: hard reject, unaffected by the fix
// -----------------------------------------------------------------
test("TEST F: Galaxy S25 Ultra -> GENERATION_MISMATCH hard reject", () => {
    const r = computeMatchConfidence(canonical, "Samsung Galaxy S25 Ultra 12GB 256GB");
    assert.strictEqual(r.hardReject, true);
    assert.strictEqual(r.primaryIssue, "generation_mismatch");
    assert.strictEqual(r.confidence, 0);
});

// -----------------------------------------------------------------
// TEST G — accessory: hard reject, unaffected by the fix
// -----------------------------------------------------------------
test("TEST G: back cover -> PRODUCT_TYPE_CONFLICT hard reject", () => {
    const r = computeMatchConfidence(canonical, "Galaxy S26 Ultra Back Cover");
    assert.strictEqual(r.hardReject, true);
    assert.strictEqual(r.primaryIssue, "product_type_conflict");
    assert.strictEqual(r.confidence, 0);
});

// -----------------------------------------------------------------
// TEST H — full hard-reject sweep from the Phase 10 brief's Task 7
// list, to prove the evidence-recovery fix doesn't rescue ANY of them
// -----------------------------------------------------------------
test("TEST H: every Task-7 safety case remains a hard reject", () => {
    const mustReject = [
        "Samsung Galaxy S26",
        "Samsung Galaxy S26+",
        "Samsung Galaxy S25 Ultra",
        "Samsung Galaxy S24 Ultra",
        "Samsung Galaxy S26 FE",
        "Samsung Galaxy A26",
        "Samsung Galaxy S26 motherboard",
        "Samsung Galaxy S26 Ultra back cover",
        "Samsung Galaxy S26 Ultra skins",
    ];
    for (const title of mustReject) {
        const r = computeMatchConfidence(canonical, title);
        assert.strictEqual(r.hardReject, true, `"${title}" must remain hard-rejected, got confidence=${r.confidence} matchDecision=${r.matchDecision}`);
    }
});

// -----------------------------------------------------------------
// Gate-0 classification side benefit: requestedType should no longer
// be "unknown" for a plain brand+model structured input.
// -----------------------------------------------------------------
test("Gate 0 requestedType is now correctly classified (was 'unknown' before this fix)", () => {
    const r = computeMatchConfidence(canonical, "Samsung Galaxy S26 Ultra 5G");
    assert.strictEqual(r.requestedType, "smartphone");
});

console.log("\n=== SUMMARY ===");
const passed = results.filter((r) => r.pass).length;
console.log(`${passed}/${results.length} passed`);
if (passed !== results.length) process.exitCode = 1;
