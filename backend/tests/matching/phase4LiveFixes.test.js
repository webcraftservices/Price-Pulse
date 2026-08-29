/**
 * Phase 4 Live-Data Fixes — regression suite
 * ------------------------------------------------------------------
 * Covers the three issues raised from a real live-data review
 * (iPhone 17 Pro 256GB / Samsung Galaxy S26 Ultra 12GB 256GB queries):
 *
 *  1. The live TEST RUNNER's own bestOffer assertion was stale — it
 *     didn't know about usableForBestOffer, so a correctly-excluded
 *     refurbished offer made the check falsely report FAIL. Fixed in
 *     scripts/run-live-tests.js (not unit-testable in isolation since
 *     it's a script, not a module — the engine-level behavior it now
 *     correctly checks is covered by the "refurbished offer" test below,
 *     which reproduces the exact reported iPhone scenario).
 *  2. The Samsung "savings" value (50643.81) was NOT a bug — audited and
 *     confirmed to be exactly max(eligible prices) - min(eligible prices),
 *     the documented definition (offerRanker.js). Floating-point display
 *     artifacts (47562.79999999999) ARE fixed here, via roundCurrency.
 *  3. matchDecision "EXACT_MATCH" is now never shown for an offer whose
 *     title never confirmed a requested storage figure — downgraded to
 *     "STRONG_MATCH" (label only; confidence/hardReject/eligibility
 *     unchanged).
 *
 * USAGE: node tests/matching/phase4LiveFixes.test.js
 */

const assert = require("assert");
const path = require("path");
const Module = require("module");

let currentShopping = [];
function setFixture(items) { currentShopping = items; }

