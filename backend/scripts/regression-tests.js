/**
 * Stage 2.1 — Part 9 test suite (TEST A through G)
 * ------------------------------------------------------------------
 * Runs the real, unmodified compareService.js/googleShopping.js against
 * controlled fake Serper responses, so results are 100% deterministic and
 * require no network or SERPER_API_KEY. For real live-API validation
 * (Part 10), use scripts/run-live-tests.js instead — that one genuinely
 * calls Serper and cannot be faked.
 *
 * USAGE: node scripts/regression-tests.js
 */

const assert = require("assert");
const path = require("path");
const Module = require("module");

// ---------------------------------------------------------------------
// Fake HTTP layer — controlled per-test via `setFixture()`/`setFailure()`.
// No production file is modified; this only patches `require` for the
// lifetime of this script.
// ---------------------------------------------------------------------

let currentShopping = [];
let currentShouldFail = false;
let currentSearchResults = []; // fake response for merchantUrlResolver's web-search calls

function setFixture(shoppingItems) {
    currentShopping = shoppingItems;
    currentShouldFail = false;
}

function setFailure() {
    currentShouldFail = true;
}

function setSearchResults(organicResults) {
    currentSearchResults = organicResults;
}

const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
    if (id === "axios") {
        return {
            post: async (url) => {
                if (currentShouldFail) throw new Error("Request failed with status code 403 (simulated invalid API key)");
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

const { compareByQuery, compareByProduct } = require(path.join(__dirname, "..", "services", "compareService"));

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------

const AIRDOPES_STORES = [
    "boAt", "bigbasket", "Zepto", "Wholemonkey", "Cashify", "Shopy Vision",
    "Fliptwirls", "Amazon", "Swagilo", "LowestRate Shopping", "Gadgets Now",
    "Giftana India", "Solutions World", "JioMart Grocery", "Bazaar",
];

function googleRedirect(i) {
    return `https://www.google.com/search?ibp=oshop&q=test&item=${i}`;
}

const FIXTURE_AIRDOPES = Array.from({ length: 40 }, (_, i) => ({
    title: "boAt Airdopes 141 Bluetooth Truly Wireless Earbuds",
    source: AIRDOPES_STORES[i % AIRDOPES_STORES.length],
    link: googleRedirect(i),
    price: `₹${(799 + i * 5).toLocaleString("en-IN")}`,
    rating: 4.2,
}));

const FIXTURE_S26_ULTRA = [
    { title: "Samsung Galaxy S26 Ultra 256GB Titanium Black", source: "Amazon.in", link: "https://amazon.in/dp/aaa", price: "₹129,999" },
    { title: "Samsung Galaxy S26 Ultra 256GB Titanium Gray", source: "Flipkart.com", link: googleRedirect(1), price: "₹127,999" },
    { title: "Samsung Galaxy S26 Ultra 512GB Titanium Black", source: "Croma", link: googleRedirect(2), price: "₹139,999" },
    { title: "Samsung Galaxy S26 256GB Titanium Black", source: "Vijay Sales", link: googleRedirect(3), price: "₹99,999" },
    { title: "Samsung Galaxy S26+ 256GB Titanium Black", source: "SomeStore", link: googleRedirect(4), price: "₹109,999" },
    { title: "Samsung Galaxy S25 Ultra 256GB Titanium Black", source: "OldModelStore", link: googleRedirect(5), price: "₹89,999" },
    { title: "Samsung Galaxy S26 Ultra Case Cover", source: "CaseStore", link: googleRedirect(6), price: "₹399" },
    { title: "Samsung Galaxy S26 Ultra Screen Protector 256GB", source: "ScreenGuardStore", link: googleRedirect(7), price: "₹299" },
];

const FIXTURE_IPHONE15 = [
    { title: "Apple iPhone 15 128GB Blue", source: "Amazon.in", link: "https://amazon.in/dp/bbb", price: "₹64,999" },
    { title: "Apple iPhone 15 256GB Blue", source: "Flipkart.com", link: googleRedirect(11), price: "₹74,999" },
    { title: "Apple iPhone 15 Pro 128GB Blue Titanium", source: "Croma", link: googleRedirect(12), price: "₹1,19,999" },
    { title: "Apple iPhone 15 Case Cover", source: "CaseWorld", link: googleRedirect(13), price: "₹499" },
];

// ---------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------

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

function findByStore(offers, storeSubstr) {
    return offers.find((o) => o.platform.toLowerCase().includes(storeSubstr.toLowerCase()));
}

async function main() {
    console.log("=== TEST A: boAt Airdopes 141 — multi-store dedup ===");
    await test("A1: multiple stores survive", async () => {
        setFixture(FIXTURE_AIRDOPES);
        const result = await compareByQuery("boAt Airdopes 141");
        const uniqueStores = new Set(result.results.map((r) => r.platform));
        console.log(`      unique stores: ${uniqueStores.size} (${[...uniqueStores].join(", ")})`);
        assert.ok(uniqueStores.size > 1, "expected more than 1 store");
    });
    await test("A2: same store deduplicated, Google hostname does not collapse merchants", async () => {
        setFixture(FIXTURE_AIRDOPES);
        const result = await compareByQuery("boAt Airdopes 141");
        const uniqueStores = new Set(result.results.map((r) => r.platform));
        assert.strictEqual(uniqueStores.size, AIRDOPES_STORES.length, `expected ${AIRDOPES_STORES.length} unique merchants`);
    });

    console.log("\n=== TEST B: Samsung Galaxy S26 Ultra 256GB ===");
    let resultB;
    await test("B: 256GB accepted, 512GB/S26/S26+/S25 Ultra/accessories demoted", async () => {
        setFixture(FIXTURE_S26_ULTRA);
        resultB = await compareByProduct({ brand: "Samsung", model: "Galaxy S26 Ultra", productName: "Galaxy S26 Ultra", storage: "256GB" });
        const confident = resultB.results.filter((r) => !r.isPossibleMatch);
        const possible = resultB.results.filter((r) => r.isPossibleMatch);
        console.log(`      confident: ${confident.map((r) => r.platform).join(", ")}`);
        console.log(`      possible:  ${possible.map((r) => r.platform).join(", ")}`);

        assert.ok(confident.some((r) => r.platform.toLowerCase().includes("amazon")), "256GB Amazon listing should be confident");
        assert.ok(!confident.some((r) => r.title.includes("512GB")), "512GB listing must not be confident for a 256GB request");
        assert.ok(!confident.some((r) => r.title === "Samsung Galaxy S26 256GB Titanium Black"), "plain S26 (no Ultra) must not be confident");
        assert.ok(!confident.some((r) => r.title.includes("S26+")), "S26+ must not be confident when Ultra was requested");
        assert.ok(!confident.some((r) => r.title.includes("S25")), "S25 Ultra must not be confident for an S26 Ultra request");
        assert.ok(!confident.some((r) => /case|cover|screen protector/i.test(r.title)), "accessories must not be confident");
        assert.ok(resultB.bestOffer && resultB.bestOffer.price < 130000, "bestOffer should be a real 256GB offer, not a wrong-variant cheap one");
    });

    console.log("\n=== TEST C: Samsung Galaxy S26 Ultra 512GB (run separately) ===");
    await test("C: 512GB accepted this time, 256GB correctly NOT treated as exact", async () => {
        setFixture(FIXTURE_S26_ULTRA);
        const resultC = await compareByProduct({ brand: "Samsung", model: "Galaxy S26 Ultra", productName: "Galaxy S26 Ultra", storage: "512GB" });
        const confident = resultC.results.filter((r) => !r.isPossibleMatch);
        console.log(`      confident: ${confident.map((r) => r.platform + " (" + r.title + ")").join(" | ")}`);
        assert.ok(confident.some((r) => r.title.includes("512GB")), "512GB listing should now be confident");
        assert.ok(!confident.some((r) => r.title.includes("256GB")), "256GB listings must NOT be confident for a 512GB request");
    });

    console.log("\n=== TEST D: iPhone 15 128GB ===");
    await test("D: 128GB accepted, 256GB/Pro/case demoted", async () => {
        setFixture(FIXTURE_IPHONE15);
        const resultD = await compareByProduct({ brand: "Apple", model: "iPhone 15", productName: "iPhone 15", storage: "128GB" });
        const confident = resultD.results.filter((r) => !r.isPossibleMatch);
        console.log(`      confident: ${confident.map((r) => r.platform + " (" + r.title + ")").join(" | ")}`);
        assert.ok(confident.some((r) => r.title === "Apple iPhone 15 128GB Blue"), "plain iPhone 15 128GB should be confident");
        assert.ok(!confident.some((r) => r.title.includes("256GB")), "256GB must not be confident for a 128GB request");
        assert.ok(!confident.some((r) => r.title.includes("Pro")), "iPhone 15 Pro must not be confident for a plain iPhone 15 request");
        assert.ok(!confident.some((r) => /case|cover/i.test(r.title)), "case must not be confident");
    });

    console.log("\n=== TEST E: invalid/nonsense product ===");
    await test("E: clean 'no comparable offers' error, not a crash", async () => {
        setFixture([]); // simulates Serper genuinely finding nothing
        await assert.rejects(
            () => compareByQuery("zzqxvthisisnotarealproductnamezz123"),
            (err) => {
                console.log(`      threw cleanly: "${err.message}" (statusCode ${err.statusCode})`);
                return typeof err.message === "string" && err.message.length > 0;
            }
        );
    });

    console.log("\n=== TEST F: invalid Serper key / API failure ===");
    await test("F: clean error, no crash, no fake results", async () => {
        setFailure();
        await assert.rejects(
            () => compareByQuery("boAt Airdopes 141"),
            (err) => {
                console.log(`      threw cleanly: "${err.message}" (statusCode ${err.statusCode})`);
                assert.strictEqual(err.statusCode, 502, "an actual adapter failure should be distinguishable (502) from genuine zero-results (404)");
                return typeof err.message === "string" && err.message.length > 0;
            }
        );
    });

    console.log("\n=== TEST G: URL extraction reporting ===");
    await test("G: every offer reports platform/title/url/isGoogleRedirect/merchantUrlSource", async () => {
        // Reuses TEST B's result, computed above.
        console.log("      STORE | TITLE | URL | isGoogleRedirect | merchantUrlSource");
        resultB.results.forEach((r) => {
            console.log(`      ${r.platform} | ${r.title} | ${r.url} | ${r.isGoogleRedirect} | ${r.merchantUrlSource}`);
        });
        assert.ok(resultB.results.every((r) => typeof r.isGoogleRedirect === "boolean"), "every offer must report isGoogleRedirect");
        assert.ok(resultB.results.every((r) => r.url), "every offer must have a real url (none dropped/fabricated)");
        const directOne = findByStore(resultB.results, "amazon");
        assert.ok(directOne && directOne.isGoogleRedirect === false, "Amazon offer (given a direct link in the fixture) should NOT be flagged as a Google redirect");
    });

    console.log("\n=== TEST K-T: Stage 2.3.1 — descriptor words must not cause false variant_mismatch ===");
    {
        const { computeMatchConfidence, extractRamAndStorage } = require(path.join(__dirname, "..", "services", "productMatcher"));
        const source = { brand: "Samsung", model: "Galaxy S26 Ultra", productName: "Galaxy S26 Ultra" };
        const sourceWithStorage = { ...source, storage: "256GB" };
        const sourceWithRam = { ...sourceWithStorage, ram: "12GB" };

        await test("K: 'Galaxy S26 Ultra 5G' is not a variant mismatch, strong/good confidence", async () => {
            const r = computeMatchConfidence(source, "Samsung Galaxy S26 Ultra 5G");
            assert.notStrictEqual(r.primaryIssue, "variant_mismatch");
            assert.ok(r.confidence >= 0.75, `expected >= 0.75, got ${r.confidence}`);
        });

        await test("L: 'Galaxy S26 Ultra Smartphone' is not a variant mismatch", async () => {
            const r = computeMatchConfidence(source, "Samsung Galaxy S26 Ultra Smartphone");
            assert.notStrictEqual(r.primaryIssue, "variant_mismatch");
            assert.ok(r.confidence >= 0.75, `expected >= 0.75, got ${r.confidence}`);
        });

        await test("M: 'Galaxy S26 Ultra 5G Dual SIM' is not a variant mismatch", async () => {
            const r = computeMatchConfidence(source, "Samsung Galaxy S26 Ultra 5G Dual SIM");
            assert.notStrictEqual(r.primaryIssue, "variant_mismatch");
            assert.ok(r.confidence >= 0.75, `expected >= 0.75, got ${r.confidence}`);
        });

        await test("N: plain 'Galaxy S26 5G' (no Ultra) IS a variant mismatch", async () => {
            const r = computeMatchConfidence(source, "Samsung Galaxy S26 5G");
            assert.strictEqual(r.primaryIssue, "variant_mismatch");
            assert.ok(r.confidence < 0.5, `expected < 0.5, got ${r.confidence}`);
        });

        await test("O: 'Galaxy S26+' IS a variant mismatch", async () => {
            const r = computeMatchConfidence(source, "Samsung Galaxy S26+ 5G");
            assert.strictEqual(r.primaryIssue, "variant_mismatch");
            assert.ok(r.confidence < 0.5, `expected < 0.5, got ${r.confidence}`);
        });

        await test("P: 'Galaxy S26 Edge' IS a variant mismatch", async () => {
            const r = computeMatchConfidence({ ...source, model: "Galaxy S26 Ultra Edge", productName: "Galaxy S26 Ultra Edge" }, "Samsung Galaxy S26 5G");
            // (sanity: unrelated candidate still rejected under an Edge-flavored source too)
            assert.ok(r.confidence < 0.5);
        });

        await test("Q: missing storage is storage_unconfirmed, NOT variant_mismatch", async () => {
            const r = computeMatchConfidence(sourceWithStorage, "Samsung Galaxy S26 Ultra 5G");
            assert.strictEqual(r.primaryIssue, "storage_unconfirmed");
            assert.notStrictEqual(r.primaryIssue, "variant_mismatch");
        });

        await test("R: wrong storage (512GB vs 256GB) remains a hard mismatch", async () => {
            const r = computeMatchConfidence(sourceWithStorage, "Samsung Galaxy S26 Ultra 5G 512GB");
            assert.strictEqual(r.primaryIssue, "storage_mismatch");
            assert.ok(r.confidence < 0.5, `expected < 0.5, got ${r.confidence}`);
        });

        await test("S: RAM/Storage order regression — '12GB RAM 256GB Storage' extracts correctly", async () => {
            const { ram, storage } = extractRamAndStorage("Samsung Galaxy S26 Ultra 12GB RAM 256GB Storage");
            assert.strictEqual(ram, "12gb");
            assert.strictEqual(storage, "256gb");
        });

        await test("T: RAM mismatch is demoted (Good match ceiling), never a hard rejection; missing RAM not penalized", async () => {
            const wrongRam = computeMatchConfidence(sourceWithRam, "Samsung Galaxy S26 Ultra (8GB RAM, 256GB Storage)");
            assert.strictEqual(wrongRam.primaryIssue, "ram_mismatch");
            assert.ok(wrongRam.confidence < 0.9, `RAM mismatch must not reach Strong-match tier, got ${wrongRam.confidence}`);
            assert.ok(wrongRam.confidence >= 0.5, `RAM mismatch must not be a hard rejection, got ${wrongRam.confidence}`);

            const missingRam = computeMatchConfidence(sourceWithRam, "Samsung Galaxy S26 Ultra 256GB");
            assert.notStrictEqual(missingRam.primaryIssue, "ram_mismatch");
        });
    }

    console.log("\n=== TEST J: confidence UI — RAM+Storage title must not corrupt matching (Part 17 real-world bug) ===");
    // POLICY CHANGE (Phase 2 precision fix, see PRODUCT_TYPE_FIX_REPORT.md /
    // the Phase 2 report): this test originally asserted that "Samsung
    // Galaxy S26 (no Ultra)" — a genuine variant mismatch against an
    // "S26 Ultra" request — should survive as a visible "possible match"
    // (isPossibleMatch: true, matchIssue: "variant_mismatch"). That was
    // deliberate V2 behavior at the time (see productMatcher.js's old
    // `score = Math.min(score, 0.25)` variant-mismatch handling).
    //
    // The Phase 2 spec explicitly supersedes this: a wrong variant/family/
    // generation is no longer "a possible match with an asterisk" — it must
    // be excluded from results entirely (HARD_REJECT), the same way a
    // product-type conflict (Gate 0) already was. Soft demotion is now
    // reserved for genuine SKU-level differences (storage/RAM/color) where
    // the underlying product identity is not in question. See
    // services/productMatcher.js's evaluateVariantIdentity (Gate 1).
    //
    // This test is updated — not silently, per the fix's own instructions —
    // to assert the NEW intended behavior instead of deleting/weakening it.
    await test("J: genuine S26 Ultra with RAM-before-Storage phrasing scores Strong, not Low confidence; S26 (no Ultra) is now HARD_REJECT and excluded from results", async () => {
        const fixture = [
            { title: "Samsung Galaxy S26 Ultra 5G (12GB RAM, 256GB Storage) Titanium Black", source: "Amazon.in", link: "https://amazon.in/dp/s26u", price: "₹1,29,999" },
            { title: "Samsung Galaxy S26 5G (12GB RAM, 256GB Storage)", source: "SomeStore", link: "https://somestore.com/p/s26", price: "₹73,799" },
            { title: "Samsung Galaxy S26 Ultra 5G (12GB RAM, 512GB Storage)", source: "AnotherStore", link: "https://another.com/p/s26u512", price: "₹1,00,000" },
        ];
        setFixture(fixture);
        // Mirrors exactly how a typed query with both RAM and Storage flows
        // through the real app (compareByQuery), which is what exposed the bug.
        const result = await compareByQuery("Samsung Galaxy S26 Ultra 5G 12GB RAM 256GB Storage");

        const amazonCard = findByStore(result.results, "amazon");
        const s26Card = result.results.find((r) => r.title === "Samsung Galaxy S26 5G (12GB RAM, 256GB Storage)");
        // The public compareByQuery/compareByProduct response only exposes
        // offers+possibleMatches (rejectedOffers is engine-internal — see
        // compareEngine.js/offerRanker.js), so verify the rejection reason
        // directly against the matcher, the same way TEST 1 in
        // tests/matching/productTypeConflict.test.js verifies Gate 0.
        const { computeMatchConfidence } = require(path.join(__dirname, "..", "services", "productMatcher"));
        const s26Identity = computeMatchConfidence(
            { brand: "Samsung", model: "Galaxy S26 Ultra", productName: "Galaxy S26 Ultra", storage: "256GB", ram: "12GB" },
            "Samsung Galaxy S26 5G (12GB RAM, 256GB Storage)"
        );

        console.log(`      Amazon (genuine S26 Ultra 256GB): confidence=${amazonCard.matchConfidence} tier=${amazonCard.matchTier} isPossibleMatch=${amazonCard.isPossibleMatch}`);
        console.log(`      SomeStore (S26, no Ultra): ${s26Card ? "still in results (UNEXPECTED)" : "excluded from results (expected)"}; identity decision=${s26Identity.matchDecision} issue=${s26Identity.primaryIssue}`);
        console.log(`      bestOffer: ${result.bestOffer.platform} ₹${result.bestOffer.price}`);

        assert.strictEqual(amazonCard.matchConfidence, 1, "genuine match must score 1.0, not be corrupted by RAM/storage confusion");
        assert.strictEqual(amazonCard.isPossibleMatch, false, "genuine match must not be a possible/low-confidence match");
        assert.strictEqual(s26Card, undefined, "plain S26 (no Ultra) must now be excluded from results entirely, not shown as a possible match");
        assert.strictEqual(s26Identity.hardReject, true, "plain S26 (no Ultra) must be a Gate 1 hard rejection, not a soft demotion");
        assert.strictEqual(s26Identity.matchDecision, "HARD_REJECT");
        assert.strictEqual(s26Identity.primaryIssue, "variant_mismatch", "plain S26 must be tagged variant_mismatch, now as a hard-rejection reason");
        assert.strictEqual(result.bestOffer.platform, "Amazon", "bestOffer must be the genuine S26 Ultra match, not the cheaper wrong-variant S26");
        assert.ok(result.savings === 0 || result.savings < 30000, "savings must not be inflated by the excluded wrong-variant S26 (₹73,799 vs ₹1,29,999 would be a misleading gap)");
    });

    console.log("\n=== TEST H: retailer prioritization doesn't get swamped by obscure sellers (Part 14) ===");
    await test("H: Amazon/Flipkart/Croma/Vijay Sales/Reliance Digital/Samsung surface as Recommended when present, ahead of a flood of obscure sellers", async () => {
        const obscureNames = ["Little Wish", "Gadgets Now", "Giftana India", "Solutions World", "Swagilo", "Fliptwirls", "Bazaar", "LowestRate Shopping"];
        const fixture = [
            { title: "Samsung Galaxy S26 Ultra 256GB Titanium Black", source: "Amazon.in", link: "https://amazon.in/dp/s26u", price: "₹1,29,999" },
            { title: "Samsung Galaxy S26 Ultra 256GB Titanium Black", source: "Flipkart.com", link: "https://flipkart.com/p/s26u", price: "₹1,27,999" },
            { title: "Samsung Galaxy S26 Ultra 256GB Titanium Black", source: "Croma", link: "https://croma.com/p/s26u", price: "₹1,29,499" },
            { title: "Samsung Galaxy S26 Ultra 256GB Titanium Black", source: "Vijay Sales", link: "https://vijaysales.com/p/s26u", price: "₹1,30,499" },
            { title: "Samsung Galaxy S26 Ultra 256GB Titanium Black", source: "Reliance Digital", link: "https://reliancedigital.in/p/s26u", price: "₹1,28,999" },
            { title: "Samsung Galaxy S26 Ultra 256GB Titanium Black", source: "Samsung.com", link: "https://samsung.com/in/p/s26u", price: "₹1,29,999" },
            ...obscureNames.map((name, i) => ({
                title: "Samsung Galaxy S26 Ultra 256GB Titanium Black",
                source: name,
                link: googleRedirect(20 + i),
                price: `₹${(115000 + i * 500).toLocaleString("en-IN")}`, // cheaper than every Tier 1 offer
            })),
        ];
        setFixture(fixture);
        const result = await compareByProduct({ brand: "Samsung", model: "Galaxy S26 Ultra", productName: "Galaxy S26 Ultra", storage: "256GB" });

        const confident = result.results.filter((r) => !r.isPossibleMatch);
        const major = confident.filter((r) => r.retailerTier === "major_retailer");
        const other = confident.filter((r) => r.retailerTier === "other_seller");

        console.log(`      major_retailer offers: ${major.map((r) => r.platform).join(", ")}`);
        console.log(`      other_seller offers: ${other.length} (obscure names present, correctly demoted in ordering, not deleted)`);
        console.log(`      bestOffer (true lowest valid price, tier-independent): ${result.bestOffer.platform} ₹${result.bestOffer.price}`);
        console.log(`      first 3 in final ordering: ${confident.slice(0, 3).map((r) => r.platform).join(", ")}`);

        ["Amazon", "Flipkart", "Croma", "Vijay Sales", "Reliance Digital", "Samsung"].forEach((name) => {
            assert.ok(major.some((r) => r.platform.toLowerCase().includes(name.toLowerCase())), `${name} should be classified major_retailer and present`);
        });
        assert.ok(other.length === obscureNames.length, "obscure sellers must be kept (not deleted), just deprioritized");
        assert.ok(
            confident.slice(0, 6).every((r) => r.retailerTier === "major_retailer"),
            "the first 6 results (all Tier 1 count) must be major retailers, not obscure sellers, despite obscure sellers being cheaper"
        );
        // bestOffer is a separate, tier-independent fact — the true cheapest
        // valid price, even if it's an obscure seller. It must never be
        // suppressed or overridden by tier preference.
        assert.ok(obscureNames.some((n) => n.toLowerCase() === result.bestOffer.platform.toLowerCase()), "bestOffer must reflect the true lowest valid price regardless of tier");
    });

    console.log("\n=== TEST U: merchant URL resolver safety (Stage 2.3.1, Parts 15/20/21) ===");
    await test("U: allowlist enforced, domain-spoofing rejected, disabled-by-default is a safe no-op", async () => {
        const { resolveDirectMerchantUrl, getMerchantDomain, belongsToDomain } = require(path.join(__dirname, "..", "services", "stores", "merchantUrlResolver"));

        assert.strictEqual(getMerchantDomain("Amazon.in"), "amazon.in", "known merchant should map to its domain");
        assert.strictEqual(getMerchantDomain("Little Wish"), null, "unlisted merchant must not resolve to any domain");

        assert.strictEqual(belongsToDomain("https://amazon.in/dp/x", "amazon.in"), true);
        assert.strictEqual(belongsToDomain("https://myamazonfake.com/dp/x", "amazon.in"), false, "lookalike domain must be rejected");
        assert.strictEqual(belongsToDomain("https://amazon.in.evil.com/dp/x", "amazon.in"), false, "subdomain-spoofed lookalike must be rejected");

        // Disabled by default (ENABLE_MERCHANT_URL_RESOLVER unset in this test
        // process) — must be a safe no-op, never throw, never fabricate a URL.
        const result = await resolveDirectMerchantUrl("Amazon", "Samsung Galaxy S26 Ultra 256GB");
        assert.strictEqual(result, null, "resolver must no-op (return null) when not explicitly enabled");
    });

    console.log("\n=== TEST V-AF: Stage 2.3.2 — direct merchant URL resolution ===");
    {
        const { belongsToDomain, resolveDirectMerchantUrl } = require(path.join(__dirname, "..", "services", "stores", "merchantUrlResolver"));
        const { computeMatchConfidence } = require(path.join(__dirname, "..", "services", "productMatcher"));

        await test("V: direct merchant URL preserved as isDirectMerchantUrl=true, isGoogleRedirect=false", async () => {
            setFixture([{ title: "Samsung Galaxy S26 Ultra 5G", source: "Amazon.in", link: "https://amazon.in/dp/real123", price: "₹1,29,999" }]);
            const result = await compareByQuery("Samsung Galaxy S26 Ultra");
            const amazon = result.results.find((r) => r.platform.toLowerCase().includes("amazon"));
            assert.strictEqual(amazon.isDirectMerchantUrl, true);
            assert.strictEqual(amazon.isGoogleRedirect, false);
        });

        await test("W: Google Shopping URL recognized as isDirectMerchantUrl=false, isGoogleRedirect=true", async () => {
            setFixture([{ title: "Samsung Galaxy S26 Ultra 5G", source: "Amazon.in", link: googleRedirect(99), price: "₹1,29,999" }]);
            const result = await compareByQuery("Samsung Galaxy S26 Ultra");
            const amazon = result.results.find((r) => r.platform.toLowerCase().includes("amazon"));
            assert.strictEqual(amazon.isDirectMerchantUrl, false);
            assert.strictEqual(amazon.isGoogleRedirect, true);
        });

        await test("X: fake Amazon domain (myamazonfake.com) rejected", async () => {
            assert.strictEqual(belongsToDomain("https://myamazonfake.com/product", "amazon.in"), false);
        });

        await test("Y: malicious lookalike domain (amazon.in.evil.com) rejected", async () => {
            assert.strictEqual(belongsToDomain("https://amazon.in.evil.com/product", "amazon.in"), false);
        });

        await test("Z: resolver disabled (ENABLE_MERCHANT_URL_RESOLVER unset) — Google URL stays fallback, no network call attempted", async () => {
            delete process.env.ENABLE_MERCHANT_URL_RESOLVER;
            setSearchResults([{ title: "should not be reached", link: "https://amazon.in/dp/shouldnotresolve" }]);
            const resolved = await resolveDirectMerchantUrl("Amazon", "Samsung Galaxy S26 Ultra 256GB__testZ");
            assert.strictEqual(resolved, null, "must stay null when the feature flag is not set to true");
        });

        await test("AA: resolver enabled with a valid Amazon candidate resolves a verified direct URL", async () => {
            process.env.ENABLE_MERCHANT_URL_RESOLVER = "true";
            process.env.SERPER_API_KEY = process.env.SERPER_API_KEY || "fake_key_for_regression_test";
            setSearchResults([
                { title: "Samsung Galaxy S26 Ultra 5G - Amazon.in", link: "https://amazon.in/dp/VERIFIED123", snippet: "Samsung Galaxy S26 Ultra 256GB" },
            ]);
            const resolved = await resolveDirectMerchantUrl("Amazon", "Samsung Galaxy S26 Ultra 256GB__testAA", {
                matchValidator: (text) => computeMatchConfidence({ brand: "Samsung", model: "Galaxy S26 Ultra", productName: "Galaxy S26 Ultra", storage: "256GB" }, text).confidence >= 0.5,
            });
            assert.strictEqual(resolved, "https://amazon.in/dp/VERIFIED123");
            delete process.env.ENABLE_MERCHANT_URL_RESOLVER;
        });

        await test("AB: wrong-merchant candidate (Flipkart URL when Amazon requested) rejected by domain validation", async () => {
            process.env.ENABLE_MERCHANT_URL_RESOLVER = "true";
            setSearchResults([{ title: "Samsung Galaxy S26 Ultra", link: "https://flipkart.com/p/wrongmerchant" }]);
            const resolved = await resolveDirectMerchantUrl("Amazon", "Samsung Galaxy S26 Ultra 256GB__testAB", { matchValidator: () => true });
            assert.strictEqual(resolved, null, "a Flipkart URL must never be accepted as an Amazon resolution");
            delete process.env.ENABLE_MERCHANT_URL_RESOLVER;
        });

        await test("AC: wrong-product candidate (plain S26 when Ultra requested) rejected by relevance validation", async () => {
            process.env.ENABLE_MERCHANT_URL_RESOLVER = "true";
            setSearchResults([{ title: "Samsung Galaxy S26 5G - Amazon.in", link: "https://amazon.in/dp/WRONGPRODUCT", snippet: "Samsung Galaxy S26 5G Smartphone, 256GB" }]);
            const source = { brand: "Samsung", model: "Galaxy S26 Ultra", productName: "Galaxy S26 Ultra" };
            const resolved = await resolveDirectMerchantUrl("Amazon", "Samsung Galaxy S26 Ultra__testAC", {
                matchValidator: (text) => computeMatchConfidence(source, text).confidence >= 0.5,
            });
            assert.strictEqual(resolved, null, "a plain S26 listing must not be accepted when Ultra was requested");
            delete process.env.ENABLE_MERCHANT_URL_RESOLVER;
        });

        await test("AD: wrong-storage candidate (512GB when 256GB requested) rejected by relevance validation", async () => {
            process.env.ENABLE_MERCHANT_URL_RESOLVER = "true";
            setSearchResults([{ title: "Samsung Galaxy S26 Ultra 512GB - Amazon.in", link: "https://amazon.in/dp/WRONGSTORAGE", snippet: "" }]);
            const source = { brand: "Samsung", model: "Galaxy S26 Ultra", productName: "Galaxy S26 Ultra", storage: "256GB" };
            const resolved = await resolveDirectMerchantUrl("Amazon", "Samsung Galaxy S26 Ultra 256GB__testAD", {
                matchValidator: (text) => computeMatchConfidence(source, text).confidence >= 0.5,
            });
            assert.strictEqual(resolved, null, "512GB must not be accepted when 256GB was requested");
            delete process.env.ENABLE_MERCHANT_URL_RESOLVER;
        });

        await test("AE: failed resolution preserves the Google fallback URL and isDirectMerchantUrl=false", async () => {
            // Resolver enabled but returns nothing useful (no organic results) —
            // the offer must keep its original Google Shopping URL, not lose its URL entirely.
            process.env.ENABLE_MERCHANT_URL_RESOLVER = "true";
            setSearchResults([]);
            setFixture([{ title: "Samsung Galaxy S26 Ultra 5G", source: "Amazon.in", link: googleRedirect(77), price: "₹1,29,999" }]);
            const result = await compareByQuery("Samsung Galaxy S26 Ultra__testAE");
            const amazon = result.results.find((r) => r.platform.toLowerCase().includes("amazon"));
            assert.ok(amazon.url, "URL must not be dropped just because resolution failed");
            assert.strictEqual(amazon.isDirectMerchantUrl, false);
            assert.strictEqual(amazon.isGoogleRedirect, true);
            delete process.env.ENABLE_MERCHANT_URL_RESOLVER;
        });

        await test("AF: Google fallback is never the direct best offer, even when cheaper (bestDirectOffer distinct from bestOffer)", async () => {
            const { buildComparison } = require(path.join(__dirname, "..", "services", "priceComparator"));
            const scored = [
                { store: "GoogleFallback", price: 119000, availability: "in_stock", matchConfidence: 0.9, productUrl: googleRedirect(1), _isGoogleRedirectUrl: true, _retailerTier: "major_retailer" },
                { store: "DirectMerchant", price: 120000, availability: "in_stock", matchConfidence: 0.9, productUrl: "https://amazon.in/dp/direct", _isGoogleRedirectUrl: false, _retailerTier: "major_retailer" },
            ];
            const result = buildComparison(scored);
            assert.strictEqual(result.bestOffer.store, "GoogleFallback", "bestOffer (cheapest discovered price) unaffected");
            assert.strictEqual(result.bestDirectOffer.store, "DirectMerchant", "bestDirectOffer must be the direct one, not the cheaper redirect");
            assert.strictEqual(result.offers.length, 2, "the cheaper Google result must not be discarded from the overall list");
        });
    }

    console.log("\n=== SUMMARY ===");
    const passed = results.filter((r) => r.pass).length;
    console.log(`${passed}/${results.length} passed`);
    results.filter((r) => !r.pass).forEach((r) => console.log(`  FAILED: ${r.name} — ${r.error}`));
    process.exitCode = passed === results.length ? 0 : 1;
}

main().catch((err) => {
    console.error("Test runner crashed:", err);
    process.exitCode = 1;
});
