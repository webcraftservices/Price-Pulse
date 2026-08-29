/**
 * Phase 8 — Trusted Retailer Registry & Filtering
 * ------------------------------------------------------------------
 * Covers the Phase 8 master-prompt Section 20 checklist:
 *   - trusted retailer classification (registry-based, not title text,
 *     not URL directness)
 *   - trusted-mode filtering / full-internet mode preserved
 *   - bestTrustedOffer / bestInternetOffer(bestOffer) correctness
 *   - trustedSavings uses only the trusted eligible pool
 *   - Phase 7 high-side outlier exclusion still applies inside the
 *     trusted pool
 *   - empty / single trusted-offer scenarios
 *   - URL input still produces correct product identity + trusted pool
 *
 * Two layers, like the rest of this repo's suites:
 *   PART A — unit-level: merchantRegistry.isTrustedMerchant, and
 *            offerExtractor's registry-based (not title-based) trust
 *            propagation.
 *   PART B — E2E-level: runs the real, unmodified compareService.js /
 *            compareEngine.js against a fake Serper HTTP layer (same
 *            pattern as scripts/regression-tests.js), so trusted vs.
 *            full-internet behavior is verified through the actual
 *            pipeline, not a re-implementation of it.
 *
 * USAGE: node tests/retailers/trustedRetailerRegistry.test.js
 */

const assert = require("assert");
const path = require("path");
const Module = require("module");

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
async function testAsync(name, fn) {
    try {
        await fn();
        results.push({ name, pass: true });
        console.log(`PASS  ${name}`);
    } catch (err) {
        results.push({ name, pass: false, error: err.message });
        console.log(`FAIL  ${name}`);
        console.log(`      ${err.message}`);
    }
}

// ---------------------------------------------------------------------
// Fake HTTP layer, installed BEFORE any module that might transitively
// require axios (e.g. comparison/urlResolver.js -> providers/serper/
// webSearch.js -> providers/serper/serperClient.js -> axios). Node
// caches modules by resolved path the first time they're required, so
// this patch must be in place before Part A's requires below, not just
// before Part B's — same ordering scripts/regression-tests.js relies on.
// ---------------------------------------------------------------------

let currentShopping = [];
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
    if (id === "axios") {
        return {
            post: async () => ({ data: { shopping: currentShopping } }),
            get: async () => ({ data: "" }),
        };
    }
    if (id === "cheerio") {
        return { load: () => () => ({ attr: () => null, first: () => ({ text: () => "" }) }) };
    }
    return originalRequire.apply(this, arguments);
};

process.env.SERPER_API_KEY = process.env.SERPER_API_KEY || "fake_key_for_phase8_test";
process.env.ENABLE_MERCHANT_URL_RESOLVER = "false"; // keep deterministic — no secondary resolution pass

// =====================================================================
// PART A — merchantRegistry / offerExtractor unit tests
// =====================================================================

const { isTrustedMerchant, lookupMerchant } = require(path.join(__dirname, "..", "..", "providers", "merchants", "merchantRegistry"));
const { extractOffers } = require(path.join(__dirname, "..", "..", "comparison", "offerExtractor"));

