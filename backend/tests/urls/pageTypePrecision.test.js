/**
 * Page-Type Precision tests — Phase 11 ("Direct Store URL Precision Fix")
 * ------------------------------------------------------------------
 * A live 20-product / 274-offer test against the real Serper API (Phase
 * 10) found that ~6 of 29 "resolved" direct URLs were not actually
 * product pages at all: editorial/blog pages, a "resource center" guide
 * page, and a brand storefront page, all on the correct merchant domain
 * and textually relevant enough to pass looksLikeGenericOrSearchPage and
 * matchValidator as they existed at the time. Separately, a resolved
 * Amazon URL turned out to be amazon.com (US) rather than amazon.in
 * (India) for an India-targeted comparison.
 *
 * This suite tests the additive fixes in comparison/urlResolver.js:
 *   (A) editorial/content page rejection (looksLikeGenericOrSearchPage)
 *   (B) brand storefront rejection (looksLikeGenericOrSearchPage)
 *   (C) registered-domain consistency on the MEDIUM-confidence path
 * plus a full existing-behavior regression (genuine product URLs must
 * still pass) and a documented, NOT-yet-fixed wrong-variant finding (H)
 * — see the comment on that test for why it isn't fixed in this phase.
 *
 * USAGE: node tests/urls/pageTypePrecision.test.js
 */

const assert = require("assert");
const path = require("path");
const Module = require("module");

let currentShopping = [];
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

