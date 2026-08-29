/**
 * Merchant URL Resolution tests — Phase 3 ("Merchant URL Resolution &
 * Direct Buy Links")
 * ------------------------------------------------------------------
 * Root problem: every offer Serper returns is a google.com/search?ibp=oshop
 * redirect, so `bestDirectOffer` was always null even when a perfectly
 * good, trusted, confident bestOffer existed (e.g. the real live bestOffer,
 * "MRV electronics" — which isn't even in the small static domain
 * allowlist, so the old allowlist-only resolver could never have resolved
 * it under any configuration).
 *
 * This suite tests comparison/urlResolver.js directly (unit-level) and
 * the real, unmodified compareService.js end-to-end, covering the spec's
 * full TEST 1-20 list plus the MRV-electronics (non-allowlisted merchant)
 * scenario that motivated the new MEDIUM-confidence discovery path.
 *
 * USAGE: node tests/urls/merchantUrlResolution.test.js
 */

const assert = require("assert");
const path = require("path");
const Module = require("module");

let currentShopping = [];
let currentSearchResults = [];
let searchFailureMode = null; // null | "error" | "timeout"
let searchCallCount = 0;

function setFixture(items) { currentShopping = items; }
function setSearchResults(items) { currentSearchResults = items; }
function setSearchFailure(mode) { searchFailureMode = mode; }
function resetSearchCallCount() { searchCallCount = 0; }

