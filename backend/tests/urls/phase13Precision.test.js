/**
 * Phase 13 tests — "Direct Store URL Precision Hardening"
 * ------------------------------------------------------------------
 * Phase 12's manual verification of the Phase-11-resolved URL set found
 * two NEW failure classes that Phase 11's fixes didn't cover:
 *
 *   Fix A: merchantNameMatchesHostname() matched on individual tokens
 *   found anywhere inside the hostname label, which let "Shopy Vision"
 *   (tokens "shopy"/"vision") pass against the unrelated real domain
 *   "datavision.com" purely because "vision" is a substring of
 *   "datavision". Fixed by matching on the full, contiguous merchant
 *   name against the hostname label instead of loose tokens.
 *
 *   Fix B: looksLikeGenericOrSearchPage() didn't catch two real
 *   page-purpose mismatches: a dated CMS/blog post URL
 *   (cutetechgadgets.com/2024/03/10/...) and a trade-in/"sell to us"
 *   page (cashify.in/sell-old-laptop/...).
 *
 * This suite does not touch or re-test Phase 11's original protections
 * (see pageTypePrecision.test.js) — only the new Phase 13 additions,
 * plus false-positive guards proving legitimate URLs aren't newly
 * rejected by either fix.
 *
 * USAGE: node tests/urls/phase13Precision.test.js
 */

const assert = require("assert");
const path = require("path");
const Module = require("module");

let currentSearchResults = [];
function setSearchResults(items) { currentSearchResults = items; }

const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
    if (id === "axios") {
        return {
            post: async (url) => {
                if (typeof url === "string" && url.includes("/search") && !url.includes("/shopping")) {
                    return { data: { organic: currentSearchResults } };
                }
                return { data: { shopping: [] } };
            },
            get: async () => ({ data: "" }),
        };
    }
    return originalRequire.apply(this, arguments);
};

process.env.SERPER_API_KEY = process.env.SERPER_API_KEY || "fake_key_for_regression_test";
delete process.env.COMPARISON_ENGINE_V2;

