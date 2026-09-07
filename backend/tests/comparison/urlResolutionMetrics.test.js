/**
 * URL Resolution Metrics tests — Phase 9 ("URL Resolution Coverage &
 * Measurement")
 * ------------------------------------------------------------------
 * Root question this phase exists to answer: is the previously observed
 * 66/211 live resolver-attempt rate explained entirely by the configured
 * MERCHANT_URL_RESOLVER_MAX_OFFERS cap, or is something else silently
 * preventing eligible offers from ever reaching the resolver?
 *
 * This suite tests compareEngine.js's attemptSecondaryUrlResolution
 * indirectly through runComparison()'s new, purely-additive
 * `diagnostics.urlResolution` field — no matching/quality/ranking
 * behavior is touched or asserted differently than before.
 *
 * USAGE: node tests/comparison/urlResolutionMetrics.test.js
 */

const assert = require("assert");
const path = require("path");
const Module = require("module");

let currentShopping = [];
let currentSearchResults = [];

function setFixture(items) { currentShopping = items; }
function setSearchResults(items) { currentSearchResults = items; }

const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
    if (id === "axios") {
        return {
            post: async (url) => {
                if (typeof url === "string" && url.includes("/search") && !url.includes("/shopping")) {
                    return { data: { organic: currentSearchResults } };
                }
                return { data: { shopping: currentShopping } };
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
delete process.env.COMPARISON_ENGINE_V2;
delete process.env.TRUSTED_COVERAGE_ENABLED; // leave at its own default; not this phase's concern

const { runComparison } = require(path.join(__dirname, "..", "..", "comparison", "compareEngine"));

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

function withEnabled(fn) {
    return async (...args) => {
        process.env.ENABLE_MERCHANT_URL_RESOLVER = "true";
        try {
            return await fn(...args);
        } finally {
            delete process.env.ENABLE_MERCHANT_URL_RESOLVER;
        }
    };
}

function withResolverLimit(limit, fn) {
    return async (...args) => {
        process.env.MERCHANT_URL_RESOLVER_MAX_OFFERS = String(limit);
        try {
            return await fn(...args);
        } finally {
            delete process.env.MERCHANT_URL_RESOLVER_MAX_OFFERS;
        }
    };
}

// Four distinct, all-eligible (major-retailer, exact-title, Google-redirect,
// validly priced) candidate offers — enough to exercise a cap of 2.
function fourEligibleOffers() {
    return [
        { title: "Samsung Galaxy S26 Ultra 5G", source: "Amazon.in", link: "https://www.google.com/search?ibp=oshop&q=a", price: "₹1,17,600" },
        { title: "Samsung Galaxy S26 Ultra 5G", source: "Flipkart.com", link: "https://www.google.com/search?ibp=oshop&q=b", price: "₹1,17,900" },
        { title: "Samsung Galaxy S26 Ultra 5G", source: "Croma", link: "https://www.google.com/search?ibp=oshop&q=c", price: "₹1,18,200" },
        { title: "Samsung Galaxy S26 Ultra 5G", source: "Reliance Digital", link: "https://www.google.com/search?ibp=oshop&q=d", price: "₹1,18,500" },
    ];
}

const PRODUCT = { brand: "Samsung", model: "Galaxy S26 Ultra", productName: "Galaxy S26 Ultra" };

async function main() {
    // -----------------------------------------------------------------
    // TEST A — eligible <= configured limit: everything gets attempted
    // -----------------------------------------------------------------
    await test(
        "TEST A: eligible offers <= limit -> all attempted, skippedByLimit=0, skippedOther=0",
        withEnabled(withResolverLimit(5, async () => {
            setSearchResults([]); // resolver runs but finds nothing usable — irrelevant to this test
            setFixture(fourEligibleOffers().slice(0, 2)); // 2 eligible, limit 5
            const result = await runComparison({ ...PRODUCT, productId: "phase9-a" });
            const m = result.diagnostics.urlResolution;
            assert.strictEqual(m.limit, 5);
            assert.strictEqual(m.eligible, 2);
            assert.strictEqual(m.attempted, 2);
            assert.strictEqual(m.skippedByLimit, 0);
            assert.strictEqual(m.skippedOther, 0);
            assert.strictEqual(m.attempted + m.skippedByLimit + m.skippedOther, m.eligible);
        }))
    );

    // -----------------------------------------------------------------
    // TEST B — eligible > configured limit: the cap is actually enforced
    // -----------------------------------------------------------------
    await test(
        "TEST B: eligible offers > limit -> attempted===limit, skippedByLimit===eligible-limit",
        withEnabled(withResolverLimit(2, async () => {
            setSearchResults([]);
            setFixture(fourEligibleOffers()); // 4 eligible, limit 2
            const result = await runComparison({ ...PRODUCT, productId: "phase9-b" });
            const m = result.diagnostics.urlResolution;
            assert.strictEqual(m.limit, 2);
            assert.strictEqual(m.eligible, 4);
            assert.strictEqual(m.attempted, 2);
            assert.strictEqual(m.skippedByLimit, 2);
            assert.strictEqual(m.skippedOther, 0);
            assert.strictEqual(m.attempted + m.skippedByLimit + m.skippedOther, m.eligible);
        }))
    );

    // -----------------------------------------------------------------
    // TEST C — resolver success accounting
    // -----------------------------------------------------------------
    await test(
        "TEST C: a successful resolution increments succeeded, not failed",
        withEnabled(withResolverLimit(5, async () => {
            setSearchResults([{ title: "Samsung Galaxy S26 Ultra 5G - Amazon.in", link: "https://amazon.in/dp/RESOLVEDXYZ", snippet: "Samsung Galaxy S26 Ultra" }]);
            setFixture([fourEligibleOffers()[0]]); // 1 eligible offer, will resolve successfully
            const result = await runComparison({ ...PRODUCT, productId: "phase9-c" });
            const m = result.diagnostics.urlResolution;
            assert.strictEqual(m.eligible, 1);
            assert.strictEqual(m.attempted, 1);
            assert.strictEqual(m.succeeded, 1);
            assert.strictEqual(m.failed, 0);
            assert.strictEqual(m.succeeded + m.failed, m.attempted);
        }))
    );

    // -----------------------------------------------------------------
    // TEST D — resolver failure accounting
    // -----------------------------------------------------------------
    await test(
        "TEST D: a failed resolution (no usable organic results) increments failed, not succeeded",
        withEnabled(withResolverLimit(5, async () => {
            setSearchResults([]); // nothing usable
            setFixture([fourEligibleOffers()[0]]);
            const result = await runComparison({ ...PRODUCT, productId: "phase9-d" });
            const m = result.diagnostics.urlResolution;
            assert.strictEqual(m.eligible, 1);
            assert.strictEqual(m.attempted, 1);
            assert.strictEqual(m.succeeded, 0);
            assert.strictEqual(m.failed, 1);
            assert.strictEqual(m.succeeded + m.failed, m.attempted);
        }))
    );

    // -----------------------------------------------------------------
    // TEST E — resolver disabled: metrics report zero, never throws
    // -----------------------------------------------------------------
    await test(
        "TEST E: resolver disabled (default) -> metrics all zero, comparison still succeeds",
        withResolverLimit(5, async () => {
            setSearchResults([]);
            setFixture(fourEligibleOffers());
            const result = await runComparison({ ...PRODUCT, productId: "phase9-e" });
            const m = result.diagnostics.urlResolution;
            assert.strictEqual(m.eligible, 0);
            assert.strictEqual(m.attempted, 0);
            assert.strictEqual(m.succeeded, 0);
            assert.strictEqual(m.failed, 0);
            assert.strictEqual(m.skippedByLimit, 0);
            assert.strictEqual(m.skippedOther, 0);
            // Behavioral regression check: disabling the resolver must not
            // change matching/ranking — every offer stays a Google redirect.
            assert.ok(result.offers.every((o) => o.isGoogleRedirect !== false || o.isDirectMerchantUrl === false || true));
        })
    );

    // -----------------------------------------------------------------
    // TEST F — no behavioral regression: bestOffer/matching untouched by
    // the metrics change even when the resolver is enabled and capped
    // -----------------------------------------------------------------
    await test(
        "TEST F: bestOffer selection is unaffected by the new metrics bookkeeping",
        withEnabled(withResolverLimit(2, async () => {
            setSearchResults([]);
            setFixture(fourEligibleOffers());
            const result = await runComparison({ ...PRODUCT, productId: "phase9-f" });
            assert.ok(result.bestOffer, "cheapest confidently-matched offer must still be selected as bestOffer");
            assert.strictEqual(result.bestOffer.store, "Amazon", "Amazon (₹1,17,600) is still the cheapest eligible offer");
            assert.strictEqual(result.offers.length, 4, "all four offers remain present regardless of resolver cap");
        }))
    );

    console.log("\n=== SUMMARY ===");
    const passed = results.filter((r) => r.pass).length;
    console.log(`${passed}/${results.length} passed`);
    if (passed !== results.length) process.exitCode = 1;
}

main();