function runPartA() {
    test("Amazon is classified as trusted", () => {
        assert.strictEqual(isTrustedMerchant("Amazon"), true);
        assert.strictEqual(isTrustedMerchant("Amazon.in"), true);
    });

    test("Flipkart is classified as trusted", () => {
        assert.strictEqual(isTrustedMerchant("Flipkart"), true);
    });

    test("Croma and Reliance Digital are classified as trusted", () => {
        assert.strictEqual(isTrustedMerchant("Croma"), true);
        assert.strictEqual(isTrustedMerchant("Reliance Digital"), true);
    });

    test("Myntra and Ajio (fashion) are classified as trusted", () => {
        assert.strictEqual(isTrustedMerchant("Myntra"), true);
        assert.strictEqual(isTrustedMerchant("Ajio"), true);
    });

    test("Known-but-not-yet-enabled retailer (Tata Cliq) is NOT trusted", () => {
        // Tata Cliq is ranked major_retailer (affects display/tier sort)
        // but is intentionally excluded from the Phase 8 initial trusted
        // set — tier and trust are independent axes.
        assert.strictEqual(lookupMerchant("Tata Cliq").tier, "major_retailer");
        assert.strictEqual(isTrustedMerchant("Tata Cliq"), false);
    });

    test("Completely unknown merchant is not trusted", () => {
        assert.strictEqual(isTrustedMerchant("Mygsm.me"), false);
        assert.strictEqual(isTrustedMerchant("Doberman Group"), false);
        assert.strictEqual(isTrustedMerchant("Ganesh Mobile Galaxy"), false);
    });

    test("Unknown/empty merchant name never throws, returns false", () => {
        assert.strictEqual(isTrustedMerchant(""), false);
        assert.strictEqual(isTrustedMerchant(null), false);
        assert.strictEqual(isTrustedMerchant(undefined), false);
    });

    test("Fake 'Amazon' text inside a title/source does not make an unrelated offer trusted", () => {
        // extractOffers uses item.source (the merchant field), never
        // item.title, to resolve the merchant — a scam listing whose
        // TITLE mentions Amazon but whose actual seller is unknown must
        // not be classified as Amazon.
        const offers = extractOffers(
            [
                {
                    title: "Cheap phone case - Works with Amazon Echo & Amazon Fire",
                    source: "RandomSellerXYZ",
                    link: "https://randomsellerxyz.example.com/product/1",
                    price: "₹499",
                },
            ],
            "fallback"
        );
        assert.strictEqual(offers.length, 1);
        assert.strictEqual(offers[0].store, "RandomSellerXYZ");
        assert.strictEqual(offers[0]._isTrustedRetailer, false);
    });

    test("Google Shopping redirect URL does not automatically grant/deny trust", () => {
        // Same merchant (Amazon via `source`), one with a direct URL, one
        // behind a Google Shopping redirect — trust must be identical for
        // both, since it is derived from merchant identity, not URL shape.
        const offers = extractOffers(
            [
                { title: "Product A", source: "Amazon.in", link: "https://amazon.in/dp/xyz", price: "₹1,000" },
                { title: "Product A", source: "Amazon.in", link: "https://www.google.com/search?ibp=oshop&q=x", price: "₹1,000" },
            ],
            "fallback"
        );
        assert.strictEqual(offers.length, 2);
        assert.strictEqual(offers[0]._isGoogleRedirectUrl, false);
        assert.strictEqual(offers[1]._isGoogleRedirectUrl, true);
        assert.strictEqual(offers[0]._isTrustedRetailer, true);
        assert.strictEqual(offers[1]._isTrustedRetailer, true);
    });

    test("Unresolvable/unknown merchant behind a Google redirect is not trusted merely for being a redirect", () => {
        const offers = extractOffers(
            [{ title: "Product B", link: "https://www.google.com/search?ibp=oshop&q=y", price: "₹1,000" }],
            "fallback"
        );
        assert.strictEqual(offers.length, 1);
        assert.strictEqual(offers[0]._isGoogleRedirectUrl, true);
        assert.strictEqual(offers[0]._isTrustedRetailer, false);
    });
}

// =====================================================================
// PART B — E2E: real compareService/compareEngine against a fake
// Serper HTTP layer (pattern mirrors scripts/regression-tests.js).
// =====================================================================

const { compareByQuery, compareProduct } = require(path.join(__dirname, "..", "..", "services", "compareService"));

function googleRedirect(i) {
    return `https://www.google.com/search?ibp=oshop&q=test&item=${i}`;
}

