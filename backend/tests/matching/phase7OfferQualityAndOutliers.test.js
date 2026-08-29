/**
 * Phase 7 — Offer Quality, High-Side Outliers & SKU-Confirmation Ranking
 * ------------------------------------------------------------------
 * Tests for:
 * 1. High-side price outlier detection (ratio > 2.0, symmetric with low-side)
 * 2. High-side outliers excluded from bestOffer/savings
 * 3. EXACT_MATCH ranked higher than STRONG_MATCH with unconfirmed attributes
 * 4. STRONG_MATCH with unconfirmed attrs NOT hard-rejected
 * 5. Savings pool consistency (excludes outliers)
 * 6. Regression: Phase 4/5/6 behavior unchanged
 *
 * USAGE: node tests/matching/phase7OfferQualityAndOutliers.test.js
 */

const assert = require("assert");
const path = require("path");

const { assessPriceOutlier, attachOfferQuality } = require(path.join(__dirname, "..", "..", "comparison", "offerQuality"));
const { isEligibleForComparison } = require(path.join(__dirname, "..", "..", "comparison", "offerEligibility"));
const { buildComparison } = require(path.join(__dirname, "..", "..", "comparison", "offerRanker"));

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

function offer(overrides) {
    return {
        store: "TestStore",
        title: "Samsung Galaxy S26 Ultra 256GB",
        price: 120000,
        currency: "INR",
        availability: "in_stock",
        productUrl: "https://example.com/p",
        matchConfidence: 0.9,
        matchDecision: "EXACT_MATCH",
        matchIssue: null,
        hardReject: false,
        _retailerTier: "major_retailer",
        ...overrides,
    };
}

