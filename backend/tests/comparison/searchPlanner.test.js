/**
 * Phase 4 — Search Planner / Candidate Collector / Quality Score tests
 * ------------------------------------------------------------------
 * Fixture-based, deterministic, no network or SERPER_API_KEY (same
 * approach as scripts/regression-tests.js). Proves three things:
 *
 *  1. V1 parity: with COMPARISON_ENGINE_V2 unset, the search planner
 *     itself still issues exactly ONE general query — that refactor
 *     remains a true no-op by default. (Phase 8.1 adds its own,
 *     independent, bounded trusted-retailer coverage queries on top of
 *     this — see the updated assertion below; it is intentionally
 *     active by default and is not gated by COMPARISON_ENGINE_V2.)
 *  2. V2 behavior: with COMPARISON_ENGINE_V2=true, multiple queries are
 *     issued and their results are merged (more candidates found, cross-
 *     query duplicate URLs collapsed).
 *  3. qualityScore/urlConfidence are attached and sane, in both modes.
 *
 * USAGE: node tests/comparison/searchPlanner.test.js
 */

const assert = require("assert");
const path = require("path");
const Module = require("module");

// ---------------------------------------------------------------------
// Fake HTTP layer — responses vary BY QUERY TEXT, so multi-query fan-out
// is actually observable (unlike regression-tests.js's single global
// fixture, which is intentionally query-agnostic).
// ---------------------------------------------------------------------

const queriesReceived = [];

// Query -> shopping items. Anything not listed here returns [].
const QUERY_FIXTURES = {
    "samsung galaxy s26 ultra 256gb titanium black": [
        { title: "Samsung Galaxy S26 Ultra 256GB Titanium Black", source: "Amazon.in", link: "https://amazon.in/dp/aaa", price: "₹129,999" },
    ],
    "samsung galaxy s26 ultra 256gb titanium black price india": [
        { title: "Samsung Galaxy S26 Ultra 256GB Titanium Black", source: "Flipkart.com", link: "https://www.google.com/search?ibp=oshop&q=x&item=2", price: "₹127,999" },
        // Exact same URL as the base query's Amazon result — must be
        // collapsed by deduplicateByUrl, not counted twice.
        { title: "Samsung Galaxy S26 Ultra 256GB Titanium Black (Amazon)", source: "Amazon.in", link: "https://amazon.in/dp/aaa", price: "₹129,999" },
    ],
    "samsung galaxy s26 ultra 256gb": [
        { title: "Samsung Galaxy S26 Ultra 256GB", source: "Croma", link: "https://www.google.com/search?ibp=oshop&q=x&item=3", price: "₹131,499" },
    ],
};