// Mirrors the Phase 8 audit's real live observation: a mix of trusted
// major retailers plus several unknown small resellers, one of which
// (Doberman-style) is priced far below the trusted cluster.
const FIXTURE_MIXED = [
    { title: "Samsung Galaxy S26 Ultra 256GB Titanium Black", source: "Amazon.in", link: "https://amazon.in/dp/aaa", price: "₹117,400" },
    { title: "Samsung Galaxy S26 Ultra 256GB Titanium Gray", source: "Flipkart.com", link: googleRedirect(1), price: "₹119,999" },
    { title: "Samsung Galaxy S26 Ultra 256GB Titanium Black", source: "Croma", link: googleRedirect(2), price: "₹121,490" },
    { title: "Samsung Galaxy S26 Ultra 256GB Titanium Black", source: "Reliance Digital", link: googleRedirect(3), price: "₹122,999" },
    // Unknown/untrusted sellers — must appear in the full-internet pool
    // but never in trustedOffers, regardless of price.
    { title: "Samsung Galaxy S26 Ultra 256GB Titanium Black", source: "Mygsm.me", link: googleRedirect(4), price: "₹89,219" },
    { title: "Samsung Galaxy S26 Ultra 256GB Titanium Black", source: "Doberman Group", link: googleRedirect(5), price: "₹92,500" },
];