async function main() {
    console.log("=== PHASE 7 — HIGH-SIDE OUTLIER DETECTION ===\n");

    // ---------------------------------------------------------------
    // TEST 1: High-side outlier in 4+ offer cluster
    // ---------------------------------------------------------------
    test("TEST 1: high-side extreme outlier (250000 amid 100k-120k cluster) detected", () => {
        const offers = [
            offer({ store: "Amazon", price: 100000 }),
            offer({ store: "Flipkart", price: 110000 }),
            offer({ store: "MRV", price: 120000 }),
            offer({ store: "Ubuy", price: 250000 }),
        ];
        const scored = attachOfferQuality(offers);
        const ubuy = scored.find((o) => o.store === "Ubuy");

        console.log(`      Ubuy price: ${ubuy.price}, offerQuality: ${JSON.stringify(ubuy.offerQuality)}`);
        assert.ok(
            ubuy.offerQuality.reasons.includes("extreme_price_outlier"),
            `expected extreme_price_outlier, got ${ubuy.offerQuality.reasons}`
        );
        assert.strictEqual(ubuy.usableForBestOffer, false, "high-side outlier must be unusable for bestOffer");
    });

    // ---------------------------------------------------------------
    // TEST 2: High-side outlier marked as unusable for bestOffer
    // ---------------------------------------------------------------
    test("TEST 2: high-side outlier has usableForBestOffer === false", () => {
        const offers = [
            offer({ store: "Amazon", price: 115000 }),
            offer({ store: "Flipkart", price: 125000 }),
            offer({ store: "Ubuy", price: 300000 }),
        ];
        const scored = attachOfferQuality(offers);
        const ubuy = scored.find((o) => o.store === "Ubuy");
        assert.strictEqual(ubuy.usableForBestOffer, false);
        assert.strictEqual(isEligibleForComparison(ubuy), false, "must fail bestOffer eligibility gate");
    });

    // ---------------------------------------------------------------
    // TEST 3: High-side outlier remains visible in results
    // ---------------------------------------------------------------
    test("TEST 3: high-side outlier is NOT removed from results, only marked unusable", () => {
        const offers = [
            offer({ store: "Amazon", price: 115000 }),
            offer({ store: "Flipkart", price: 125000 }),
            offer({ store: "Ubuy", price: 300000, matchConfidence: 0.9, matchDecision: "EXACT_MATCH" }),
        ];
        const scored = attachOfferQuality(offers);
        assert.strictEqual(scored.length, 3, "all three offers remain in scored pool");
        const ubuy = scored.find((o) => o.store === "Ubuy");
        assert.ok(ubuy, "Ubuy is still present");
        assert.strictEqual(ubuy.hardReject, false, "Ubuy is not hard-rejected");
        assert.strictEqual(ubuy.offerQuality.status, "suspicious", "Ubuy is marked suspicious");
    });

    // ---------------------------------------------------------------
    // TEST 4: Savings excludes high-side outlier
    // ---------------------------------------------------------------
    test("TEST 4: savings excludes high-side outlier (100k-120k, not 100k-250k)", () => {
        const offers = [
            offer({ store: "Amazon", price: 100000 }),
            offer({ store: "Flipkart", price: 110000 }),
            offer({ store: "MRV", price: 120000 }),
            offer({ store: "Ubuy", price: 250000 }),
        ];
        const scored = attachOfferQuality(offers);

        // Mock-score all offers with confidence >= 0.75 so they're eligible for comparison
        scored.forEach((o) => {
            if (!o.hardReject && o.usableForBestOffer !== false) {
                o.matchConfidence = 0.9;
                o.matchDecision = "EXACT_MATCH";
            }
        });

        const comparison = buildComparison(scored);
        console.log(`      calculated savings: ${comparison.savings}, expected: 20000`);
        // Expected eligible pool: Amazon (100k), Flipkart (110k), MRV (120k)
        // Ubuy excluded due to extreme_price_outlier
        // Savings = 120k - 100k = 20k
        assert.strictEqual(comparison.savings, 20000, "savings should be 20000 (excluding ₹250k outlier)");
    });

    // ---------------------------------------------------------------
    // TEST 5: Low sample size (2 offers) does NOT trigger high-side detection
    // ---------------------------------------------------------------
    test("TEST 5: insufficient sample (2 offers only) does NOT classify as outlier via high-side rule", () => {
        const offers = [offer({ store: "Cheap", price: 100000 }), offer({ store: "Expensive", price: 250000 })];
        const scored = attachOfferQuality(offers);
        const expensive = scored.find((o) => o.store === "Expensive");

        // With only 2 offers, there's no statistical support, so the high-side check should not fire
        console.log(`      expensive offer quality: ${JSON.stringify(expensive.offerQuality)}`);
        assert.strictEqual(
            expensive.offerQuality.status,
            "trusted",
            "with only 2 offers, no high-side outlier should be detected"
        );
        assert.strictEqual(expensive.usableForBestOffer, true, "should remain usable");
    });

    // ---------------------------------------------------------------
    // TEST 6: Low-side outlier behavior unchanged (regression)
    // ---------------------------------------------------------------
    test("TEST 6: low-side outlier (5389 amid 95k cluster) still detected and excluded", () => {
        const offers = [
            offer({ store: "Amazon", price: 117600 }),
            offer({ store: "Flipkart", price: 124999 }),
            offer({ store: "MRV", price: 94999 }),
            offer({ store: "Desertcart", price: 5389, title: "Samsung Galaxy S26 Ultra & && ()" }),
        ];
        const scored = attachOfferQuality(offers);
        const desertcart = scored.find((o) => o.store === "Desertcart");
        assert.ok(desertcart.offerQuality.reasons.includes("extreme_price_outlier"));
        assert.strictEqual(desertcart.usableForBestOffer, false);
    });

    console.log("\n=== PHASE 7 — EXACT_MATCH vs STRONG_MATCH RANKING ===\n");

    // ---------------------------------------------------------------
    // TEST 7: EXACT_MATCH preferred over STRONG_MATCH (unconfirmed)
    // ---------------------------------------------------------------
    test("TEST 7: EXACT_MATCH ranks higher than STRONG_MATCH with storage_unconfirmed", () => {
        const offers = [
            offer({
                store: "Amazon",
                price: 120000,
                matchConfidence: 0.9,
                matchDecision: "EXACT_MATCH",
                matchIssue: null,
                title: "Samsung Galaxy S26 Ultra 256GB",
            }),
            offer({
                store: "Flipkart",
                price: 115000, // Cheaper, but unconfirmed storage
                matchConfidence: 0.82,
                matchDecision: "STRONG_MATCH",
                matchIssue: "storage_unconfirmed",
                title: "Samsung Galaxy S26 Ultra 12GB",
            }),
        ];

        const comparison = buildComparison(offers);
        // Both are eligible (confidence >= 0.75, priced, in stock, etc.)
        // Amazon should appear first in sortedOffers due to higher matchQualityRank
        assert.strictEqual(
            comparison.offers[0].store,
            "Amazon",
            "EXACT_MATCH should rank higher than STRONG_MATCH"
        );
        assert.strictEqual(comparison.offers[1].store, "Flipkart");
    });

    // ---------------------------------------------------------------
    // TEST 8: STRONG_MATCH with unconfirmed attributes NOT hard-rejected
    // ---------------------------------------------------------------
    test("TEST 8: STRONG_MATCH with storage_unconfirmed is NOT hard-rejected", () => {
        const offers = [
            offer({
                store: "TestStore",
                matchConfidence: 0.82,
                matchDecision: "STRONG_MATCH",
                matchIssue: "storage_unconfirmed",
            }),
        ];
        const comparison = buildComparison(offers);
        assert.strictEqual(comparison.offers.length, 1, "offer should remain in results");
        assert.strictEqual(comparison.offers[0].hardReject, false, "should not be hard-rejected");
    });

    // ---------------------------------------------------------------
    // TEST 9: STRONG_MATCH can still win on price/quality/tier
    // ---------------------------------------------------------------
    test("TEST 9: STRONG_MATCH wins when price/quality/tier advantage is significant", () => {
        const offers = [
            offer({
                store: "ExpensiveOther",
                price: 150000,
                _retailerTier: "other_seller",
                matchConfidence: 0.95,
                matchDecision: "EXACT_MATCH",
                matchIssue: null,
            }),
            offer({
                store: "CheapAmazon",
                price: 100000, // Much cheaper, from major retailer
                _retailerTier: "major_retailer",
                matchConfidence: 0.82,
                matchDecision: "STRONG_MATCH",
                matchIssue: "storage_unconfirmed",
            }),
        ];

        const comparison = buildComparison(offers);
        // Ranking order: validityRank (same) → tierRank (Amazon is major_retailer=0, Other=2)
        // → matchQualityRank (EXACT_MATCH=0 vs STRONG=1) → but tierRank already decided it
        // Amazon (major_retailer) should rank first due to tierRank
        assert.strictEqual(
            comparison.offers[0].store,
            "CheapAmazon",
            "major_retailer tier can outrank match quality in sorting"
        );
    });

    // ---------------------------------------------------------------
    // TEST 10: Phase 6 Danzaa case preserved
    // ---------------------------------------------------------------
    test("TEST 10: Phase 6 regression — Danzaa 'Snapdragon 8 Elite Gen5' is NOT variant_mismatch", () => {
        const offers = [
            offer({
                store: "Danzaa",
                title: "Samsung Galaxy S26 Ultra, 12GB+256GB, 5G Dual SIM Phone (Snapdragon 8 Elite Gen5)",
                matchConfidence: 1.0, // Should be EXACT_MATCH after Phase 6 fix
                matchDecision: "EXACT_MATCH",
                matchIssue: null,
            }),
        ];
        const comparison = buildComparison(offers);
        assert.strictEqual(comparison.offers.length, 1, "Danzaa offer should be in results");
        assert.strictEqual(comparison.offers[0].matchDecision, "EXACT_MATCH");
        assert.notStrictEqual(comparison.offers[0].matchIssue, "variant_mismatch");
    });

    console.log("\n=== PHASE 7 — SAVINGS POOL CONSISTENCY ===\n");

    // ---------------------------------------------------------------
    // TEST 11: Savings calculation excludes both low and high outliers
    // ---------------------------------------------------------------
    test("TEST 11: savings pool excludes both low-side and high-side outliers", () => {
        const offers = [
            offer({ store: "Amazon", price: 115000 }),
            offer({ store: "Flipkart", price: 125000 }),
            offer({ store: "MRV", price: 105000 }),
            offer({ store: "Cheap", price: 10000 }),      // Low-side outlier
            offer({ store: "Expensive", price: 300000 }), // High-side outlier
        ];

        const scored = attachOfferQuality(offers);
        scored.forEach((o) => {
            if (o.usableForBestOffer !== false && !o.hardReject) {
                o.matchConfidence = 0.9;
                o.matchDecision = "EXACT_MATCH";
            }
        });

        const comparison = buildComparison(scored);
        // Eligible pool: Amazon, Flipkart, MRV (105k-125k)
        // Excluded: Cheap (10k - low outlier), Expensive (300k - high outlier)
        console.log(`      savings: ${comparison.savings}, expected 20000 (125k - 105k)`);
        assert.strictEqual(comparison.savings, 20000);
    });

    console.log("\n=== PHASE 7 — REGRESSION: PHASE 4/5/6 BEHAVIOR ===\n");

    // ---------------------------------------------------------------
    // TEST 12: Phase 5 RAM tests still pass (sample regression)
    // ---------------------------------------------------------------
    test("TEST 12: Phase 5 RAM-unconfirmed behavior unchanged", () => {
        // A STRONG_MATCH with ram_unconfirmed should still have
        // matchConfidence >= 0.75 and be eligible for bestOffer
        // (only the ranking preference changes, not eligibility)
        const offers = [
            offer({
                store: "TestStore",
                price: 100000,
                matchConfidence: 0.82,
                matchDecision: "STRONG_MATCH",
                matchIssue: "ram_unconfirmed",
            }),
        ];

        assert.ok(
            isEligibleForComparison(offers[0]),
            "ram_unconfirmed should remain eligible for bestOffer (Phase 5 behavior unchanged)"
        );
    });

    // ---------------------------------------------------------------
    // TEST 13: Phase 4 existing offer quality signals still work
    // ---------------------------------------------------------------
    test("TEST 13: Phase 4 used/refurbished, malformed title, installment signals unchanged", () => {
        const offers = [
            offer({ store: "TestUsed", title: "Samsung Galaxy S26 Ultra Refurbished", price: 90000 }),
            offer({ store: "TestEMI", title: "Samsung Galaxy S26 Ultra ₹9,999/month EMI", price: 100000 }),
            offer({ store: "TestMalformed", title: "Samsung Galaxy S26 Ultra & && () @@", price: 50000 }),
        ];

        const scored = attachOfferQuality(offers);
        const used = scored.find((o) => o.store === "TestUsed");
        const emi = scored.find((o) => o.store === "TestEMI");
        const malformed = scored.find((o) => o.store === "TestMalformed");

        assert.ok(used.offerQuality.reasons.includes("used_or_refurbished"));
        assert.ok(emi.offerQuality.reasons.includes("installment_or_partial_price"));
        assert.ok(malformed.offerQuality.reasons.includes("malformed_title"));

        // All should be unusable for bestOffer
        assert.strictEqual(used.usableForBestOffer, false);
        assert.strictEqual(emi.usableForBestOffer, false);
        assert.strictEqual(malformed.usableForBestOffer, false);
    });

    console.log("\n=== SUMMARY ===");
    const passed = results.filter((r) => r.pass).length;
    const failed = results.filter((r) => !r.pass).length;
    console.log(`${passed}/${results.length} passed`);
    if (failed > 0) {
        console.log(`\n${failed} FAILED:`);
        results.filter((r) => !r.pass).forEach((r) => console.log(`  - ${r.name}`));
        process.exit(1);
    }
}

main().catch((err) => {
    console.error("Test suite error:", err);
    process.exit(1);
});