const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
    if (id === "axios") {
        return {
            post: async (url) => {
                if (typeof url === "string" && url.includes("/search") && !url.includes("/shopping")) {
                    searchCallCount += 1;
                    if (searchFailureMode === "error") {
                        const err = new Error("Request failed with status code 500 (simulated merchant search failure)");
                        err.response = { status: 500 };
                        throw err;
                    }
                    if (searchFailureMode === "timeout") {
                        const err = new Error("timeout of 6000ms exceeded");
                        err.code = "ECONNABORTED";
                        throw err;
                    }
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

const { compareByProduct } = require(path.join(__dirname, "..", "..", "services", "compareService"));
const {
    resolveDirectMerchantUrlDetailed,
    looksLikeGenericOrSearchPage,
    merchantNameMatchesHostname,
} = require(path.join(__dirname, "..", "..", "comparison", "urlResolver"));
const { isSafeExternalUrl, isPrivateOrLocalHost } = require(path.join(__dirname, "..", "..", "utils", "url"));

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

async function main() {
    // -----------------------------------------------------------------
    // TEST 1 — already-direct merchant URL remains unchanged
    // -----------------------------------------------------------------
    await test("TEST 1: an already-direct (non-Google) URL from Serper is preserved unchanged, resolver never invoked", async () => {
        setSearchResults([{ title: "should not be reached", link: "https://amazon.in/dp/SHOULDNOTBEUSED" }]);
        resetSearchCallCount();
        setFixture([{ title: "Samsung Galaxy S26 Ultra 5G", source: "Amazon.in", link: "https://amazon.in/dp/real123", price: "₹1,17,600" }]);
        const result = await compareByProduct({ brand: "Samsung", model: "Galaxy S26 Ultra", productName: "Galaxy S26 Ultra" });
        const amazon = result.results.find((r) => r.platform === "Amazon");
        assert.strictEqual(amazon.url, "https://amazon.in/dp/real123");
        assert.strictEqual(amazon.isGoogleRedirect, false);
        assert.strictEqual(amazon.isDirectMerchantUrl, true);
        assert.strictEqual(amazon.urlResolutionStatus, "already_direct");
        assert.strictEqual(searchCallCount, 0, "resolver must never be invoked for an offer that's already direct");
    });

    // -----------------------------------------------------------------
    // TEST 2 — Google Shopping URL + successful resolution -> direct URL
    // -----------------------------------------------------------------
    await test("TEST 2: Google Shopping URL + successful resolution (allowlisted merchant) becomes a HIGH-confidence direct URL", withEnabled(async () => {
        setSearchResults([{ title: "Samsung Galaxy S26 Ultra 5G - Amazon.in", link: "https://amazon.in/dp/RESOLVED456", snippet: "Samsung Galaxy S26 Ultra 256GB" }]);
        setFixture([{ title: "Samsung Galaxy S26 Ultra 5G", source: "Amazon.in", link: "https://www.google.com/search?ibp=oshop&q=t2", price: "₹1,17,600" }]);
        const result = await compareByProduct({ brand: "Samsung", model: "Galaxy S26 Ultra", productName: "Galaxy S26 Ultra", storage: "256GB", productId: "test2-unique" });
        const amazon = result.results.find((r) => r.platform === "Amazon");
        assert.strictEqual(amazon.url, "https://amazon.in/dp/RESOLVED456");
        assert.strictEqual(amazon.isGoogleRedirect, false);
        assert.strictEqual(amazon.isDirectMerchantUrl, true);
        assert.strictEqual(amazon.urlConfidence, 100, "allowlisted-domain resolution is HIGH confidence");
        assert.strictEqual(amazon.merchantUrlSource, "merchant_url_resolver");
        assert.strictEqual(amazon.urlResolutionStatus, "resolved");
    }));

    // -----------------------------------------------------------------
    // TEST 3 — Google Shopping URL + failed resolution -> original preserved
    // -----------------------------------------------------------------
    await test("TEST 3: failed resolution (no usable organic results) preserves the original Google URL, offer NOT removed", withEnabled(async () => {
        setSearchResults([]);
        setFixture([{ title: "Samsung Galaxy S26 Ultra 5G", source: "Amazon.in", link: "https://www.google.com/search?ibp=oshop&q=t3", price: "₹1,17,600" }]);
        const result = await compareByProduct({ brand: "Samsung", model: "Galaxy S26 Ultra", productName: "Galaxy S26 Ultra", productId: "test3-unique" });
        const amazon = result.results.find((r) => r.platform === "Amazon");
        assert.ok(amazon, "the offer must still be present in results");
        assert.strictEqual(amazon.isGoogleRedirect, true);
        assert.strictEqual(amazon.isDirectMerchantUrl, false);
        assert.strictEqual(amazon.urlResolutionStatus, "failed");
        assert.strictEqual(result.bestOffer.platform, "Amazon", "a valid priced offer must still be eligible for bestOffer despite failed URL resolution");
    }));

    // -----------------------------------------------------------------
    // TEST 4 / 18 — resolved URL from the wrong merchant is rejected
    // -----------------------------------------------------------------
    await test("TEST 4/18: a candidate URL from a different merchant's domain is rejected by domain verification", withEnabled(async () => {
        setSearchResults([{ title: "Samsung Galaxy S26 Ultra", link: "https://flipkart.com/p/wrongmerchant" }]);
        const resolved = await resolveDirectMerchantUrlDetailed("Amazon", "Samsung Galaxy S26 Ultra 256GB__t4", { matchValidator: () => true });
        assert.strictEqual(resolved, null, "a Flipkart URL must never be accepted as an Amazon resolution");
    }));

    // -----------------------------------------------------------------
    // TEST 5 — resolved URL is a generic homepage -> rejected
    // -----------------------------------------------------------------
    await test("TEST 5: a bare homepage URL is rejected as a product page", () => {
        assert.strictEqual(looksLikeGenericOrSearchPage("https://mrvelectronics.in/"), true);
        assert.strictEqual(looksLikeGenericOrSearchPage("https://mrvelectronics.in"), true);
    });

    // -----------------------------------------------------------------
    // TEST 6 — resolved URL is a search page -> rejected
    // -----------------------------------------------------------------
    await test("TEST 6: a search-results-shaped URL is rejected as a product page", () => {
        assert.strictEqual(looksLikeGenericOrSearchPage("https://amazon.in/s?k=samsung+galaxy+s26+ultra"), true);
        assert.strictEqual(looksLikeGenericOrSearchPage("https://mrvelectronics.in/search?q=galaxy"), true);
        assert.strictEqual(looksLikeGenericOrSearchPage("https://mrvelectronics.in/category/smartphones"), true);
    });

    // -----------------------------------------------------------------
    // TEST 7 — resolved URL strongly matches requested product -> accepted
    // -----------------------------------------------------------------
    await test("TEST 7: a genuine, strongly-matching product page is accepted end to end", withEnabled(async () => {
        setSearchResults([{ title: "Samsung Galaxy S26 Ultra 5G - Amazon.in", link: "https://amazon.in/dp/GENUINE789", snippet: "Samsung Galaxy S26 Ultra 256GB" }]);
        setFixture([{ title: "Samsung Galaxy S26 Ultra 5G", source: "Amazon.in", link: "https://www.google.com/search?ibp=oshop&q=t7", price: "₹1,17,600" }]);
        const result = await compareByProduct({ brand: "Samsung", model: "Galaxy S26 Ultra", productName: "Galaxy S26 Ultra", storage: "256GB", productId: "test7-unique" });
        const amazon = result.results.find((r) => r.platform === "Amazon");
        assert.strictEqual(amazon.url, "https://amazon.in/dp/GENUINE789");
        assert.strictEqual(amazon.isDirectMerchantUrl, true);
    }));

    // -----------------------------------------------------------------
    // TEST 8 / 17 — wrong product page / canonical product mismatch -> rejected
    // -----------------------------------------------------------------
    await test("TEST 8/17: a candidate page for the wrong product (canonical mismatch) is rejected by relevance validation", withEnabled(async () => {
        setSearchResults([{ title: "Samsung Galaxy S25 Ultra - Amazon.in", link: "https://amazon.in/dp/WRONGGEN", snippet: "Samsung Galaxy S25 Ultra 256GB" }]);
        setFixture([{ title: "Samsung Galaxy S26 Ultra 5G", source: "Amazon.in", link: "https://www.google.com/search?ibp=oshop&q=t8", price: "₹1,17,600" }]);
        const result = await compareByProduct({ brand: "Samsung", model: "Galaxy S26 Ultra", productName: "Galaxy S26 Ultra", storage: "256GB", productId: "test8-unique" });
        const amazon = result.results.find((r) => r.platform === "Amazon");
        // The resolver's matchValidator uses the SAME Gate 1 identity logic
        // as the rest of the pipeline — a wrong-generation candidate page
        // must be rejected exactly like a wrong-generation offer is.
        assert.strictEqual(amazon.isGoogleRedirect, true, "wrong-generation candidate page must be rejected, original URL preserved");
        assert.strictEqual(amazon.urlResolutionStatus, "failed");
    }));

    // -----------------------------------------------------------------
    // TEST 9 — suspicious offer with a direct URL cannot become bestDirectOffer
    // -----------------------------------------------------------------
    await test("TEST 9: a suspicious offerQuality offer never becomes bestDirectOffer, even with a perfectly valid direct URL", async () => {
        setFixture([
            { title: "Samsung Galaxy S26 Ultra & && ()", source: "desertcart", link: "https://desertcart.example/product/genuine-direct-url", price: "₹5,389" },
            { title: "Samsung Galaxy S26 Ultra", source: "MRV electronics", link: "https://mrv.example/product/s26u", price: "₹94,999" },
        ]);
        const result = await compareByProduct({ brand: "Samsung", model: "Galaxy S26 Ultra", productName: "Galaxy S26 Ultra" });
        const desertcart = result.results.find((r) => r.platform === "desertcart");
        assert.strictEqual(desertcart.isDirectMerchantUrl, true, "desertcart's URL is genuinely direct in this fixture");
        assert.strictEqual(desertcart.offerQuality, "suspicious");
        assert.notStrictEqual(result.bestDirectOffer && result.bestDirectOffer.platform, "desertcart", "a suspicious offer must never win bestDirectOffer regardless of URL quality");
        assert.strictEqual(result.bestDirectOffer.platform, "MRV electronics");
    });

    // -----------------------------------------------------------------
    // TEST 10 — hardRejected offer with a direct URL cannot become bestDirectOffer
    // -----------------------------------------------------------------
    await test("TEST 10: a hard-rejected (wrong generation) offer with a direct URL never becomes bestDirectOffer", async () => {
        setFixture([
            { title: "Samsung Galaxy S25 Ultra", source: "OldStore", link: "https://oldstore.example/product/s25u", price: "₹70,000" },
            { title: "Samsung Galaxy S26 Ultra", source: "MRV electronics", link: "https://mrv.example/product/s26u", price: "₹94,999" },
        ]);
        const result = await compareByProduct({ brand: "Samsung", model: "Galaxy S26 Ultra", productName: "Galaxy S26 Ultra" });
        assert.ok(!result.results.some((r) => r.platform === "OldStore"), "hard-rejected offer must be fully excluded from results");
        assert.strictEqual(result.bestDirectOffer.platform, "MRV electronics");
    });

    // -----------------------------------------------------------------
    // TEST 11 — possible match with a direct URL respects existing eligibility
    // -----------------------------------------------------------------
    await test("TEST 11: a possible-match (sub-0.75 confidence) offer with a direct URL still cannot become bestDirectOffer", async () => {
        setFixture([
            // Vague/partial title -> lands below BEST_OFFER_MATCH_THRESHOLD (0.75)
            // without tripping Gate 1 at all (same technique as the Gate 2 suite).
            { title: "Samsung Galaxy Ultra Smartphone Titanium 5G", source: "VagueStore", link: "https://vaguestore.example/product/x", price: "₹80,000" },
            { title: "Samsung Galaxy S26 Ultra", source: "MRV electronics", link: "https://mrv.example/product/s26u", price: "₹94,999" },
        ]);
        const result = await compareByProduct({ brand: "Samsung", model: "Galaxy S26 Ultra", productName: "Galaxy S26 Ultra", storage: "256GB", ram: "12GB" });
        const vague = result.results.find((r) => r.platform === "VagueStore");
        console.log(`      VagueStore: matchConfidence=${vague.matchConfidence} isPossibleMatch=${vague.isPossibleMatch} isDirectMerchantUrl=${vague.isDirectMerchantUrl}`);
        assert.strictEqual(vague.isDirectMerchantUrl, true, "VagueStore's URL is genuinely direct — this test isolates URL quality from match confidence");
        assert.strictEqual(vague.isPossibleMatch, true, "test setup expects a sub-0.75-confidence possible match");
        assert.strictEqual(result.bestDirectOffer.platform, "MRV electronics", "a possible match must never win bestDirectOffer merely for having a good URL");
    });

    // -----------------------------------------------------------------
    // TEST 12 — resolver disabled: no resolver calls, existing URLs unchanged
    // -----------------------------------------------------------------
    await test("TEST 12: resolver disabled (ENABLE_MERCHANT_URL_RESOLVER unset) — zero search calls, Google URLs unchanged", async () => {
        delete process.env.ENABLE_MERCHANT_URL_RESOLVER;
        resetSearchCallCount();
        setSearchResults([{ title: "should not be reached", link: "https://amazon.in/dp/SHOULDNOTBEUSED" }]);
        setFixture([{ title: "Samsung Galaxy S26 Ultra 5G", source: "Amazon.in", link: "https://www.google.com/search?ibp=oshop&q=t12", price: "₹1,17,600" }]);
        const result = await compareByProduct({ brand: "Samsung", model: "Galaxy S26 Ultra", productName: "Galaxy S26 Ultra", productId: "test12-unique" });
        const amazon = result.results.find((r) => r.platform === "Amazon");
        assert.strictEqual(amazon.isGoogleRedirect, true);
        assert.strictEqual(amazon.urlResolutionStatus, "not_attempted");
        assert.strictEqual(searchCallCount, 0, "resolver must make ZERO network calls when disabled");
        assert.strictEqual(result.bestOffer.platform, "Amazon", "the app must function perfectly with the resolver off");
    });

    // -----------------------------------------------------------------
    // TEST 13 — resolver timeout: comparison still succeeds
    // -----------------------------------------------------------------
    await test("TEST 13: a resolver timeout never breaks the comparison — offer keeps its Google URL, bestOffer still returned", withEnabled(async () => {
        setSearchFailure("timeout");
        setFixture([{ title: "Samsung Galaxy S26 Ultra 5G", source: "Amazon.in", link: "https://www.google.com/search?ibp=oshop&q=t13", price: "₹1,17,600" }]);
        const result = await compareByProduct({ brand: "Samsung", model: "Galaxy S26 Ultra", productName: "Galaxy S26 Ultra", productId: "test13-unique" });
        setSearchFailure(null);
        const amazon = result.results.find((r) => r.platform === "Amazon");
        assert.strictEqual(amazon.isGoogleRedirect, true, "timeout must fall back to the original URL, not crash or drop the offer");
        assert.strictEqual(amazon.urlResolutionStatus, "failed");
        assert.strictEqual(result.bestOffer.platform, "Amazon");
    }));

    // -----------------------------------------------------------------
    // TEST 14 — resolver HTTP 403/429/500: comparison still succeeds
    // -----------------------------------------------------------------
    await test("TEST 14: a resolver HTTP error (403/429/500-shaped) never breaks the comparison", withEnabled(async () => {
        setSearchFailure("error");
        setFixture([{ title: "Samsung Galaxy S26 Ultra 5G", source: "Amazon.in", link: "https://www.google.com/search?ibp=oshop&q=t14", price: "₹1,17,600" }]);
        const result = await compareByProduct({ brand: "Samsung", model: "Galaxy S26 Ultra", productName: "Galaxy S26 Ultra", productId: "test14-unique" });
        setSearchFailure(null);
        const amazon = result.results.find((r) => r.platform === "Amazon");
        assert.strictEqual(amazon.isGoogleRedirect, true);
        assert.strictEqual(result.bestOffer.platform, "Amazon", "comparison must still succeed and return a valid bestOffer");
    }));

    // -----------------------------------------------------------------
    // TEST 15 — multiple offers: only a bounded number of resolver requests
    // -----------------------------------------------------------------
    await test("TEST 15: with more eligible offers than MERCHANT_URL_RESOLVER_MAX_OFFERS, only the bounded number trigger a search call", withEnabled(async () => {
        process.env.MERCHANT_URL_RESOLVER_MAX_OFFERS = "2";
        resetSearchCallCount();
        setSearchResults([]); // irrelevant to this test — only call COUNT matters
        setFixture([
            { title: "Samsung Galaxy S26 Ultra", source: "StoreA", link: "https://www.google.com/search?ibp=oshop&q=t15a", price: "₹90,000" },
            { title: "Samsung Galaxy S26 Ultra", source: "StoreB", link: "https://www.google.com/search?ibp=oshop&q=t15b", price: "₹91,000" },
            { title: "Samsung Galaxy S26 Ultra", source: "StoreC", link: "https://www.google.com/search?ibp=oshop&q=t15c", price: "₹92,000" },
            { title: "Samsung Galaxy S26 Ultra", source: "StoreD", link: "https://www.google.com/search?ibp=oshop&q=t15d", price: "₹93,000" },
        ]);
        await compareByProduct({ brand: "Samsung", model: "Galaxy S26 Ultra", productName: "Galaxy S26 Ultra" });
        console.log(`      search calls made: ${searchCallCount} (max configured: 2, 4 eligible offers existed)`);
        assert.strictEqual(searchCallCount, 2, "must never exceed MERCHANT_URL_RESOLVER_MAX_OFFERS resolver requests in one comparison");
        delete process.env.MERCHANT_URL_RESOLVER_MAX_OFFERS;
    }));

    // -----------------------------------------------------------------
    // TEST 16 — duplicate Google Shopping URLs: resolve only once (cache)
    // -----------------------------------------------------------------
    await test("TEST 16: identical (merchant, query) resolution requests are cached — resolved only once", withEnabled(async () => {
        setSearchResults([{ title: "Samsung Galaxy S26 Ultra 5G - Amazon.in", link: "https://amazon.in/dp/CACHED123", snippet: "Samsung Galaxy S26 Ultra" }]);
        resetSearchCallCount();
        const query = "Samsung Galaxy S26 Ultra 256GB__t16_unique";
        const first = await resolveDirectMerchantUrlDetailed("Amazon", query, { matchValidator: () => true });
        const second = await resolveDirectMerchantUrlDetailed("Amazon", query, { matchValidator: () => true });
        assert.deepStrictEqual(first, second);
        assert.strictEqual(searchCallCount, 1, "the second identical request must be served from cache, not a new network call");
    }));

    // -----------------------------------------------------------------
    // TEST 19 — bestOffer remains unchanged by URL resolution
    // -----------------------------------------------------------------
    await test("TEST 19: bestOffer selection (cheapest trusted eligible offer) is identical whether the resolver is on or off", async () => {
        const fixture = [
            { title: "Samsung Galaxy S26 Ultra", source: "MRV electronics", link: "https://www.google.com/search?ibp=oshop&q=t19a", price: "₹94,999" },
            { title: "Samsung Galaxy S26 Ultra", source: "Amazon.in", link: "https://www.google.com/search?ibp=oshop&q=t19b", price: "₹1,17,600" },
        ];
        delete process.env.ENABLE_MERCHANT_URL_RESOLVER;
        setFixture(fixture);
        const withoutResolver = await compareByProduct({ brand: "Samsung", model: "Galaxy S26 Ultra", productName: "Galaxy S26 Ultra", productId: "test19-unique" });

        process.env.ENABLE_MERCHANT_URL_RESOLVER = "true";
        setSearchResults([]); // resolution fails either way — irrelevant to this test
        setFixture(fixture);
        const withResolver = await compareByProduct({ brand: "Samsung", model: "Galaxy S26 Ultra", productName: "Galaxy S26 Ultra", productId: "test19-unique" });
        delete process.env.ENABLE_MERCHANT_URL_RESOLVER;

        assert.strictEqual(withoutResolver.bestOffer.platform, "MRV electronics");
        assert.strictEqual(withResolver.bestOffer.platform, "MRV electronics");
        assert.strictEqual(withoutResolver.bestOffer.price, withResolver.bestOffer.price);
    });

    // -----------------------------------------------------------------
    // TEST 20 — bestDirectOffer becomes available when resolution succeeds
    // -----------------------------------------------------------------
    await test("TEST 20: bestDirectOffer becomes populated once a valid direct URL is successfully resolved for the cheapest eligible offer", withEnabled(async () => {
        setSearchResults([{ title: "Samsung Galaxy S26 Ultra - MRV Electronics", link: "https://mrvelectronics.in/products/s26-ultra", snippet: "Samsung Galaxy S26 Ultra" }]);
        setFixture([
            { title: "Samsung Galaxy S26 Ultra", source: "MRV electronics", link: "https://www.google.com/search?ibp=oshop&q=t20", price: "₹94,999" },
        ]);
        const result = await compareByProduct({ brand: "Samsung", model: "Galaxy S26 Ultra", productName: "Galaxy S26 Ultra", productId: "test20-unique" });
        assert.ok(result.bestDirectOffer, "bestDirectOffer must be populated once resolution succeeds");
        assert.strictEqual(result.bestDirectOffer.platform, "MRV electronics");
        assert.strictEqual(result.bestDirectOffer.url, "https://mrvelectronics.in/products/s26-ultra");
    }));

    // -----------------------------------------------------------------
    // Real live-relevant scenario: MRV electronics is NOT in the small
    // static domain allowlist — proves the new MEDIUM-confidence dynamic
    // discovery path (not just the old allowlist-only HIGH path) actually
    // works, which is what makes the real reported bestOffer resolvable
    // at all under this design.
    // -----------------------------------------------------------------
    console.log("\n=== Non-allowlisted merchant (the real live bestOffer, MRV electronics) ===");
    await test("Non-allowlisted merchant: MRV electronics resolves via the dynamic MEDIUM-confidence path, domain independently verified", withEnabled(async () => {
        setSearchResults([{ title: "Samsung Galaxy S26 Ultra 256GB - MRV Electronics", link: "https://mrvelectronics.in/products/samsung-galaxy-s26-ultra", snippet: "Samsung Galaxy S26 Ultra 256GB Titanium" }]);
        setFixture([{ title: "Samsung Galaxy S26 Ultra", source: "MRV electronics", link: "https://www.google.com/search?ibp=oshop&q=mrv1", price: "₹94,999" }]);
        const result = await compareByProduct({ brand: "Samsung", model: "Galaxy S26 Ultra", productName: "Galaxy S26 Ultra", storage: "256GB" });
        const mrv = result.results.find((r) => r.platform === "MRV electronics");
        assert.strictEqual(mrv.isDirectMerchantUrl, true);
        assert.strictEqual(mrv.urlConfidence, 70, "non-allowlisted, dynamically-discovered merchant domain is MEDIUM confidence, not HIGH");
        assert.strictEqual(mrv.merchantUrlSource, "merchant_url_resolver");
        assert.strictEqual(result.bestDirectOffer.platform, "MRV electronics");
    }));
    await test("Non-allowlisted merchant: an unrelated domain is rejected even though the search 'succeeded'", withEnabled(async () => {
        // Serper's own search returning SOMETHING is not enough — the
        // resulting domain must still plausibly belong to the merchant.
        setSearchResults([{ title: "Samsung Galaxy S26 Ultra - Best Deals", link: "https://totallyunrelatedblog.example/reviews/s26-ultra", snippet: "Samsung Galaxy S26 Ultra 256GB" }]);
        const resolved = await resolveDirectMerchantUrlDetailed("MRV electronics", "Samsung Galaxy S26 Ultra 256GB__mrv2", { matchValidator: () => true });
        assert.strictEqual(resolved, null, "an unrelated blog/review domain must never be accepted as MRV electronics' own page");
    }));

    // -----------------------------------------------------------------
    // SSRF / safety checks (Phase 11)
    // -----------------------------------------------------------------
    console.log("\n=== SSRF / URL safety checks (Phase 11) ===");
    await test("safety: localhost/private-IP/metadata-endpoint URLs are never treated as safe external URLs", () => {
        assert.strictEqual(isPrivateOrLocalHost("http://localhost/x"), true);
        assert.strictEqual(isPrivateOrLocalHost("http://127.0.0.1/x"), true);
        assert.strictEqual(isPrivateOrLocalHost("http://169.254.169.254/latest/meta-data"), true);
        assert.strictEqual(isPrivateOrLocalHost("http://10.0.0.5/x"), true);
        assert.strictEqual(isPrivateOrLocalHost("http://192.168.1.1/x"), true);
        assert.strictEqual(isPrivateOrLocalHost("https://mrvelectronics.in/x"), false);
        assert.strictEqual(isSafeExternalUrl("http://169.254.169.254/latest/meta-data"), false);
        assert.strictEqual(isSafeExternalUrl("javascript:alert(1)"), false);
        assert.strictEqual(isSafeExternalUrl("https://mrvelectronics.in/products/x"), true);
    });
    await test("safety: a resolved candidate pointing at an internal/private address is rejected even if the merchant name would otherwise match", withEnabled(async () => {
        setSearchResults([{ title: "Samsung Galaxy S26 Ultra", link: "http://169.254.169.254/latest/meta-data/mrvelectronics" }]);
        const resolved = await resolveDirectMerchantUrlDetailed("MRV electronics", "Samsung Galaxy S26 Ultra__ssrf1", { matchValidator: () => true });
        assert.strictEqual(resolved, null, "an internal/metadata-endpoint-shaped URL must never be accepted, regardless of merchant name plausibility");
    }));

    console.log("\n=== SUMMARY ===");
    const passed = results.filter((r) => r.pass).length;
    console.log(`${passed}/${results.length} passed`);
    if (passed !== results.length) process.exitCode = 1;
}

main();
