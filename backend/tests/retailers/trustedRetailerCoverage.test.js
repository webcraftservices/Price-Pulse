/**
 * Phase 8.1 — Trusted Retailer Coverage tests
 * ------------------------------------------------------------------
 * Covers the Phase 8.1 spec Section 27 checklist:
 *   - general query already covering a trusted retailer -> not re-queried
 *   - supplemental query surfaces a missing trusted retailer
 *   - duplicate retailer/product (same URL) across general + supplemental
 *     is deduplicated, not double-counted
 *   - a supplemental candidate from a TRUSTED retailer with the WRONG
 *     variant/generation still goes through the exact same matching
 *     pipeline and is rejected exactly like any other wrong candidate
 *     (spec Section 9 — trust never grants a matching shortcut)
 *   - MAX_TRUSTED_RETAILER_QUERIES bound is respected even when more
 *     trusted retailers are missing than the bound allows
 *   - one failing supplemental query never breaks the comparison
 *   - additionalOfferCount (Section 23 count-bug fix) is the DELTA
 *     beyond trusted, not the full-internet total
 *
 * Two layers, matching this repo's existing test convention:
 *   PART A — unit-level: trustedRetailerCoverage.planTrustedCoverageQueries
 *   PART B — E2E-level: runs the real, unmodified compareService.js /
 *            compareEngine.js against a fake Serper HTTP layer whose
 *            response varies BY QUERY TEXT (same pattern as
 *            tests/comparison/searchPlanner.test.js), so the two-stage
 *            adaptive flow is verified through the actual pipeline.
 *
 * USAGE: node backend/tests/retailers/trustedRetailerCoverage.test.js
 */

const assert = require("assert");
const path = require("path");
const Module = require("module");

// ---------------------------------------------------------------------
// Fake HTTP layer — responses vary BY QUERY TEXT so the general query vs.
// supplemental (retailer-targeted) queries are independently controllable,
// and a specific query can be made to fail without affecting the others.
// ---------------------------------------------------------------------

const queriesReceived = [];
const FAILING_QUERIES = new Set();

// query text (lowercased) -> shopping items. Anything not listed returns [].
const QUERY_FIXTURES = {
    // General query: Samsung Galaxy S26 Ultra 256GB 12GB — only ONE
    // trusted retailer (Reliance Digital) plus one untrusted seller. This
    // reproduces the exact Phase 8.1 spec Section 1 live observation.
    "samsung galaxy s26 ultra 256gb 12gb": [
        { title: "Samsung Galaxy S26 Ultra 256GB 12GB RAM", source: "Reliance Digital", link: "https://reliancedigital.in/p/1", price: "₹124999" },
        { title: "Samsung Galaxy S26 Ultra 256GB 12GB RAM", source: "Mygsm.me", link: "https://mygsm.me/p/1", price: "₹123499" },
    ],
    // Supplemental coverage queries (plain-keyword bias — see
    // trustedRetailerCoverage.js's "WHY NOT site:domain" doc comment).
    "samsung galaxy s26 ultra 256gb 12gb amazon": [
        { title: "Samsung Galaxy S26 Ultra 256GB 12GB RAM", source: "Amazon.in", link: "https://amazon.in/dp/xyz", price: "₹121999" },
    ],
    "samsung galaxy s26 ultra 256gb 12gb flipkart": [
        { title: "Samsung Galaxy S26 Ultra 256GB 12GB RAM", source: "Flipkart.com", link: "https://flipkart.com/p/abc", price: "₹122999" },
        // Same URL the general query already returned for Reliance Digital
        // — must collapse via dedup, never appear as a second offer.
        { title: "Samsung Galaxy S26 Ultra 256GB 12GB RAM (sponsored)", source: "Reliance Digital", link: "https://reliancedigital.in/p/1", price: "₹124999" },
    ],
    // Croma's supplemental listing is the WRONG generation (S25 vs S26) —
    // proves a trusted retailer gets NO matching shortcut (spec Section 9).
    "samsung galaxy s26 ultra 256gb 12gb croma": [
        { title: "Samsung Galaxy S25 Ultra 256GB 12GB RAM", source: "Croma", link: "https://croma.com/p/wrong-gen", price: "₹94999" },
    ],

    // Second product — used only for the provider-failure-resilience test.
    // No trusted retailer at all in the general query, so amazon/flipkart/
    // croma are all targeted (bounded at 3, vijay sales excluded by cap).
    "samsung galaxy s26 128gb 8gb": [
        { title: "Samsung Galaxy S26 128GB 8GB RAM", source: "Mygsm.me", link: "https://mygsm.me/p/2", price: "₹58999" },
    ],
    "samsung galaxy s26 128gb 8gb amazon": [
        { title: "Samsung Galaxy S26 128GB 8GB RAM", source: "Amazon.in", link: "https://amazon.in/dp/s26base", price: "₹56999" },
    ],
    "samsung galaxy s26 128gb 8gb croma": [
        { title: "Samsung Galaxy S26 128GB 8GB RAM", source: "Croma", link: "https://croma.com/p/s26base", price: "₹57999" },
    ],
    // "...flipkart" deliberately has NO fixture AND is in FAILING_QUERIES.
};