async function runPartB() {
    await testAsync("Default trusted mode returns only registry-trusted offers", async () => {
        currentShopping = FIXTURE_MIXED;
        const result = await compareByQuery("Samsung Galaxy S26 Ultra 256GB");
        const trustedStores = result.trustedOffers.map((o) => o.platform);
        assert.ok(trustedStores.includes("Amazon"));
        assert.ok(trustedStores.includes("Flipkart"));
        assert.ok(!trustedStores.includes("Mygsm.me"));
        assert.ok(!trustedStores.includes("Doberman Group"));
    });

    await testAsync("Full-internet `results` still contains the untrusted offers (nothing destroyed)", async () => {
        currentShopping = FIXTURE_MIXED;
        const result = await compareByQuery("Samsung Galaxy S26 Ultra 256GB");
        const allStores = result.results.map((o) => o.platform);
        assert.ok(allStores.includes("Mygsm.me"), "untrusted offer must still be present in full-internet results");
        assert.ok(allStores.includes("Doberman Group"));
    });

    await testAsync("bestTrustedOffer is the cheapest eligible TRUSTED offer, not the cheapest overall", async () => {
        currentShopping = FIXTURE_MIXED;
        const result = await compareByQuery("Samsung Galaxy S26 Ultra 256GB");
        assert.ok(result.bestTrustedOffer, "expected a bestTrustedOffer");
        assert.strictEqual(result.bestTrustedOffer.platform, "Amazon");
        assert.strictEqual(result.bestTrustedOffer.price, 117400);
        // The legacy bestOffer (full internet, unchanged Phase 1-7
        // behavior) is allowed to be the cheaper untrusted listing —
        // Phase 8 must not silently change what bestOffer means.
        assert.ok(result.bestOffer.price <= result.bestTrustedOffer.price);
    });

    await testAsync("trustedSavings is computed only from the trusted pool (untrusted outlier price never leaks in)", async () => {
        currentShopping = FIXTURE_MIXED;
        const result = await compareByQuery("Samsung Galaxy S26 Ultra 256GB");
        // Trusted cluster: 117400..122999 -> spread 5599. Must NOT be
        // influenced by Mygsm.me's 89219 or Doberman's 92500.
        assert.strictEqual(result.trustedSavings, 122999 - 117400);
        assert.ok(result.trustedSavings < result.savings, "full-internet savings should reflect the wider (cheaper) spread");
    });

    await testAsync("Zero trusted offers is handled gracefully (no crash, empty array, null bestTrustedOffer)", async () => {
        currentShopping = [
            { title: "Samsung Galaxy S26 Ultra 256GB Titanium Black", source: "Mygsm.me", link: googleRedirect(0), price: "₹89,219" },
            { title: "Samsung Galaxy S26 Ultra 256GB Titanium Black", source: "Doberman Group", link: googleRedirect(1), price: "₹92,500" },
        ];
        const result = await compareByQuery("Samsung Galaxy S26 Ultra 256GB");
        assert.deepStrictEqual(result.trustedOffers, []);
        assert.strictEqual(result.bestTrustedOffer, null);
        assert.strictEqual(result.trustedSavings, 0);
        assert.strictEqual(result.trustedRetailerCount, 0);
        // Full-internet pool must still work normally.
        assert.ok(result.bestOffer);
    });

    await testAsync("Exactly one trusted offer is handled correctly (no fabricated savings)", async () => {
        currentShopping = [
            { title: "Samsung Galaxy S26 Ultra 256GB Titanium Black", source: "Amazon.in", link: "https://amazon.in/dp/aaa", price: "₹117,400" },
            { title: "Samsung Galaxy S26 Ultra 256GB Titanium Black", source: "Mygsm.me", link: googleRedirect(0), price: "₹89,219" },
        ];
        const result = await compareByQuery("Samsung Galaxy S26 Ultra 256GB");
        assert.strictEqual(result.trustedOffers.length, 1);
        assert.strictEqual(result.trustedRetailerCount, 1);
        assert.strictEqual(result.bestTrustedOffer.platform, "Amazon");
        assert.strictEqual(result.trustedSavings, 0, "a single-offer pool has no spread to report");
    });

    await testAsync("Phase 7 high-side outlier is excluded from the TRUSTED pool too", async () => {
        // Trusted cluster clusters around ~120k; one trusted-registry
        // merchant (Croma) posts a pathological 3x price — Phase 7's
        // existing high-side outlier logic (ratio > 2.0) must still
        // exclude it from bestTrustedOffer/trustedSavings, unmodified.
        currentShopping = [
            { title: "Samsung Galaxy S26 Ultra 256GB Titanium Black", source: "Amazon.in", link: "https://amazon.in/dp/aaa", price: "₹117,400" },
            { title: "Samsung Galaxy S26 Ultra 256GB Titanium Gray", source: "Flipkart.com", link: googleRedirect(1), price: "₹119,999" },
            { title: "Samsung Galaxy S26 Ultra 256GB Titanium Black", source: "Reliance Digital", link: googleRedirect(2), price: "₹122,999" },
            { title: "Samsung Galaxy S26 Ultra 256GB Titanium Black", source: "Croma", link: googleRedirect(3), price: "₹365,000" },
        ];
        const result = await compareByQuery("Samsung Galaxy S26 Ultra 256GB");
        const cromaTrusted = result.trustedOffers.find((o) => o.platform === "Croma");
        assert.ok(cromaTrusted, "Croma must still be visible in trustedOffers (never silently dropped)");
        assert.strictEqual(cromaTrusted.usableForBestOffer, false);
        assert.notStrictEqual(result.bestTrustedOffer.platform, "Croma");
        assert.ok(result.trustedSavings < 365000 - 117400, "outlier price must not inflate trustedSavings");
    });

    await testAsync("Full-internet mode (results/bestOffer/savings) is completely unaffected by trusted filtering", async () => {
        // Regression guard: Phase 8 must not change full-internet
        // semantics at all — same fixture as the very first
        // regression-tests.js S26 Ultra case, re-verified post-Phase-8.
        currentShopping = FIXTURE_MIXED;
        const result = await compareByQuery("Samsung Galaxy S26 Ultra 256GB");
        assert.strictEqual(result.bestOffer.platform, "Mygsm.me");
        assert.strictEqual(result.bestOffer.price, 89219);
        assert.strictEqual(result.internetOfferCount, result.results.filter((o) => !o.isPossibleMatch).length);
    });

    await testAsync("URL input still produces a correct product identity and a trusted pool", async () => {
        currentShopping = FIXTURE_MIXED;
        const result = await compareProduct("https://www.flipkart.com/samsung-galaxy-s26-ultra/p/itmxyz123");
        assert.ok(result.product.name, "product identity must still be extracted from the URL flow");
        assert.ok(Array.isArray(result.trustedOffers));
        assert.ok(result.trustedOffers.some((o) => o.platform === "Amazon"));
    });
}

async function main() {
    runPartA();
    await runPartB();

    console.log("\n=== SUMMARY ===");
    const passed = results.filter((r) => r.pass).length;
    const failed = results.filter((r) => !r.pass).length;
    console.log(`${passed}/${results.length} passed`);
    if (failed > 0) {
        console.log(`\n${failed} FAILED:`);
        results.filter((r) => !r.pass).forEach((r) => console.log(`  - ${r.name}: ${r.error}`));
        process.exitCode = 1;
    }
}

main().catch((err) => {
    console.error("Test suite error:", err);
    process.exitCode = 1;
});
