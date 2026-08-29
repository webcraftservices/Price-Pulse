/**
 * Offer / Price Quality tests — Phase 2 Precision Fix (Offer Quality Gate)
 * ------------------------------------------------------------------
 * Root cause: Gate 0 (product type) and Gate 1 (product identity) both
 * answer "is this the right PRODUCT?" — neither has any concept of "is
 * this listing's PRICE actually trustworthy?". The reported live bug:
 *
 *   desertcart — "Samsung Galaxy S26 Ultra & && ()" — ₹5,389
 *
 * passed Gate 0 (real smartphone) and Gate 1 (correct model/generation/
 * variant) with matchConfidence 1 / EXACT_MATCH, and became bestOffer —
 * inflating savings by over ₹1,00,000 — purely because nothing before
 * bestOffer selection ever asked whether the PRICE itself was credible.
 *
 * This suite tests comparison/offerQuality.js directly (unit-level,
 * matching the style of productIdentityConflict.test.js) for TEST 1–12,
 * then runs the exact reported fixture end-to-end through the real,
 * unmodified compareService.js for TEST 13 — plus a regression test for
 * the separate confident/possible-matches bookkeeping fix (spec section 15).
 *
 * USAGE: node tests/matching/offerQuality.test.js
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

const { compareByProduct } = require(path.join(__dirname, "..", "..", "services", "compareService"));
const { evaluateOfferQuality, attachOfferQuality } = require(path.join(__dirname, "..", "..", "comparison", "offerQuality"));
const { isEligibleForComparison } = require(path.join(__dirname, "..", "..", "comparison", "offerEligibility"));

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

// Helper: build a minimal "already Gate-0/1-scored" offer, the shape
// attachOfferQuality actually receives from compareEngine.js.
function offer(overrides) {
    return {
        store: "TestStore",
        title: "Samsung Galaxy S26 Ultra 256GB",
        price: 120000,
        currency: "INR",
        availability: "in_stock",
        productUrl: "https://example.com/p",
        matchConfidence: 1,
        matchDecision: "EXACT_MATCH",
        hardReject: false,
        ...overrides,
    };
}

async function main() {
    // -----------------------------------------------------------------
    // TEST 1 — normal prices, all eligible
    // -----------------------------------------------------------------
    await test("TEST 1: normal, tightly-clustered prices are all trusted/usable", () => {
        const offers = [
            offer({ store: "Amazon", price: 117600 }),
            offer({ store: "Flipkart", price: 124999 }),
            offer({ store: "MRV electronics", price: 94999 }),
            offer({ store: "JioMart", price: 124999 }),
        ];
        const scored = attachOfferQuality(offers);
        scored.forEach((o) => {
            assert.strictEqual(o.offerQuality.status, "trusted", `${o.store} expected trusted, got ${o.offerQuality.status} (${o.offerQuality.reasons})`);
            assert.strictEqual(o.usableForBestOffer, true, `${o.store} expected usable`);
        });
    });

    // -----------------------------------------------------------------
    // TEST 2 — one extreme outlier must never become bestOffer
    // -----------------------------------------------------------------
    await test("TEST 2: extreme price outlier (₹5,389 amid ₹95k-125k) is flagged and excluded from bestOffer eligibility", () => {
        const offers = [
            offer({ store: "Amazon", price: 117600 }),
            offer({ store: "Flipkart", price: 124999 }),
            offer({ store: "MRV electronics", price: 94999 }),
            offer({ store: "JioMart", price: 124999 }),
            offer({ store: "desertcart", price: 5389, matchConfidence: 1, matchDecision: "EXACT_MATCH" }),
        ];
        const scored = attachOfferQuality(offers);
        const desertcart = scored.find((o) => o.store === "desertcart");
        assert.notStrictEqual(desertcart.offerQuality.status, "trusted");
        assert.ok(desertcart.offerQuality.reasons.includes("extreme_price_outlier"), `expected extreme_price_outlier, got ${desertcart.offerQuality.reasons}`);
        assert.strictEqual(desertcart.usableForBestOffer, false);
        assert.strictEqual(isEligibleForComparison({ ...desertcart, price: desertcart.price }), false, "must fail the bestOffer eligibility gate");
        // The legitimate cheapest offer must remain eligible.
        const mrv = scored.find((o) => o.store === "MRV electronics");
        assert.strictEqual(mrv.usableForBestOffer, true);
    });

    // -----------------------------------------------------------------
    // TEST 3 — malformed title + extreme price -> suspicious (not silently trusted)
    // -----------------------------------------------------------------
    await test("TEST 3: malformed title ('Samsung Galaxy S26 Ultra & && ()') combined with extreme price is suspicious, both reasons reported", () => {
        const offers = [
            offer({ store: "Amazon", price: 117600 }),
            offer({ store: "Flipkart", price: 124999 }),
            offer({ store: "MRV electronics", price: 94999 }),
            offer({ store: "JioMart", price: 124999 }),
            offer({ store: "desertcart", title: "Samsung Galaxy S26 Ultra & && ()", price: 5389 }),
        ];
        const scored = attachOfferQuality(offers);
        const desertcart = scored.find((o) => o.store === "desertcart");
        console.log(`      desertcart offerQuality: ${JSON.stringify(desertcart.offerQuality)}`);
        assert.strictEqual(desertcart.offerQuality.status, "suspicious", "spec's own worked example expects 'suspicious', not 'invalid' (it has a real price and title)");
        assert.ok(desertcart.offerQuality.reasons.includes("malformed_title"));
        assert.ok(desertcart.offerQuality.reasons.includes("extreme_price_outlier"));
        assert.strictEqual(desertcart.usableForBestOffer, false);
        assert.ok(desertcart.offerQuality.score < 0.3, `expected a low trust score, got ${desertcart.offerQuality.score}`);
    });

    // -----------------------------------------------------------------
    // TEST 4 — legitimate large discount must NOT be auto-rejected
    // -----------------------------------------------------------------
    await test("TEST 4: a genuine ~35-42% discount is NOT flagged merely for being cheaper", () => {
        const offers = [
            offer({ store: "Amazon", price: 100000 }),
            offer({ store: "Flipkart", price: 110000 }),
            offer({ store: "Croma", price: 120000 }),
            offer({ store: "DiscountStore", price: 70000 }), // ratio ~0.636 vs median 105000
        ];
        const scored = attachOfferQuality(offers);
        const discount = scored.find((o) => o.store === "DiscountStore");
        console.log(`      DiscountStore (₹70,000, ratio ~0.64): ${JSON.stringify(discount.offerQuality)}`);
        assert.strictEqual(discount.offerQuality.status, "trusted", "a legitimate ~36% discount must not be treated as suspicious");
        assert.strictEqual(discount.usableForBestOffer, true);
    });

    // -----------------------------------------------------------------
    // TEST 5 — only one available offer: never reject for lack of a cluster
    // -----------------------------------------------------------------
    await test("TEST 5: a single available offer is never rejected merely for having no price cluster to compare against", () => {
        const offers = [offer({ store: "OnlySeller", price: 4999 })]; // would look extreme against nothing
        const scored = attachOfferQuality(offers);
        const only = scored[0];
        console.log(`      OnlySeller (no cluster): ${JSON.stringify(only.offerQuality)}`);
        assert.strictEqual(only.offerQuality.status, "trusted", "no comparable cluster at all must never itself cause rejection");
        assert.strictEqual(only.usableForBestOffer, true);
    });

    // -----------------------------------------------------------------
    // TEST 6 — two available offers: weak statistical evidence, conservative
    // -----------------------------------------------------------------
    await test("TEST 6: with only 2 offers (weak evidence), an extreme-looking ratio downgrades to low-confidence, not a hard rejection", () => {
        const offers = [
            offer({ store: "Amazon", price: 120000 }),
            offer({ store: "CheapSeller", price: 6000 }), // ratio 0.05 vs the ONE other price — too little evidence to call it extreme outright
        ];
        const scored = attachOfferQuality(offers);
        const cheap = scored.find((o) => o.store === "CheapSeller");
        console.log(`      CheapSeller (2-offer cluster): ${JSON.stringify(cheap.offerQuality)}`);
        assert.ok(!cheap.offerQuality.reasons.includes("extreme_price_outlier"), "must not fire the full extreme_price_outlier signal with only 1 other data point");
        assert.ok(cheap.offerQuality.reasons.includes("price_below_cluster_low_confidence"), "should still register a soft, low-confidence signal");
        // Still suspicious (a bare 5% ratio is a real warning sign) but the
        // REASON must reflect weak evidence, not false statistical certainty.
        assert.strictEqual(cheap.offerQuality.status, "suspicious");
    });

    // -----------------------------------------------------------------
    // TEST 7 — used/refurbished must not contaminate a new-product comparison
    // -----------------------------------------------------------------
    await test("TEST 7: a 'Refurbished' listing is flagged used_or_refurbished and excluded from bestOffer eligibility", () => {
        const offers = [
            offer({ store: "Amazon", price: 117600 }),
            offer({ store: "Flipkart", price: 124999 }),
            offer({ store: "RefurbSeller", title: "Samsung Galaxy S26 Ultra 256GB (Refurbished)", price: 75000 }),
        ];
        const scored = attachOfferQuality(offers);
        const refurb = scored.find((o) => o.store === "RefurbSeller");
        console.log(`      RefurbSeller: ${JSON.stringify(refurb.offerQuality)}`);
        assert.ok(refurb.offerQuality.reasons.includes("used_or_refurbished"));
        assert.strictEqual(refurb.usableForBestOffer, false);
    });

    // -----------------------------------------------------------------
    // TEST 8 — EMI/down-payment style price must not be the full price
    // -----------------------------------------------------------------
    await test("TEST 8: an EMI/per-month price is flagged installment_or_partial_price, not treated as the full product price", () => {
        const offers = [
            offer({ store: "Amazon", price: 117600 }),
            offer({ store: "Flipkart", price: 124999 }),
            offer({ store: "EmiSeller", title: "Samsung Galaxy S26 Ultra 256GB - EMI starting from ₹4,999/month", price: 4999 }),
        ];
        const scored = attachOfferQuality(offers);
        const emi = scored.find((o) => o.store === "EmiSeller");
        console.log(`      EmiSeller: ${JSON.stringify(emi.offerQuality)}`);
        assert.ok(emi.offerQuality.reasons.includes("installment_or_partial_price"));
        assert.strictEqual(emi.usableForBestOffer, false);
    });

    // -----------------------------------------------------------------
    // TEST 9 — accessory/part price must not become the product's bestOffer
    // -----------------------------------------------------------------
    await test("TEST 9: an accessory/part listing never reaches offerQuality at all — Gate 0 already excludes it (regression check)", async () => {
        setFixture([
            { title: "Samsung Galaxy S26 Ultra 256GB", source: "Amazon.in", link: "https://amazon.in/dp/s26u", price: "₹1,17,600" },
            { title: "Samsung Galaxy S26 Ultra Case Cover", source: "CaseStore", link: "https://case.example/p", price: "₹399" },
        ]);
        const result = await compareByProduct({ brand: "Samsung", model: "Galaxy S26 Ultra", productName: "Galaxy S26 Ultra" });
        assert.ok(!result.results.some((r) => /case cover/i.test(r.title)), "accessory must be fully excluded via Gate 0, never even reach offer quality");
        assert.strictEqual(result.bestOffer.platform, "Amazon");
        assert.strictEqual(result.bestOffer.price, 117600);
    });

    // -----------------------------------------------------------------
    // TEST 10 / 11 — Gate 1 must still hard-reject wrong generation/variant
    // -----------------------------------------------------------------
    await test("TEST 10: wrong generation is still Gate 1 HARD_REJECT — offer quality never runs on it", () => {
        const { computeMatchConfidence } = require(path.join(__dirname, "..", "..", "services", "productMatcher"));
        const r = computeMatchConfidence(
            { brand: "Samsung", model: "Galaxy S26 Ultra", productName: "Galaxy S26 Ultra" },
            "Samsung Galaxy S25 Ultra"
        );
        assert.strictEqual(r.hardReject, true);
        assert.strictEqual(r.primaryIssue, "generation_mismatch");
    });

    await test("TEST 11: wrong variant is still Gate 1 HARD_REJECT — offer quality never runs on it", () => {
        const { computeMatchConfidence } = require(path.join(__dirname, "..", "..", "services", "productMatcher"));
        const r = computeMatchConfidence(
            { brand: "Samsung", model: "Galaxy S26 Ultra", productName: "Galaxy S26 Ultra" },
            "Samsung Galaxy S26+"
        );
        assert.strictEqual(r.hardReject, true);
        assert.strictEqual(r.primaryIssue, "variant_mismatch");
    });

    await test("TEST 10b/11b: attachOfferQuality is a pure no-op pass-through for hardReject offers (never evaluated, never crashes)", () => {
        const hardRejected = { store: "OldModelStore", title: "Samsung Galaxy S25 Ultra", price: 70000, hardReject: true, matchConfidence: 0, matchDecision: "HARD_REJECT" };
        const scored = attachOfferQuality([offer({ store: "Amazon", price: 120000 }), hardRejected]);
        const passedThrough = scored.find((o) => o.store === "OldModelStore");
        assert.strictEqual(passedThrough.offerQuality, undefined, "a hard-rejected offer must not get an offerQuality object at all");
        // And it must not have contaminated the price cluster used for the
        // legitimate offer either (Amazon alone has no other data point).
        const amazon = scored.find((o) => o.store === "Amazon");
        assert.strictEqual(amazon.offerQuality.status, "trusted");
    });

    // -----------------------------------------------------------------
    // TEST 12 — storage mismatch stays soft, never Gate 1 hard rejection
    // -----------------------------------------------------------------
    await test("TEST 12: storage mismatch remains a SOFT Gate 3 demotion, not a Gate 1 hard rejection, and is unaffected by offer quality", () => {
        const { computeMatchConfidence } = require(path.join(__dirname, "..", "..", "services", "productMatcher"));
        const r = computeMatchConfidence(
            { brand: "Samsung", model: "Galaxy S26 Ultra", productName: "Galaxy S26 Ultra", storage: "256GB" },
            "Samsung Galaxy S26 Ultra 512GB"
        );
        assert.strictEqual(r.hardReject, false);
        assert.strictEqual(r.primaryIssue, "storage_mismatch");
    });

    // -----------------------------------------------------------------
    // TEST 13 — end-to-end: the exact reported live bug, through the real pipeline
    // -----------------------------------------------------------------
    console.log("\n=== TEST 13: end-to-end Samsung S26 Ultra fixture reproducing the live desertcart bug ===");
    await test("TEST 13: desertcart ₹5,389 does NOT become bestOffer; a legitimate offer does; savings excludes ₹5,389", async () => {
        setFixture([
            { title: "Samsung Galaxy S26 Ultra 256GB 12GB RAM", source: "Amazon.in", link: "https://amazon.in/dp/s26u", price: "₹1,17,600" },
            { title: "Samsung Galaxy S26 Ultra 256GB", source: "Flipkart.com", link: "https://flipkart.example/p1", price: "₹1,24,999" },
            { title: "Samsung Galaxy S26 Ultra 256GB", source: "MRV electronics", link: "https://mrv.example/p2", price: "₹94,999" },
            { title: "Samsung Galaxy S26 Ultra 256GB", source: "JioMart", link: "https://jiomart.example/p3", price: "₹1,24,999" },
            { title: "Samsung Galaxy S26 Ultra & && ()", source: "desertcart", link: "https://desertcart.example/p4", price: "₹5,389" },
        ]);
        const result = await compareByProduct({ brand: "Samsung", model: "Galaxy S26 Ultra", productName: "Galaxy S26 Ultra", storage: "256GB", ram: "12GB" });

        const desertcart = result.results.find((r) => r.platform === "desertcart");
        console.log(`      desertcart: price=${desertcart && desertcart.price} matchConfidence=${desertcart && desertcart.matchConfidence} offerQuality=${desertcart && desertcart.offerQuality} reasons=${desertcart && JSON.stringify(desertcart.offerQualityReasons)} usableForBestOffer=${desertcart && desertcart.usableForBestOffer}`);
        console.log(`      bestOffer: ${result.bestOffer.platform} ₹${result.bestOffer.price}`);
        console.log(`      savings: ${result.savings}`);

        assert.ok(desertcart, "desertcart must still be visible in results (suspicious != hard-rejected — it stays inspectable)");
        assert.strictEqual(desertcart.matchConfidence, 1, "identity match is genuinely perfect — this proves Gate 0/1 alone cannot catch this bug");
        assert.strictEqual(desertcart.offerQuality, "suspicious");
        assert.strictEqual(desertcart.usableForBestOffer, false);
        assert.ok(desertcart.offerQualityReasons.includes("extreme_price_outlier"));
        assert.ok(desertcart.offerQualityReasons.includes("malformed_title"));

        assert.notStrictEqual(result.bestOffer.platform, "desertcart", "desertcart must NEVER become bestOffer");
        assert.strictEqual(result.bestOffer.platform, "MRV electronics", "bestOffer must be the cheapest TRUSTED offer");
        assert.strictEqual(result.bestOffer.price, 94999);

        assert.ok(result.savings < 40000, `savings must reflect only the trusted cluster (94999-124999=30000), not be inflated to ~134610 by desertcart's ₹5,389; got ${result.savings}`);
        assert.strictEqual(result.savings, 30000);
    });

    // -----------------------------------------------------------------
    // Bug fix regression — keyword matching must be word-boundary safe
    // -----------------------------------------------------------------
    // Found via live-code audit (not a spec test case): the original
    // implementation matched CONDITION_SIGNAL_WORDS/INSTALLMENT_SIGNAL_WORDS
    // with a bare `.includes()`, so "emi" matched inside "Premium" and
    // "used" matched inside "Unused" — both extremely common, completely
    // legitimate listing words — wrongly excluding a real, possibly
    // cheapest offer from bestOffer eligibility. Fixed with a \b-bounded
    // regex for single words (phrases like "per month" stay substring
    // checks — safe at that length).
    await test("bug fix: 'Premium Edition' must NOT false-trigger installment_or_partial_price via 'emi' inside 'pr-EMI-um'", () => {
        const r = evaluateOfferQuality(
            { store: "A", price: 120000, title: "Samsung Galaxy S26 Ultra 256GB Premium Edition" },
            [{ store: "A", price: 120000 }, { store: "B", price: 119000 }, { store: "C", price: 121000 }, { store: "D", price: 122000 }]
        );
        assert.strictEqual(r.status, "trusted", `expected trusted, got ${r.status} (${r.reasons})`);
        assert.ok(!r.reasons.includes("installment_or_partial_price"));
    });
    await test("bug fix: 'Unused Box Opened' must NOT false-trigger used_or_refurbished via 'used' inside 'UN-used'", () => {
        const r = evaluateOfferQuality(
            { store: "A", price: 120000, title: "Samsung Galaxy S26 Ultra 256GB Unused Box Opened" },
            [{ store: "A", price: 120000 }, { store: "B", price: 119000 }, { store: "C", price: 121000 }, { store: "D", price: 122000 }]
        );
        assert.strictEqual(r.status, "trusted", `expected trusted, got ${r.status} (${r.reasons})`);
        assert.ok(!r.reasons.includes("used_or_refurbished"));
    });
    await test("bug fix (control): a genuine 'Refurbished' listing must still fire used_or_refurbished after the word-boundary fix", () => {
        const r = evaluateOfferQuality(
            { store: "A", price: 90000, title: "Samsung Galaxy S26 Ultra 256GB (Refurbished)" },
            [{ store: "A", price: 90000 }, { store: "B", price: 119000 }, { store: "C", price: 121000 }, { store: "D", price: 122000 }]
        );
        assert.ok(r.reasons.includes("used_or_refurbished"));
    });
    await test("bug fix (control): a genuine EMI listing must still fire installment_or_partial_price after the word-boundary fix", () => {
        const r = evaluateOfferQuality(
            { store: "A", price: 4999, title: "Samsung Galaxy S26 Ultra EMI starting from ₹4,999/month" },
            [{ store: "A", price: 4999 }, { store: "B", price: 119000 }, { store: "C", price: 121000 }, { store: "D", price: 122000 }]
        );
        assert.ok(r.reasons.includes("installment_or_partial_price"));
    });

    // -----------------------------------------------------------------
    // Phase 10 full pipeline test — legitimate + suspicious + wrong-
    // generation + wrong-type offers ALL in the same fixture, proving
    // Gate 0/1 exclusions and Gate 2 flagging compose correctly together
    // and neither contaminates the other's inputs (spec Phase 2/10).
    // -----------------------------------------------------------------
    console.log("\n=== Phase 10: full pipeline — legit + suspicious + wrong-gen + wrong-type, all together ===");
    await test("Phase 10: wrong-generation/wrong-type offers never enter the price cluster; desertcart still correctly flagged suspicious among them", async () => {
        setFixture([
            { title: "Samsung Galaxy S26 Ultra 5G (Black, 12GB RAM, 256GB Storage)", source: "Amazon.in", link: "https://amazon.in/dp/s26u", price: "₹117,600" },
            { title: "Samsung Galaxy S26 Ultra 5G", source: "Flipkart.com", link: "https://flipkart.example/p1", price: "₹124,999" },
            { title: "Samsung Galaxy S26 Ultra", source: "MRV electronics", link: "https://mrv.example/p2", price: "₹94,999" },
            { title: "Samsung Galaxy S26 Ultra 5G | 12GB | 256GB", source: "myG", link: "https://myg.example/p3", price: "₹124,999" },
            { title: "Samsung Galaxy S26 Ultra & && ()", source: "desertcart", link: "https://desertcart.example/p4", price: "₹5,389" },
            { title: "Samsung Galaxy S25 Ultra", source: "OldStore1", link: "https://old1.example/p5", price: "₹70,000" },
            { title: "Samsung Galaxy S21 Ultra", source: "OldStore2", link: "https://old2.example/p6", price: "₹35,000" },
            { title: "Samsung Galaxy A56", source: "BudgetStore", link: "https://budget.example/p7", price: "₹25,000" },
            { title: "Samsung Galaxy S26 Ultra Motherboard", source: "Cellspare", link: "https://cellspare.example/p8", price: "₹10,000" },
        ]);
        const result = await compareByProduct({ brand: "Samsung", model: "Galaxy S26 Ultra", productName: "Galaxy S26 Ultra", storage: "256GB", ram: "12GB" });

        const platforms = result.results.map((r) => r.platform);
        console.log(`      surviving platforms: ${platforms.join(", ")}`);
        console.log(`      bestOffer: ${result.bestOffer.platform} ₹${result.bestOffer.price}, savings: ${result.savings}`);

        assert.ok(!platforms.some((p) => ["OldStore1", "OldStore2", "BudgetStore", "Cellspare"].includes(p)), "wrong-generation/wrong-type offers must be fully excluded from results, never just demoted");
        const desertcart = result.results.find((r) => r.platform === "desertcart");
        assert.ok(desertcart, "desertcart must still be visible");
        assert.strictEqual(desertcart.offerQuality, "suspicious");
        assert.strictEqual(desertcart.usableForBestOffer, false);
        assert.strictEqual(result.bestOffer.platform, "MRV electronics");
        assert.strictEqual(result.bestOffer.price, 94999);
        assert.strictEqual(result.savings, 30000, "the wrong-generation ₹70,000/₹35,000/₹25,000/₹10,000 offers must never enter the price cluster used for savings, and desertcart's ₹5,389 must never enter it either");
    });

    // -----------------------------------------------------------------
    // Spec section 15 — confident/possible bookkeeping regression
    // -----------------------------------------------------------------
    console.log("\n=== Confident/possible bookkeeping fix (spec section 15) ===");
    await test("bookkeeping: an offer with matchConfidence 0.64 (POSSIBLE_MATCH/uncertain tier) is filed under possibleMatches, not counted as confident", async () => {
        setFixture([
            { title: "Samsung Galaxy S26 Ultra 256GB 12GB RAM", source: "Amazon.in", link: "https://amazon.in/dp/s26u", price: "₹1,17,600" },
            // Deliberately vague/partial title -> lands in the ~0.5-0.75 band
            // (POSSIBLE_MATCH / "uncertain" tier) without tripping Gate 1 at all.
            { title: "Samsung Galaxy Ultra Smartphone Titanium 5G", source: "JioMart", link: "https://jiomart.example/p", price: "₹1,19,999" },
        ]);
        const result = await compareByProduct({ brand: "Samsung", model: "Galaxy S26 Ultra", productName: "Galaxy S26 Ultra", storage: "256GB", ram: "12GB" });
        const jiomart = result.results.find((r) => r.platform === "JioMart");
        console.log(`      JioMart: matchConfidence=${jiomart.matchConfidence} matchDecision=${jiomart.matchDecision} matchTier=${jiomart.matchTier} isPossibleMatch=${jiomart.isPossibleMatch}`);
        assert.ok(jiomart.matchConfidence < BEST_OFFER_MATCH_THRESHOLD_FOR_TEST, `test setup expected a mid-confidence match, got ${jiomart.matchConfidence}`);
        // The core bug: these three must always agree with each other.
        assert.strictEqual(jiomart.isPossibleMatch, true, "a sub-0.75 match must be filed under possibleMatches, not confident");
        assert.strictEqual(jiomart.matchTier, "possible", "matchTier must agree with isPossibleMatch");
        assert.ok(jiomart.matchDecision === "POSSIBLE_MATCH" || jiomart.matchDecision === "UNCERTAIN");
    });

    console.log("\n=== SUMMARY ===");
    const passed = results.filter((r) => r.pass).length;
    console.log(`${passed}/${results.length} passed`);
    if (passed !== results.length) process.exitCode = 1;
}

const BEST_OFFER_MATCH_THRESHOLD_FOR_TEST = 0.75;

main();