const { resolveDirectMerchantUrlDetailed, looksLikeGenericOrSearchPage } = require(
    path.join(__dirname, "..", "..", "comparison", "urlResolver")
);
const { matchOffer } = require(path.join(__dirname, "..", "..", "comparison", "variantMatcher"));

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
    // A. Existing valid behavior must remain valid (genuine product URLs
    //    on real merchant domains must still pass looksLikeGenericOrSearchPage)
    // -----------------------------------------------------------------
    console.log("=== A. Genuine product pages still pass ===");
    await test("A1: amazon.in /dp/ product page is accepted", () => {
        assert.strictEqual(looksLikeGenericOrSearchPage("https://www.amazon.in/OnePlus-13-256GB-Midnight-Ocean/dp/B0DPS7FB4J"), false);
    });
    await test("A2: flipkart.com /p/ product page is accepted", () => {
        assert.strictEqual(looksLikeGenericOrSearchPage("https://www.flipkart.com/apple-iphone-17-white-256-gb/p/itmf98e89534d806"), false);
    });
    await test("A3: reliancedigital.in /product/ page is accepted", () => {
        assert.strictEqual(looksLikeGenericOrSearchPage("https://www.reliancedigital.in/product/apple-iphone-17-256-gb-black-mff8ru-9391619"), false);
    });
    await test("A4: croma.com /p/<id> product page is accepted", () => {
        assert.strictEqual(looksLikeGenericOrSearchPage("https://www.croma.com/lenovo-ideapad-slim-3-15irh10/p/323287"), false);
    });
    await test("A5: end-to-end — a genuine product page still resolves successfully", withEnabled(async () => {
        setSearchResults([{ title: "OnePlus 13 256GB - Amazon.in", link: "https://www.amazon.in/OnePlus-13-256GB/dp/B0DPS7FB4J", snippet: "OnePlus 13 256GB Midnight Ocean" }]);
        const resolved = await resolveDirectMerchantUrlDetailed("Amazon", "OnePlus 13 256GB__pageprecisiona5", { matchValidator: () => true });
        assert.ok(resolved, "a genuine dp/ product page must still resolve");
        assert.strictEqual(resolved.url, "https://www.amazon.in/OnePlus-13-256GB/dp/B0DPS7FB4J");
    }));

    // -----------------------------------------------------------------
    // B. Editorial pages rejected
    // -----------------------------------------------------------------
    console.log("\n=== B. Editorial pages rejected ===");
    await test("B1: croma.com/unboxed/... editorial article is rejected", () => {
        assert.strictEqual(
            looksLikeGenericOrSearchPage("https://www.croma.com/unboxed/10-settings-to-tweak-on-your-new-samsung-galaxy-s26-ultra"),
            true
        );
    });
    await test("B2: end-to-end — an /unboxed/ article never becomes a resolved URL", withEnabled(async () => {
        setSearchResults([{
            title: "10 settings to tweak on your new Samsung Galaxy S26 Ultra",
            link: "https://www.croma.com/unboxed/10-settings-to-tweak-on-your-new-samsung-galaxy-s26-ultra",
            snippet: "Samsung Galaxy S26 Ultra tips",
        }]);
        const resolved = await resolveDirectMerchantUrlDetailed("Croma", "Samsung Galaxy S26 Ultra__pageprecisionb2", { matchValidator: () => true });
        assert.strictEqual(resolved, null, "an editorial/blog article must never be accepted as a direct product URL");
    }));

    // -----------------------------------------------------------------
    // C. Resource/guide pages rejected
    // -----------------------------------------------------------------
    console.log("\n=== C. Resource pages rejected ===");
    await test("C1: reliancedigital.in/c/resource-center/... guide page is rejected", () => {
        assert.strictEqual(
            looksLikeGenericOrSearchPage("https://www.reliancedigital.in/c/resource-center/bg/lenovo-ideapad-slim-3-redefining-the-mid-range-segment"),
            true
        );
    });

    // -----------------------------------------------------------------
    // D. Blog pages rejected
    // -----------------------------------------------------------------
    console.log("\n=== D. Blog pages rejected ===");
    await test("D1: merchant.com/blog/... is rejected", () => {
        assert.strictEqual(looksLikeGenericOrSearchPage("https://example-merchant.com/blog/best-headphones-2026"), true);
    });
    await test("D2: merchant.com/blogs/... (plural) is rejected", () => {
        assert.strictEqual(looksLikeGenericOrSearchPage("https://example-merchant.com/blogs/best-headphones-2026"), true);
    });

    // -----------------------------------------------------------------
    // E. Guides / news / articles rejected
    // -----------------------------------------------------------------
    console.log("\n=== E. Guides/news/articles rejected ===");
    await test("E1: /guide/ is rejected", () => {
        assert.strictEqual(looksLikeGenericOrSearchPage("https://example-merchant.com/guide/buying-a-laptop"), true);
    });
    await test("E2: /guides/ (plural) is rejected", () => {
        assert.strictEqual(looksLikeGenericOrSearchPage("https://example-merchant.com/guides/buying-a-laptop"), true);
    });
    await test("E3: /news/ is rejected", () => {
        assert.strictEqual(looksLikeGenericOrSearchPage("https://example-merchant.com/news/product-launch"), true);
    });
    await test("E4: /article/ is rejected", () => {
        assert.strictEqual(looksLikeGenericOrSearchPage("https://example-merchant.com/article/product-launch"), true);
    });
    await test("E5: /articles/ (plural) is rejected", () => {
        assert.strictEqual(looksLikeGenericOrSearchPage("https://example-merchant.com/articles/product-launch"), true);
    });
    await test("E6: a legitimate product slug merely containing 'news' as a substring (not a path segment) is NOT rejected", () => {
        // False-positive guard: "newsradio-headphones" is one path segment,
        // not "/news/" — must not be caught by a naive substring check.
        assert.strictEqual(looksLikeGenericOrSearchPage("https://example-merchant.com/p/newsradio-headphones-nx200"), false);
    });

    // -----------------------------------------------------------------
    // F. Brand storefront rejected
    // -----------------------------------------------------------------
    console.log("\n=== F. Brand storefront rejected ===");
    await test("F1: amazon.in/stores/DellIndia/page/... brand storefront is rejected", () => {
        assert.strictEqual(
            looksLikeGenericOrSearchPage("https://www.amazon.in/stores/DellIndia/page/BB154191-CAB2-4CFF-9BAE-80E09855E9A2"),
            true
        );
    });
    await test("F2: end-to-end — a brand storefront never becomes a resolved URL", withEnabled(async () => {
        setSearchResults([{
            title: "Dell India Store - Amazon.in",
            link: "https://www.amazon.in/stores/DellIndia/page/BB154191-CAB2-4CFF-9BAE-80E09855E9A2",
            snippet: "Dell XPS 13 and more",
        }]);
        const resolved = await resolveDirectMerchantUrlDetailed("Amazon", "Dell XPS 13__pageprecisionf2", { matchValidator: () => true });
        assert.strictEqual(resolved, null, "a whole-brand storefront page must never be accepted as a single product's direct URL");
    }));
    await test("F3: an unrelated merchant's legitimate '/stores/' path segment alone (no '/page/' after a brand) is NOT rejected", () => {
        // False-positive guard: requires the specific /stores/<brand>/page/
        // shape, not any occurrence of the word "stores".
        assert.strictEqual(looksLikeGenericOrSearchPage("https://example-merchant.com/stores-directory/product/x"), false);
    });

    // -----------------------------------------------------------------
    // G. Wrong region / TLD rejected on the MEDIUM-confidence path
    // -----------------------------------------------------------------
    console.log("\n=== G. Wrong region/TLD rejected ===");
    await test("G1: amazon.com is rejected for a merchant registered as amazon.in, even though it fuzzy-matches the merchant name", withEnabled(async () => {
        // Simulates the real Phase 10 finding: the HIGH-confidence
        // site:amazon.in search found nothing usable, so the MEDIUM path
        // ran and (before this fix) accepted a US amazon.com result
        // purely because "amazon" matches the hostname label.
        setSearchResults([{ title: "Google Pixel 10 - Amazon.com", link: "https://www.amazon.com/clp/B0FFTV1LXZ", snippet: "Google Pixel 10 256GB" }]);
        const resolved = await resolveDirectMerchantUrlDetailed("Amazon", "Google Pixel 10__pageprecisiong1", { matchValidator: () => true });
        assert.strictEqual(resolved, null, "amazon.com must never be accepted when the registry specifies amazon.in for this merchant");
    }));
    await test("G2: amazon.in IS still accepted for the same merchant (region check doesn't over-reject the correct domain)", withEnabled(async () => {
        setSearchResults([{ title: "Google Pixel 10 - Amazon.in", link: "https://www.amazon.in/Google-Pixel-10/dp/B0FFTV1LXZ", snippet: "Google Pixel 10 256GB" }]);
        const resolved = await resolveDirectMerchantUrlDetailed("Amazon", "Google Pixel 10__pageprecisiong2", { matchValidator: () => true });
        assert.ok(resolved, "amazon.in must still be accepted for a merchant registered as amazon.in");
    }));
    await test("G3: a merchant with NO registered domain is unaffected by the region check (fuzzy hostname matching still applies)", withEnabled(async () => {
        // "MRV electronics" has no registry entry / no getResolvableDomain
        // result, so the region-consistency branch must not apply to it —
        // confirms the fix is scoped to registered merchants only.
        setSearchResults([{ title: "Samsung Galaxy S26 Ultra - MRV Electronics", link: "https://mrvelectronics.in/product/s26-ultra", snippet: "Samsung Galaxy S26 Ultra 256GB" }]);
        const resolved = await resolveDirectMerchantUrlDetailed("MRV electronics", "Samsung Galaxy S26 Ultra 256GB__pageprecisiong3", { matchValidator: () => true });
        assert.ok(resolved, "a merchant with no registered domain must still resolve via the existing fuzzy hostname check, unchanged");
    }));

    // -----------------------------------------------------------------
    // H. Wrong variant — CLOSED in Phase 14 (Wrong-Variant Root Cause Fix).
    //
    // H1/H2 previously documented the exact gap this phase was chartered
    // to fix: matchOffer() (services/productMatcher.js) scored "Tab S9 FE"
    // as a POSSIBLE_MATCH (~0.65-0.72) against a "Tab S9" query rather than
    // rejecting it outright, and — because compareEngine.js's
    // matchValidator only required clearing the 0.5 "possible match" bar,
    // not the stricter 0.75 "confident" bar — that score was enough for a
    // resolved Tab S9 FE page to be accepted as the direct URL for a Tab S9
    // request.
    //
    // Root cause (per the Phase 14 read-only investigation): "fe" (Fan
    // Edition) was missing from VARIANT_SUFFIX_WORDS in utils/numbers.js —
    // every OTHER product-line suffix (Pro/Ultra/Plus/Max/...) was already
    // a Gate 1 hard-reject; "fe" simply wasn't on the list. Fix A adds it.
    // Gate 1 now hard-rejects "Tab S9 FE" against "Tab S9" outright
    // (confidence forced to 0), which closes the gap at its source rather
    // than by touching the frozen compareEngine.js threshold — H2's
    // "wrong variant still passes the 0.5 bar" finding no longer applies,
    // because confidence is now 0, not ~0.65-0.72.
    // -----------------------------------------------------------------
    console.log("\n=== H. Wrong variant — CLOSED (see comment above) ===");
    await test("H1 [Phase 14 Fix A]: matchOffer now HARD_REJECTs 'Tab S9 FE' against a 'Tab S9' query", () => {
        const source = { name: "Samsung Galaxy Tab S9", brand: "Samsung", productName: "Galaxy Tab S9" };
        const fe = matchOffer(source, "Samsung Galaxy Tab S9 FE 128GB Wifi Tablet Gray");
        const exact = matchOffer(source, "Samsung Galaxy Tab S9 128GB Wifi Tablet Gray");
        assert.ok(fe.confidence < exact.confidence, "the FE variant must still score lower than the exact match");
        assert.strictEqual(fe.matchDecision, "HARD_REJECT", "Gate 1 (Fix A: 'fe' added to VARIANT_SUFFIX_WORDS) now rejects this outright, not merely downgrades it");
        assert.strictEqual(fe.confidence, 0, "a Gate 1 hard-reject forces confidence to 0");
    });
    await test("H2 [Phase 14 Fix A — gap closed]: the FE variant no longer clears compareEngine.js's matchValidator threshold (0.5)", () => {
        const source = { name: "Samsung Galaxy Tab S9", brand: "Samsung", productName: "Galaxy Tab S9" };
        const MATCH_CONFIDENCE_THRESHOLD = 0.5; // mirrors offerEligibility.js's real constant, not modified here
        const feConfidence = matchOffer(source, "Samsung Galaxy Tab S9 FE 128GB Wifi Tablet Gray").confidence;
        assert.ok(
            feConfidence < MATCH_CONFIDENCE_THRESHOLD,
            "confidence is now forced to 0 by Gate 1, so even compareEngine.js's unmodified 0.5 matchValidator threshold correctly rejects this — no change to compareEngine.js was needed"
        );
    });

    console.log("\n=== SUMMARY ===");
    const passed = results.filter((r) => r.pass).length;
    console.log(`${passed}/${results.length} passed`);
    if (passed !== results.length) process.exitCode = 1;
}

main();