const { resolveDirectMerchantUrlDetailed, looksLikeGenericOrSearchPage, merchantNameMatchesHostname } = require(
    path.join(__dirname, "..", "..", "comparison", "urlResolver")
);

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
    // Fix A — merchant hostname matching
    // -----------------------------------------------------------------
    console.log("=== Fix A: merchant hostname matching ===");
    await test("A1: 'Shopy Vision' does NOT match datavision.com (the Phase 12 finding)", () => {
        assert.strictEqual(merchantNameMatchesHostname("Shopy Vision", "https://datavision.com/products/apple-airpods-pro-3"), false);
    });
    await test("A2: a legitimate registered merchant/domain relationship still works ('MRV electronics' -> mrvelectronics.in)", () => {
        assert.strictEqual(merchantNameMatchesHostname("MRV electronics", "https://mrvelectronics.in/product/s26-ultra"), true);
    });
    await test("A3: a legitimate unregistered merchant/domain relationship still works ('Harsha' -> harshaindia.com)", () => {
        assert.strictEqual(merchantNameMatchesHostname("Harsha", "https://harshaindia.com/index.php?route=product/product&product_id=35522"), true);
    });
    await test("A4: pluralization/minor suffix difference still matches ('Shivam Enterprises' -> shivamenterprise.ind.in)", () => {
        assert.strictEqual(merchantNameMatchesHostname("Shivam Enterprises", "https://shivamenterprise.ind.in/product/samsung-galaxy-tab-s9-fe/"), true);
    });
    await test("A5: a partial single-token substring match does NOT incorrectly pass ('Gadgets Now' vs cutetechgadgets.com)", () => {
        // Same underlying bug class as A1, found independently in Phase 12's
        // MacBook Air M3 case — confirms the fix generalizes, not just to
        // the one named example.
        assert.strictEqual(merchantNameMatchesHostname("Gadgets Now", "https://cutetechgadgets.com/2024/03/10/on-the-spotlight-unveiling-the-macbook-air-m3/"), false);
    });
    await test("A6: false-positive guard — a normal, unrelated multi-token merchant name still correctly matches its own domain ('EW Shopping' -> ewshopping.com)", () => {
        assert.strictEqual(merchantNameMatchesHostname("EW Shopping", "https://ewshopping.com/product/apple-iphone-17-black-256-gb"), true);
    });
    await test("A7: short exact brand name still matches its own exact domain ('JBL' -> jbl.com)", () => {
        assert.strictEqual(merchantNameMatchesHostname("JBL", "https://jbl.com/product/flip6"), true);
    });
    await test("A8: short brand name does NOT loosely match a similar-but-different short domain ('JBL' vs jblaudio.com)", () => {
        assert.strictEqual(merchantNameMatchesHostname("JBL", "https://jblaudio.com/product/x"), false);
    });
    await test("A9: end-to-end — the datavision.com false positive never becomes a resolved URL", withEnabled(async () => {
        setSearchResults([{ title: "Apple AirPods Pro 3 - DataVision", link: "https://datavision.com/products/apple-airpods-pro-3-mfhp4ll-a", snippet: "Apple AirPods Pro 3" }]);
        const resolved = await resolveDirectMerchantUrlDetailed("Shopy Vision", "Apple AirPods Pro__phase13a9", { matchValidator: () => true });
        assert.strictEqual(resolved, null, "an unrelated real merchant's page must never be accepted just because one token loosely overlaps");
    }));
    await test("A10: existing HIGH-confidence (registered-domain) behavior is unchanged by this fix", withEnabled(async () => {
        setSearchResults([{ title: "OnePlus 13 - Amazon.in", link: "https://www.amazon.in/OnePlus-13/dp/B0DPS7FB4J", snippet: "OnePlus 13 256GB" }]);
        const resolved = await resolveDirectMerchantUrlDetailed("Amazon", "OnePlus 13__phase13a10", { matchValidator: () => true });
        assert.ok(resolved, "registered-merchant HIGH-confidence resolution must still work — Fix A only touches the MEDIUM-confidence path");
    }));

    // -----------------------------------------------------------------
    // Fix B1 — dated CMS/editorial URLs
    // -----------------------------------------------------------------
    console.log("\n=== Fix B1: dated CMS URLs rejected ===");
    await test("B1: cutetechgadgets.com/2024/03/10/... (the actual Phase 12 finding) is rejected", () => {
        assert.strictEqual(looksLikeGenericOrSearchPage("https://cutetechgadgets.com/2024/03/10/on-the-spotlight-unveiling-the-macbook-air-m3/"), true);
    });
    await test("B2: a different dated CMS URL (/2025/11/02/news-story/) is rejected", () => {
        assert.strictEqual(looksLikeGenericOrSearchPage("https://example.com/2025/11/02/news-story/"), true);
    });
    await test("B3: false-positive guard — /product/.../<numeric id> is NOT rejected", () => {
        assert.strictEqual(looksLikeGenericOrSearchPage("https://example.com/product/dell-xps-13-9310/12345"), false);
    });
    await test("B4: false-positive guard — a normal /dp/B0... product page is NOT rejected", () => {
        assert.strictEqual(looksLikeGenericOrSearchPage("https://www.amazon.in/Some-Product/dp/B0FQFJBBVY"), false);
    });
    await test("B5: false-positive guard — a numeric product ID that happens to look like a year, with nothing after it, is NOT rejected", () => {
        assert.strictEqual(looksLikeGenericOrSearchPage("https://example.com/product/1234/2024"), false);
    });

    // -----------------------------------------------------------------
    // Fix B2 — sell / trade-in / buyback pages
    // -----------------------------------------------------------------
    console.log("\n=== Fix B2: sell/trade-in/buyback pages rejected ===");
    await test("B6: cashify.in/sell-old-laptop/... (the actual Phase 12 finding) is rejected", () => {
        assert.strictEqual(looksLikeGenericOrSearchPage("https://www.cashify.in/sell-old-laptop/used-dell-xps-13"), true);
    });
    await test("B7: a bare /sell/ segment is rejected", () => {
        assert.strictEqual(looksLikeGenericOrSearchPage("https://example.com/sell/electronics"), true);
    });
    await test("B8: /trade-in/ is rejected", () => {
        assert.strictEqual(looksLikeGenericOrSearchPage("https://example.com/trade-in/laptop"), true);
    });
    await test("B9: /tradein/ (no hyphen) is rejected", () => {
        assert.strictEqual(looksLikeGenericOrSearchPage("https://example.com/tradein/offer"), true);
    });
    await test("B10: /buyback/ is rejected", () => {
        assert.strictEqual(looksLikeGenericOrSearchPage("https://example.com/buyback/dell-xps-13"), true);
    });
    await test("B11: false-positive guard — a legitimate product slug containing 'sell' as part of a longer word (not a transaction path) is NOT rejected", () => {
        assert.strictEqual(looksLikeGenericOrSearchPage("https://example.com/products/best-seller-headphones"), false);
    });
    await test("B12: end-to-end — the Cashify sell page never becomes a resolved URL", withEnabled(async () => {
        setSearchResults([{ title: "Sell your old Dell XPS 13 - Cashify", link: "https://www.cashify.in/sell-old-laptop/used-dell-xps-13", snippet: "Dell XPS 13 9305 Laptop trade-in value" }]);
        const resolved = await resolveDirectMerchantUrlDetailed("Cashify", "Dell XPS 13__phase13b12", { matchValidator: () => true });
        assert.strictEqual(resolved, null, "a trade-in/sell-to-merchant page must never be accepted as a direct purchase URL");
    }));

    console.log("\n=== SUMMARY ===");
    const passed = results.filter((r) => r.pass).length;
    console.log(`${passed}/${results.length} passed`);
    if (passed !== results.length) process.exitCode = 1;
}

main();