const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
    if (id === "axios") {
        return {
            post: async (url, body) => {
                if (typeof url === "string" && url.includes("/shopping")) {
                    const q = (body.q || "").toLowerCase().trim();
                    queriesReceived.push(q);
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

process.env.SERPER_API_KEY = process.env.SERPER_API_KEY || "fake_key_for_regression_test";

const { compareByProduct } = require(path.join(__dirname, "..", "..", "services", "compareService"));
const { planQueries } = require(path.join(__dirname, "..", "..", "comparison", "searchPlanner"));
const { MAX_TRUSTED_RETAILER_QUERIES } = require(path.join(__dirname, "..", "..", "comparison", "trustedRetailerCoverage"));

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

const PRODUCT = { name: "Samsung Galaxy S26 Ultra", brand: "Samsung", productName: "Galaxy S26 Ultra", model: "Galaxy S26 Ultra", storage: "256gb", color: "Titanium Black" };

async function main() {
    await test("Planner unit: multiQuery=false returns exactly one query", () => {
        const queries = planQueries(PRODUCT, { multiQuery: false });
        assert.strictEqual(queries.length, 1);
    });

    await test("Planner unit: multiQuery=true returns more than one query, bounded by MAX_QUERIES", () => {
        const { MAX_QUERIES } = require(path.join(__dirname, "..", "..", "comparison", "searchPlanner"));
        const queries = planQueries(PRODUCT, { multiQuery: true });
        assert.ok(queries.length > 1, `expected >1 query, got ${queries.length}`);
        assert.ok(queries.length <= MAX_QUERIES, `expected <= ${MAX_QUERIES} queries, got ${queries.length}`);
    });

    await test("V1 parity + Phase 8.1: COMPARISON_ENGINE_V2 unset still plans exactly ONE general query (search-planner V2 behavior itself is a true no-op by default); the ONLY other calls allowed are bounded Phase 8.1 trusted-retailer coverage queries, which are an independent capability and are intentionally active by default", async () => {
        delete process.env.COMPARISON_ENGINE_V2;
        queriesReceived.length = 0;
        const baseQuery = "samsung galaxy s26 ultra 256gb titanium black";

        const result = await compareByProduct(PRODUCT);

        // The search planner's own V1 behavior is unchanged: exactly one
        // GENERAL query is issued.
        const generalCount = queriesReceived.filter((q) => q === baseQuery).length;
        assert.strictEqual(generalCount, 1, `expected exactly 1 general query, got ${generalCount}: ${queriesReceived.join(" | ")}`);

        // Everything else must be a Phase 8.1 coverage query of the exact
        // shape "<general query> <trusted retailer label>" — never an
        // arbitrary extra general-search query, and never for Amazon
        // (already found by the general query, so it must not be
        // re-targeted — spec Section 11).
        const supplemental = queriesReceived.filter((q) => q !== baseQuery);
        const allowedRetailerSuffixes = ["flipkart", "croma", "reliance digital", "vijay sales"];
        supplemental.forEach((q) => {
            assert.ok(q.startsWith(baseQuery + " "), `unexpected query that is neither the general query nor a coverage query: ${q}`);
            const suffix = q.slice(baseQuery.length + 1);
            assert.ok(allowedRetailerSuffixes.includes(suffix), `unexpected coverage target "${suffix}" in query: ${q}`);
        });
        assert.ok(!supplemental.includes(`${baseQuery} amazon`), "Amazon was already found by the general query and must not be re-queried");

        // Bounded — never more supplemental queries than the configured max.
        assert.ok(supplemental.length <= MAX_TRUSTED_RETAILER_QUERIES, `expected <= ${MAX_TRUSTED_RETAILER_QUERIES} supplemental queries, got ${supplemental.length}: ${supplemental.join(" | ")}`);
        assert.ok(supplemental.length >= 1, "expected at least one Phase 8.1 coverage query since only Amazon was found by the general query");

        // None of the QUERY_FIXTURES above define data for any coverage
        // query text, so every coverage query legitimately returns zero
        // offers here — the final result set must still be exactly the
        // Amazon listing the general query found, proving coverage never
        // fabricates or duplicates offers when nothing new is found.
        assert.strictEqual(result.results.length, 1, "expected only the Amazon listing from the general query");
        assert.strictEqual(result.results[0].platform, "Amazon");
    });

    await test("V2 behavior: COMPARISON_ENGINE_V2=true issues multiple Serper calls and merges results", async () => {
        process.env.COMPARISON_ENGINE_V2 = "true";
        queriesReceived.length = 0;
        const result = await compareByProduct(PRODUCT);
        assert.ok(queriesReceived.length > 1, `expected >1 query, got ${queriesReceived.length}`);
        // Amazon (query 1), Flipkart (query 2), Croma (query 3) — three
        // distinct merchants found across three queries.
        const platforms = result.results.map((o) => o.platform).sort();
        assert.deepStrictEqual(platforms, ["Amazon", "Croma", "Flipkart"]);
    });

    await test("V2 behavior: cross-query duplicate URL (same Amazon link in two queries) is not double-counted", async () => {
        process.env.COMPARISON_ENGINE_V2 = "true";
        const result = await compareByProduct(PRODUCT);
        const amazonOffers = result.results.filter((o) => o.platform === "Amazon");
        assert.strictEqual(amazonOffers.length, 1, `expected exactly 1 Amazon offer, got ${amazonOffers.length}`);
    });

    await test("Quality score: attached, in range, and highest for the verified direct-URL offer", async () => {
        process.env.COMPARISON_ENGINE_V2 = "true";
        const result = await compareByProduct(PRODUCT);
        for (const offer of result.results) {
            assert.ok(typeof offer.qualityScore === "number" && offer.qualityScore >= 0 && offer.qualityScore <= 100, `qualityScore out of range: ${offer.qualityScore}`);
            assert.ok(typeof offer.urlConfidence === "number", "urlConfidence should be a number");
        }
        const amazon = result.results.find((o) => o.platform === "Amazon"); // direct URL
        const croma = result.results.find((o) => o.platform === "Croma"); // google redirect
        assert.ok(amazon.qualityScore > croma.qualityScore, `expected Amazon (direct URL) qualityScore ${amazon.qualityScore} > Croma (redirect) ${croma.qualityScore}`);
    });

    delete process.env.COMPARISON_ENGINE_V2;

    console.log("\n=== SUMMARY ===");
    const passed = results.filter((r) => r.pass).length;
    console.log(`${passed}/${results.length} passed`);
    if (passed !== results.length) process.exitCode = 1;
}

main();