const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
    if (id === "axios") {
        return {
            post: async (url) => {
                if (typeof url === "string" && url.includes("/shopping")) return { data: { shopping: currentShopping } };
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
delete process.env.COMPARISON_ENGINE_V2;
delete process.env.ENABLE_MERCHANT_URL_RESOLVER;

const { compareByProduct } = require(path.join(__dirname, "..", "..", "services", "compareService"));
const { computeMatchConfidence } = require(path.join(__dirname, "..", "..", "services", "productMatcher"));
const { isEligibleForComparison } = require(path.join(__dirname, "..", "..", "comparison", "offerEligibility"));
const { roundCurrency } = require(path.join(__dirname, "..", "..", "utils", "numbers"));

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

async function main() {
    // -----------------------------------------------------------------
    // Issue #1 — reproduces the exact reported iPhone scenario
    // -----------------------------------------------------------------
    console.log("=== Issue #1: refurbished offer correctly excluded from bestOffer (iPhone repro) ===");
    await test("iPhone repro: refurbished icluster (₹113,900, cheaper) must NOT win bestOffer over trusted MRV electronics (₹117,999)", async () => {
        setFixture([
            { title: "Refurbished Apple iPhone 17 Pro (eSIM) Deep blue / 256GB / Excellent", source: "icluster technologies", link: "https://icluster.example/p/1", price: "₹1,13,900" },
            { title: "Apple iPhone 17 Pro ( 256GB ) Cosmic Orange", source: "MRV electronics", link: "https://mrv.example/p/2", price: "₹1,17,999" },
        ]);
        const result = await compareByProduct({ brand: "Apple", model: "iPhone 17 Pro", productName: "iPhone 17 Pro", storage: "256GB" });

        const icluster = result.results.find((r) => r.platform === "icluster technologies");
        const mrv = result.results.find((r) => r.platform === "MRV electronics");
        console.log(`      icluster: offerQuality=${icluster.offerQuality} usableForBestOffer=${icluster.usableForBestOffer}`);
        console.log(`      bestOffer: ${result.bestOffer.platform} ₹${result.bestOffer.price}`);

        assert.strictEqual(icluster.offerQuality, "suspicious");
        assert.ok(icluster.offerQualityReasons.includes("used_or_refurbished"));
        assert.strictEqual(icluster.usableForBestOffer, false);
        assert.strictEqual(mrv.usableForBestOffer, true);
        assert.strictEqual(result.bestOffer.platform, "MRV electronics", "the cheaper refurbished offer must never win bestOffer");
        assert.strictEqual(result.bestOffer.price, 117999);

        // The exact function scripts/run-live-tests.js now uses to compute
        // its "eligible" set — confirms the fixed live-test assertion would
        // correctly report OK for this exact reported scenario.
        const eligible = result.results.filter((r) =>
            isEligibleForComparison({ hardReject: false, matchConfidence: r.matchConfidence, price: r.price, availability: r.availability, productUrl: r.url, usableForBestOffer: r.usableForBestOffer })
        );
        assert.ok(!eligible.some((r) => r.platform === "icluster technologies"), "the OLD live-test check incorrectly counted this offer as eligible");
        assert.strictEqual(Math.min(...eligible.map((r) => r.price)), 117999, "the corrected live-test check's own eligible-minimum must match bestOffer");
    });

    // -----------------------------------------------------------------
    // Issue #2 — savings definition audit + float-safety
    // -----------------------------------------------------------------
    console.log("\n=== Issue #2: savings = max(eligible) - min(eligible), confirmed correct; float artifacts removed ===");
    await test("Samsung repro: savings reflects the full eligible price spread (max - min), not bestOffer vs. one arbitrary offer", async () => {
        setFixture([
            { title: "Samsung Galaxy S26 Ultra 5G 12GB RAM", source: "Mygsm.me", link: "https://mygsm.example/p/1", price: "89355.19" },
            { title: "Samsung Galaxy S26 Ultra 5G", source: "Amazon.in", link: "https://amazon.example/p/2", price: "₹1,24,999" },
            { title: "Samsung Galaxy S26 Ultra", source: "MRV electronics", link: "https://mrv.example/p/3", price: "₹94,999" },
            { title: "Samsung Galaxy S26 Ultra 5G", source: "BytePe", link: "https://bytepe.example/p/4", price: "₹1,21,999" },
            { title: "Samsung Galaxy S26 Ultra 5G", source: "Harsha", link: "https://harsha.example/p/5", price: "₹1,24,999" },
            { title: "Samsung Galaxy S26 Ultra 5G", source: "Manik Mobile Shopee", link: "https://manik.example/p/6", price: "₹1,39,999" },
        ]);
        const result = await compareByProduct({ brand: "Samsung", model: "Galaxy S26 Ultra", productName: "Galaxy S26 Ultra", storage: "256GB" });
        console.log(`      bestOffer: ${result.bestOffer.platform} ₹${result.bestOffer.price}, savings: ${result.savings}`);
        assert.strictEqual(result.bestOffer.platform, "Mygsm.me");
        assert.strictEqual(result.bestOffer.price, 89355.19);
        // NOT 124999-89355.19=35643.81 (the ticket's assumed "benchmark"),
        // but 139999-89355.19=50643.81 (Manik Mobile Shopee is the true max
        // of the eligible set) — confirms the definition, not a bug.
        assert.strictEqual(result.savings, 50643.81);
    });

    await test("float-safety: a savings figure that would raw-subtract to 47562.79999999999 is exposed as a clean 47562.8", async () => {
        setFixture([
            { title: "Apple iPhone 17 Pro 256GB", source: "StoreA", link: "https://a.example/p", price: "165561.80" },
            { title: "Apple iPhone 17 Pro 256GB", source: "StoreB", link: "https://b.example/p", price: "117999" },
        ]);
        const result = await compareByProduct({ brand: "Apple", model: "iPhone 17 Pro", productName: "iPhone 17 Pro", storage: "256GB" });
        console.log(`      raw JS 165561.80 - 117999 = ${165561.8 - 117999} (float artifact) ; engine savings = ${result.savings}`);
        assert.strictEqual(result.savings, 47562.8, "must be the clean rounded value, not 47562.79999999999");
        assert.strictEqual(roundCurrency(165561.8 - 117999), 47562.8, "roundCurrency itself must clean the classic float-subtraction artifact");
    });

    await test("roundCurrency: leaves null/non-numeric untouched, rounds ordinary values to 2dp", () => {
        assert.strictEqual(roundCurrency(null), null);
        assert.strictEqual(roundCurrency(undefined), undefined);
        assert.strictEqual(roundCurrency(100), 100);
        assert.strictEqual(roundCurrency(100.005), 100.01);
        assert.strictEqual(roundCurrency(89355.19), 89355.19);
    });

    // -----------------------------------------------------------------
    // Issue #3 — storage_unconfirmed must not display as EXACT_MATCH
    // -----------------------------------------------------------------
    console.log("\n=== Issue #3: storage_unconfirmed is no longer labeled EXACT_MATCH (label-only; confidence/eligibility unchanged) ===");
    const S26_ULTRA_256 = { brand: "Samsung", model: "Galaxy S26 Ultra", productName: "Galaxy S26 Ultra", storage: "256GB" };

    await test("Samsung repro: 'Samsung Galaxy S26 Ultra 5G' (storage never mentioned) is STRONG_MATCH, not EXACT_MATCH", () => {
        const r = computeMatchConfidence(S26_ULTRA_256, "Samsung Galaxy S26 Ultra 5G");
        console.log(`      confidence=${r.confidence} matchDecision=${r.matchDecision} primaryIssue=${r.primaryIssue}`);
        assert.strictEqual(r.primaryIssue, "storage_unconfirmed");
        assert.strictEqual(r.matchDecision, "STRONG_MATCH", "must no longer overclaim EXACT_MATCH for an unconfirmed requested attribute");
        assert.strictEqual(r.hardReject, false, "must remain a fully valid, non-rejected match");
    });

    await test("eligibility control: the label change does NOT affect bestOffer eligibility — confidence/hardReject are untouched", () => {
        const r = computeMatchConfidence(S26_ULTRA_256, "Samsung Galaxy S26 Ultra 5G");
        const eligible = isEligibleForComparison({ hardReject: r.hardReject, matchConfidence: r.confidence, price: 124999, availability: "in_stock", productUrl: "https://x.example", usableForBestOffer: true });
        assert.strictEqual(eligible, true, "a storage-unconfirmed-but-strong offer must remain fully eligible for bestOffer — only its LABEL changed");
    });

    await test("control: storage genuinely CONFIRMED (MRV electronics Cosmic Orange, iPhone repro) still correctly reaches EXACT_MATCH", () => {
        const r = computeMatchConfidence(
            { brand: "Apple", model: "iPhone 17 Pro", productName: "iPhone 17 Pro", storage: "256GB" },
            "Apple iPhone 17 Pro ( 256GB ) Cosmic Orange"
        );
        assert.strictEqual(r.primaryIssue, null, "storage was genuinely confirmed here — no unconfirmed/mismatch issue at all");
        assert.strictEqual(r.matchDecision, "EXACT_MATCH", "a genuinely confirmed exact variant must still reach EXACT_MATCH — this fix must not create false negatives");
    });

    await test("control: an actual storage MISMATCH is unaffected by this fix (already correctly demoted before it)", () => {
        const r = computeMatchConfidence(S26_ULTRA_256, "Samsung Galaxy S26 Ultra 512GB");
        assert.strictEqual(r.primaryIssue, "storage_mismatch");
        assert.notStrictEqual(r.matchDecision, "EXACT_MATCH");
        assert.strictEqual(r.hardReject, false, "storage mismatch must remain a soft demotion, never a hard rejection");
    });

    console.log("\n=== SUMMARY ===");
    const passed = results.filter((r) => r.pass).length;
    console.log(`${passed}/${results.length} passed`);
    if (passed !== results.length) process.exitCode = 1;
}

main();