const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
    if (id === "axios") {
        return {
            post: async (url, body) => {
                if (typeof url === "string" && url.includes("/shopping")) {
                    const q = (body.q || "").toLowerCase().trim();
                    queriesReceived.push(q);
                    if (FAILING_QUERIES.has(q)) {
                        throw new Error(`simulated provider failure for query: ${q}`);
                    }
                    return { data: { shopping: QUERY_FIXTURES[q] || [] } };
                }
                return { data: { organic: [] } };
            },
            get: async () => ({ data: "" }),
        };
    }
    if (id === "cheerio") {
        return { load: () => () => ({ attr: () => null, first: () => ({ text: () => "" }) }) };
    }
    return originalRequire.apply(this, arguments);
};

process.env.SERPER_API_KEY = process.env.SERPER_API_KEY || "fake_key_for_phase8_1_test";
process.env.ENABLE_MERCHANT_URL_RESOLVER = "false"; // deterministic — no secondary URL resolution pass
delete process.env.COMPARISON_ENGINE_V2; // Phase 8.1 coverage is independent of the V2 multi-query flag

const results = [];
async function test(name, fn) {
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

// =====================================================================
// PART A — unit tests: trustedRetailerCoverage.planTrustedCoverageQueries
// =====================================================================

const {
    planTrustedCoverageQueries,
    MAX_TRUSTED_RETAILER_QUERIES,
} = require(path.join(__dirname, "..", "..", "comparison", "trustedRetailerCoverage"));

const S26_ULTRA = { name: "Samsung Galaxy S26 Ultra", brand: "Samsung", productName: "Galaxy S26 Ultra", model: "Galaxy S26 Ultra", storage: "256GB", ram: "12GB" };
const BASE_QUERY = "Samsung Galaxy S26 Ultra 256GB 12GB";

function runPartA() {
    return (async () => {
        await test("Unit: no trusted retailers present -> plans supplemental queries, bounded by MAX_TRUSTED_RETAILER_QUERIES", () => {
            const { queries, targetedRetailers } = planTrustedCoverageQueries(S26_ULTRA, BASE_QUERY, []);
            assert.ok(queries.length > 0, "expected at least one supplemental query");
            assert.ok(queries.length <= MAX_TRUSTED_RETAILER_QUERIES, `expected <= ${MAX_TRUSTED_RETAILER_QUERIES} queries, got ${queries.length}`);
            assert.strictEqual(queries.length, targetedRetailers.length, "queries and targetedRetailers must be index-aligned");
        });

        await test("Unit: queries never use site: syntax (unverified for the /shopping endpoint — see doc comment)", () => {
            const { queries } = planTrustedCoverageQueries(S26_ULTRA, BASE_QUERY, []);
            queries.forEach((q) => assert.ok(!q.includes("site:"), `query unexpectedly used site: syntax: ${q}`));
        });

        await test("Unit: a trusted retailer already represented in general offers is NEVER re-targeted", () => {
            const generalOffers = [{ store: "Amazon" }, { store: "Flipkart" }];
            const { targetedRetailers } = planTrustedCoverageQueries(S26_ULTRA, BASE_QUERY, generalOffers);
            assert.ok(!targetedRetailers.includes("amazon"), "amazon should not be re-targeted");
            assert.ok(!targetedRetailers.includes("flipkart"), "flipkart should not be re-targeted");
        });

        await test("Unit: every targeted retailer key is trusted:true in the registry (never guesses)", () => {
            const { targetedRetailers } = planTrustedCoverageQueries(S26_ULTRA, BASE_QUERY, []);
            const { REGISTRY } = require(path.join(__dirname, "..", "..", "providers", "merchants", "merchantRegistry"));
            targetedRetailers.forEach((key) => {
                assert.ok(REGISTRY[key] && REGISTRY[key].trusted === true, `${key} is not a registry-trusted retailer`);
            });
        });

        await test("Unit: full trusted coverage already present -> zero supplemental queries", () => {
            const generalOffers = [
                { store: "Amazon" }, { store: "Flipkart" }, { store: "Croma" },
                { store: "Reliance Digital" }, { store: "Vijay Sales" },
            ];
            const { queries } = planTrustedCoverageQueries(S26_ULTRA, BASE_QUERY, generalOffers);
            assert.strictEqual(queries.length, 0, "expected no supplemental queries when every category retailer is already present");
        });

        await test("Unit: TRUSTED_COVERAGE_ENABLED=false disables coverage entirely", () => {
            process.env.TRUSTED_COVERAGE_ENABLED = "false";
            try {
                const { queries } = planTrustedCoverageQueries(S26_ULTRA, BASE_QUERY, []);
                assert.strictEqual(queries.length, 0);
            } finally {
                delete process.env.TRUSTED_COVERAGE_ENABLED;
            }
        });

        await test("Unit: no base query -> no supplemental queries (never searches for nothing)", () => {
            const { queries } = planTrustedCoverageQueries(S26_ULTRA, "", []);
            assert.strictEqual(queries.length, 0);
        });
    })();
}

// =====================================================================
// PART B — E2E: full pipeline via compareService.compareByProduct
// =====================================================================

const { compareByProduct } = require(path.join(__dirname, "..", "..", "services", "compareService"));

const S26_ULTRA_PRODUCT = { name: "Samsung Galaxy S26 Ultra", brand: "Samsung", productName: "Galaxy S26 Ultra", model: "Galaxy S26 Ultra", storage: "256GB", ram: "12GB" };
const S26_BASE_PRODUCT = { name: "Samsung Galaxy S26", brand: "Samsung", productName: "Galaxy S26", model: "Galaxy S26", storage: "128GB", ram: "8GB" };

async function runPartB() {
    await test("E2E: general query covering only Reliance Digital -> supplemental queries add Amazon + Flipkart to trustedOffers", async () => {
        queriesReceived.length = 0;
        const result = await compareByProduct(S26_ULTRA_PRODUCT);
        assert.ok(queriesReceived.length >= 4, `expected general + >=3 supplemental queries, got ${queriesReceived.length}: ${queriesReceived.join(" | ")}`);
        const trustedPlatforms = result.trustedOffers.map((o) => o.platform).sort();
        assert.ok(trustedPlatforms.includes("Amazon"), `expected Amazon in trustedOffers, got: ${trustedPlatforms.join(", ")}`);
        assert.ok(trustedPlatforms.includes("Flipkart"), `expected Flipkart in trustedOffers, got: ${trustedPlatforms.join(", ")}`);
        assert.ok(trustedPlatforms.includes("Reliance Digital"), `expected Reliance Digital in trustedOffers, got: ${trustedPlatforms.join(", ")}`);
    });

    await test("E2E: untrusted seller from the general query (Mygsm.me) is preserved in full-internet results, never deleted", async () => {
        const result = await compareByProduct(S26_ULTRA_PRODUCT);
        const allPlatforms = result.results.map((o) => o.platform);
        assert.ok(allPlatforms.includes("Mygsm.me"), `expected Mygsm.me still present in full-internet results, got: ${allPlatforms.join(", ")}`);
        const trustedPlatforms = result.trustedOffers.map((o) => o.platform);
        assert.ok(!trustedPlatforms.includes("Mygsm.me"), "Mygsm.me must never appear in the trusted pool");
    });

    await test("E2E: duplicate URL across general (Reliance Digital) and supplemental (Flipkart query) is deduplicated, not double-counted", async () => {
        const result = await compareByProduct(S26_ULTRA_PRODUCT);
        const relianceOffers = result.results.filter((o) => o.platform === "Reliance Digital");
        assert.strictEqual(relianceOffers.length, 1, `expected exactly 1 Reliance Digital offer after dedup, got ${relianceOffers.length}`);
    });

    await test("E2E: trusted-retailer supplemental candidate with WRONG generation is still HARD_REJECT (no matching shortcut for being trusted)", async () => {
        const result = await compareByProduct(S26_ULTRA_PRODUCT);
        const allTitlesAnywhere = [...result.results, ...result.trustedOffers].map((o) => o.title || "");
        assert.ok(
            !allTitlesAnywhere.some((t) => t.includes("S25 Ultra")),
            "the wrong-generation Croma listing (S25 Ultra) must never appear in results or trustedOffers"
        );
    });

    await test("E2E: MAX_TRUSTED_RETAILER_QUERIES bound respected — at most that many supplemental queries were issued", async () => {
        queriesReceived.length = 0;
        await compareByProduct(S26_ULTRA_PRODUCT);
        // 1 general query + at most MAX_TRUSTED_RETAILER_QUERIES supplemental.
        assert.ok(
            queriesReceived.length <= 1 + MAX_TRUSTED_RETAILER_QUERIES,
            `expected <= ${1 + MAX_TRUSTED_RETAILER_QUERIES} total queries, got ${queriesReceived.length}: ${queriesReceived.join(" | ")}`
        );
        // Vijay Sales is priority position 5 for smartphones — with the
        // cap at 3 (default) and Reliance Digital already covered, it
        // must never be queried.
        assert.ok(
            !queriesReceived.some((q) => q.includes("vijay sales")),
            "Vijay Sales should have been dropped by the bound, but was queried"
        );
    });

    await test("E2E: additionalOfferCount is the DELTA beyond trusted, not the full-internet total (spec Section 23 fix)", async () => {
        const result = await compareByProduct(S26_ULTRA_PRODUCT);
        assert.strictEqual(
            result.additionalOfferCount,
            Math.max(0, result.internetOfferCount - result.trustedRetailerCount),
            `additionalOfferCount should equal internetOfferCount - trustedRetailerCount`
        );
        assert.ok(result.additionalOfferCount < result.internetOfferCount || result.trustedRetailerCount === 0,
            "additionalOfferCount must not equal the full-internet total when a trusted pool exists");
    });

    await test("E2E: one failing supplemental query (Flipkart) never breaks the comparison — Amazon/Croma still succeed", async () => {
        FAILING_QUERIES.add("samsung galaxy s26 128gb 8gb flipkart");
        try {
            const result = await compareByProduct(S26_BASE_PRODUCT);
            const trustedPlatforms = result.trustedOffers.map((o) => o.platform);
            assert.ok(trustedPlatforms.includes("Amazon"), `expected Amazon despite Flipkart query failure, got: ${trustedPlatforms.join(", ")}`);
            assert.ok(trustedPlatforms.includes("Croma"), `expected Croma despite Flipkart query failure, got: ${trustedPlatforms.join(", ")}`);
        } finally {
            FAILING_QUERIES.delete("samsung galaxy s26 128gb 8gb flipkart");
        }
    });

    await test("E2E backward compatibility: results/bestOffer/bestDirectOffer/savings retain their pre-Phase-8.1 shape", async () => {
        const result = await compareByProduct(S26_ULTRA_PRODUCT);
        assert.ok(Array.isArray(result.results));
        assert.ok("bestOffer" in result);
        assert.ok("bestDirectOffer" in result);
        assert.ok(typeof result.savings === "number");
        assert.ok(Array.isArray(result.trustedOffers), "trustedOffers must still be present (Phase 8 field)");
    });
}

async function main() {
    await runPartA();
    await runPartB();

    console.log("\n=== SUMMARY ===");
    const passed = results.filter((r) => r.pass).length;
    console.log(`${passed}/${results.length} passed`);
    if (passed !== results.length) process.exitCode = 1;
}

main();
