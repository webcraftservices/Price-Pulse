/**
 * Product-Identity Conflict tests — Phase 2 Precision Fix (Gate 1)
 * ------------------------------------------------------------------
 * Root cause: Gate 0 (productTypeClassifier.js) correctly rejects
 * wrong-KIND candidates (spare parts/accessories), but wrong-MODEL
 * candidates that share the same brand/category/family tokens (a
 * different generation, variant, or family within the same product
 * line) only capped the numeric score partway through
 * computeMatchConfidence — a cap that later storage/RAM/color bonuses
 * could partially undo, and that offerEligibility.isEligibleForResults
 * never checked in the first place (it only ever looked at
 * `hardReject`). That's how "Samsung Galaxy S25/S24/S21 Ultra" and
 * "Samsung Galaxy A56" kept reappearing as "possible matches" for an
 * S26 Ultra request.
 *
 * This suite proves the new Gate 1 (services/productMatcher.js's
 * evaluateVariantIdentity) fixes it — deterministically, with fake
 * Serper data, no network or API key required — and that it
 * generalizes across product categories (Samsung phones, iPhone,
 * MacBook, GPUs, PlayStation, Samsung SSDs), not just the one reported
 * bug.
 *
 * USAGE: node tests/matching/productIdentityConflict.test.js
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
const { computeMatchConfidence, evaluateVariantIdentity } = require(path.join(__dirname, "..", "..", "services", "productMatcher"));

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

// Asserts a genuine identity conflict: HARD_REJECT, confidence forced to 0,
// and the specific reason code (not just "some rejection").
function assertHardReject(source, candidateTitle, expectedIssue, label) {
    const r = computeMatchConfidence(source, candidateTitle);
    assert.strictEqual(r.hardReject, true, `${label}: expected hardReject=true, got matchDecision=${r.matchDecision}`);
    assert.strictEqual(r.confidence, 0, `${label}: expected confidence forced to 0, got ${r.confidence}`);
    assert.strictEqual(r.matchDecision, "HARD_REJECT", `${label}: expected matchDecision=HARD_REJECT`);
    assert.strictEqual(r.primaryIssue, expectedIssue, `${label}: expected primaryIssue=${expectedIssue}, got ${r.primaryIssue}`);
}

function assertValidMatch(source, candidateTitle, label) {
    const r = computeMatchConfidence(source, candidateTitle);
    assert.strictEqual(r.hardReject, false, `${label}: expected NOT hard-rejected, got reason=${r.reason}`);
}

async function main() {
    // ---------------------------------------------------------------------
    // Samsung Galaxy S26 Ultra 12GB 256GB — the exact reported live bug
    // ---------------------------------------------------------------------
    console.log("=== Samsung Galaxy S26 Ultra 12GB 256GB — full candidate matrix ===");
    const S26_ULTRA = { brand: "Samsung", model: "Galaxy S26 Ultra", productName: "Galaxy S26 Ultra", storage: "256GB", ram: "12GB" };

    await test("Samsung: exact spec match ('Samsung Galaxy S26 Ultra 256GB 12GB RAM') is a strong/exact match", () => {
        assertValidMatch(S26_ULTRA, "Samsung Galaxy S26 Ultra 256GB 12GB RAM", "exact");
        const r = computeMatchConfidence(S26_ULTRA, "Samsung Galaxy S26 Ultra 256GB 12GB RAM");
        assert.ok(r.confidence >= 0.75, `expected strong/exact, got ${r.confidence}`);
    });

    await test("Samsung: same model, incomplete spec ('Samsung Galaxy S26 Ultra') is a valid candidate, not hard-rejected", () => {
        assertValidMatch(S26_ULTRA, "Samsung Galaxy S26 Ultra", "incomplete spec");
    });

    await test("Samsung: same model, storage mismatch ('Samsung Galaxy S26 Ultra 512GB') stays a SOFT demotion, not HARD_REJECT", () => {
        const r = computeMatchConfidence(S26_ULTRA, "Samsung Galaxy S26 Ultra 512GB 12GB RAM");
        assert.strictEqual(r.hardReject, false, "a storage mismatch alone must remain soft (Gate 3), never Gate 1 hard-reject");
        assert.strictEqual(r.primaryIssue, "storage_mismatch");
        assert.ok(r.confidence < 0.5, `expected demoted below the confident bucket, got ${r.confidence}`);
    });

    await test("Samsung: wrong variant ('Samsung Galaxy S26+') is HARD_REJECT (variant_mismatch)", () => {
        assertHardReject(S26_ULTRA, "Samsung Galaxy S26+", "variant_mismatch", "S26+");
    });

    await test("Samsung: wrong generation ('Samsung Galaxy S25 Ultra') is HARD_REJECT (generation_mismatch)", () => {
        assertHardReject(S26_ULTRA, "Samsung Galaxy S25 Ultra", "generation_mismatch", "S25 Ultra");
    });

    await test("Samsung: wrong generation ('Samsung Galaxy S24 Ultra 5G AI Smartphone') is HARD_REJECT", () => {
        assertHardReject(S26_ULTRA, "Samsung Galaxy S24 Ultra 5G AI Smartphone", "generation_mismatch", "S24 Ultra");
    });

    await test("Samsung: wrong generation, token overlap despite matching storage/RAM ('Samsung Galaxy S21 Ultra 256GB 12GB RAM') is HARD_REJECT", () => {
        // This is the exact case that proves the fix: brand/storage/RAM ALL
        // match, and it must still be rejected on generation alone.
        assertHardReject(S26_ULTRA, "Samsung Galaxy S21 Ultra 256GB 12GB RAM", "generation_mismatch", "S21 Ultra 256GB 12GB RAM");
    });

    await test("Samsung: wrong family ('Samsung Galaxy A56 5G Samsung') is HARD_REJECT", () => {
        assertHardReject(S26_ULTRA, "Samsung Galaxy A56 5G Samsung", "generation_mismatch", "A56");
    });

    await test("Samsung: replacement part ('Samsung Galaxy S26 Ultra Motherboard PCB') is HARD_REJECT via Gate 0 (product_type_conflict), Gate 0 still fires first", () => {
        const r = computeMatchConfidence(S26_ULTRA, "Samsung Galaxy S26 Ultra 256GB 12GB RAM Motherboard PCB");
        assert.strictEqual(r.hardReject, true);
        assert.strictEqual(r.primaryIssue, "product_type_conflict", "Gate 0 must still fire before Gate 1 ever runs");
    });

    console.log("\n=== Samsung: end-to-end pipeline — possibleMatches must not become a dumping ground ===");
    await test("Samsung E2E: only the genuine S26 Ultra offers reach results; every wrong-model/variant/generation/family offer is fully excluded", async () => {
        setFixture([
            { title: "Samsung Galaxy S26 Ultra 256GB 12GB RAM", source: "MRV electronics", link: "https://mrv.example/p/1", price: "₹94999" },
            { title: "Samsung Galaxy S26 Ultra", source: "Amazon.in", link: "https://amazon.in/dp/2", price: "₹119999" },
            { title: "Samsung Galaxy S26 Ultra 512GB", source: "Croma", link: "https://croma.example/p/3", price: "₹139999" },
            { title: "Samsung Galaxy S26+", source: "SomeStore", link: "https://somestore.example/p/4", price: "₹79999" },
            { title: "Samsung Galaxy S25 Ultra", source: "OldModelStore", link: "https://old.example/p/5", price: "₹70000" },
            { title: "Samsung Galaxy S24 Ultra", source: "OldModelStore2", link: "https://old2.example/p/6", price: "₹55000" },
            { title: "Samsung Galaxy S21 Ultra 256GB 12GB RAM", source: "Cellspare2", link: "https://cellspare2.example/p/7", price: "₹35000" },
            { title: "Samsung Galaxy A56 5G Samsung", source: "BudgetStore", link: "https://budget.example/p/8", price: "₹25000" },
            { title: "Samsung Galaxy S26 Ultra 256GB 12GB RAM Motherboard PCB", source: "Cellspare", link: "https://cellspare.example/p/9", price: "₹71999" },
        ]);
        const result = await compareByProduct(S26_ULTRA);

        const survivingTitles = result.results.map((r) => r.title);
        console.log(`      surviving in results: ${survivingTitles.join(" | ")}`);
        console.log(`      bestOffer: ${result.bestOffer.platform} ₹${result.bestOffer.price}`);
        console.log(`      savings: ${result.savings}`);

        // Only the 3 genuine S26 Ultra offers may survive at all (as
        // confident OR possible — but never a wrong model/variant/gen/family).
        assert.strictEqual(survivingTitles.length, 3, `expected exactly 3 surviving offers, got ${survivingTitles.length}: ${survivingTitles.join(", ")}`);
        assert.ok(!survivingTitles.some((t) => /S26\+|S25 Ultra|S24 Ultra|S21 Ultra|A56|Motherboard/.test(t)), "no wrong-model/part offer may survive in any form");

        // bestOffer must be the cheapest LEGITIMATE S26 Ultra offer — the
        // ₹25,000 A56 and ₹35,000 S21 Ultra must never win just for being cheap.
        assert.ok(result.bestOffer, "a valid bestOffer must still be found");
        assert.strictEqual(result.bestOffer.platform, "MRV electronics", "bestOffer must be the cheapest genuine S26 Ultra offer (₹94,999), not a wrong-model cheap one");
        assert.strictEqual(result.bestOffer.price, 94999);

        // Savings must be calculated only across the 3 genuine offers
        // (94999..139999 = 45000), never inflated by the ₹25,000 A56 or
        // ₹35,000 S21 Ultra pretending to be a legitimate comparison point.
        assert.ok(result.savings <= 45000, `savings must not be inflated by an excluded wrong-model offer, got ${result.savings}`);
    });

    // ---------------------------------------------------------------------
    // iPhone
    // ---------------------------------------------------------------------
    console.log("\n=== iPhone 17 Pro Max — full candidate matrix ===");
    const IPHONE_17_PRO_MAX = { brand: "Apple", model: "iPhone 17 Pro Max", productName: "iPhone 17 Pro Max" };

    await test("iPhone: exact match ('iPhone 17 Pro Max') is valid", () => assertValidMatch(IPHONE_17_PRO_MAX, "Apple iPhone 17 Pro Max", "exact"));
    await test("iPhone: wrong variant ('iPhone 17 Pro') is HARD_REJECT (variant_mismatch)", () => {
        assertHardReject(IPHONE_17_PRO_MAX, "Apple iPhone 17 Pro", "variant_mismatch", "17 Pro");
    });
    await test("iPhone: wrong variant, base model ('iPhone 17') is HARD_REJECT (variant_mismatch)", () => {
        assertHardReject(IPHONE_17_PRO_MAX, "Apple iPhone 17", "variant_mismatch", "17 base");
    });
    await test("iPhone: wrong generation, same variant ('iPhone 16 Pro Max') is HARD_REJECT (model_number_mismatch)", () => {
        // "17"/"16" are bare digits (no letter prefix), so this trips the
        // bare-model-number check rather than the letter+digit generation
        // check — same underlying concept ("wrong generation"), consistent
        // with the pre-existing primaryIssue vocabulary for this token shape.
        assertHardReject(IPHONE_17_PRO_MAX, "Apple iPhone 16 Pro Max", "model_number_mismatch", "16 Pro Max");
    });
    await test("iPhone: wrong generation ('iPhone 15 Pro Max') is HARD_REJECT (model_number_mismatch)", () => {
        assertHardReject(IPHONE_17_PRO_MAX, "Apple iPhone 15 Pro Max", "model_number_mismatch", "15 Pro Max");
    });
    await test("iPhone: replacement part ('iPhone 17 Pro Max screen replacement') is HARD_REJECT via Gate 0", () => {
        const r = computeMatchConfidence(IPHONE_17_PRO_MAX, "iPhone 17 Pro Max screen replacement");
        assert.strictEqual(r.hardReject, true);
        assert.strictEqual(r.primaryIssue, "product_type_conflict");
    });

    // ---------------------------------------------------------------------
    // MacBook
    // ---------------------------------------------------------------------
    console.log("\n=== MacBook Air M4 — full candidate matrix ===");
    const MACBOOK_AIR_M4 = { brand: "Apple", model: "MacBook Air M4", productName: "MacBook Air M4" };

    await test("MacBook: exact match ('MacBook Air M4') is valid", () => assertValidMatch(MACBOOK_AIR_M4, "Apple MacBook Air M4", "exact"));
    await test("MacBook: wrong variant ('MacBook Pro M4') is HARD_REJECT (variant_mismatch)", () => {
        assertHardReject(MACBOOK_AIR_M4, "Apple MacBook Pro M4", "variant_mismatch", "Pro M4");
    });
    await test("MacBook: wrong generation ('MacBook Air M3') is HARD_REJECT (generation_mismatch)", () => {
        assertHardReject(MACBOOK_AIR_M4, "Apple MacBook Air M3", "generation_mismatch", "Air M3");
    });
    await test("MacBook: replacement part ('MacBook Air M4 screen replacement') is HARD_REJECT via Gate 0", () => {
        const r = computeMatchConfidence(MACBOOK_AIR_M4, "MacBook Air M4 screen replacement");
        assert.strictEqual(r.hardReject, true);
        assert.strictEqual(r.primaryIssue, "product_type_conflict");
    });

    // ---------------------------------------------------------------------
    // GPU
    // ---------------------------------------------------------------------
    console.log("\n=== RTX 5070 — full candidate matrix ===");
    const RTX_5070 = { brand: "NVIDIA", model: "RTX 5070", productName: "RTX 5070" };

    await test("GPU: exact match ('RTX 5070') is valid", () => assertValidMatch(RTX_5070, "NVIDIA GeForce RTX 5070", "exact"));
    await test("GPU: wrong variant ('RTX 5070 Ti') is HARD_REJECT (variant_mismatch)", () => {
        assertHardReject(RTX_5070, "NVIDIA GeForce RTX 5070 Ti", "variant_mismatch", "5070 Ti");
    });
    await test("GPU: wrong generation ('RTX 4070') is HARD_REJECT (model_number_mismatch)", () => {
        assertHardReject(RTX_5070, "NVIDIA GeForce RTX 4070", "model_number_mismatch", "4070");
    });
    await test("GPU: cooling fan accessory ('RTX 5070 cooling fan') is HARD_REJECT via Gate 0", () => {
        const r = computeMatchConfidence(RTX_5070, "RTX 5070 Cooling Fan");
        assert.strictEqual(r.hardReject, true);
        assert.strictEqual(r.primaryIssue, "product_type_conflict");
    });
    await test("GPU: motherboard/component ('RTX 5070 motherboard') is HARD_REJECT via Gate 0", () => {
        const r = computeMatchConfidence(RTX_5070, "RTX 5070 Compatible Motherboard Component");
        assert.strictEqual(r.hardReject, true);
    });

    // ---------------------------------------------------------------------
    // PlayStation
    // ---------------------------------------------------------------------
    console.log("\n=== PS5 Pro — full candidate matrix ===");
    const PS5_PRO = { brand: "Sony", model: "PS5 Pro", productName: "PS5 Pro" };

    await test("PlayStation: exact match ('PS5 Pro') is valid", () => assertValidMatch(PS5_PRO, "Sony PS5 Pro Console", "exact"));
    await test("PlayStation: wrong variant ('PS5 Slim') is HARD_REJECT (variant_mismatch)", () => {
        assertHardReject(PS5_PRO, "Sony PS5 Slim", "variant_mismatch", "PS5 Slim");
    });
    await test("PlayStation: base model, no variant ('PS5') is HARD_REJECT (variant_mismatch)", () => {
        assertHardReject(PS5_PRO, "Sony PS5", "variant_mismatch", "PS5 base");
    });
    await test("PlayStation: wrong generation ('PS4 Pro') is HARD_REJECT (generation_mismatch)", () => {
        assertHardReject(PS5_PRO, "Sony PS4 Pro", "generation_mismatch", "PS4 Pro");
    });
    await test("PlayStation: replacement fan ('PS5 replacement fan') is HARD_REJECT via Gate 0", () => {
        const r = computeMatchConfidence(PS5_PRO, "PS5 Pro Replacement Cooling Fan");
        assert.strictEqual(r.hardReject, true);
        assert.strictEqual(r.primaryIssue, "product_type_conflict");
    });

    // ---------------------------------------------------------------------
    // Samsung SSD
    // ---------------------------------------------------------------------
    console.log("\n=== Samsung 990 Pro 2TB — full candidate matrix ===");
    const SSD_990_PRO = { brand: "Samsung", model: "990 Pro", productName: "990 Pro", storage: "2TB" };

    await test("SSD: exact match ('Samsung 990 Pro 2TB') is valid", () => assertValidMatch(SSD_990_PRO, "Samsung 990 Pro SSD 2TB NVMe", "exact"));
    await test("SSD: storage mismatch ('Samsung 990 Pro 4TB') stays a SOFT demotion, not HARD_REJECT", () => {
        const r = computeMatchConfidence(SSD_990_PRO, "Samsung 990 Pro SSD 4TB NVMe");
        assert.strictEqual(r.hardReject, false, "a storage mismatch alone must remain soft, never Gate 1 hard-reject");
        assert.strictEqual(r.primaryIssue, "storage_mismatch");
    });
    await test("SSD: wrong variant ('Samsung 990 EVO') is HARD_REJECT (variant_mismatch)", () => {
        assertHardReject(SSD_990_PRO, "Samsung 990 EVO SSD 2TB", "variant_mismatch", "990 EVO");
    });
    await test("SSD: wrong generation ('Samsung 980 Pro') is HARD_REJECT (model_number_mismatch)", () => {
        assertHardReject(SSD_990_PRO, "Samsung 980 Pro SSD 2TB", "model_number_mismatch", "980 Pro");
    });
    await test("SSD: heatsink accessory ('Samsung 990 Pro heatsink') is HARD_REJECT via Gate 0 — the asymmetric part rule must remain intact", () => {
        const r = computeMatchConfidence(SSD_990_PRO, "Samsung 990 Pro Heatsink Cover 2TB Compatible");
        assert.strictEqual(r.hardReject, true);
        assert.strictEqual(r.primaryIssue, "product_type_conflict");
    });

    // ---------------------------------------------------------------------
    // Gate ordering sanity: Gate 0 must always fire before Gate 1
    // ---------------------------------------------------------------------
    console.log("\n=== Gate ordering: Gate 0 (product type) takes priority over Gate 1 (identity) ===");
    await test("A wrong-generation replacement part is rejected for being a PART, not merely a wrong generation", () => {
        const r = computeMatchConfidence(S26_ULTRA, "Samsung Galaxy S25 Ultra Motherboard PCB Replacement");
        assert.strictEqual(r.hardReject, true);
        assert.strictEqual(r.primaryIssue, "product_type_conflict", "Gate 0 must win even though this candidate would ALSO fail Gate 1");
    });

    console.log("\n=== evaluateVariantIdentity unit tests (direct gate access) ===");
    await test("evaluateVariantIdentity: absence of signal on either side is never treated as a conflict", () => {
        const r = evaluateVariantIdentity({ brand: "Acme", model: "Widget", productName: "Widget" }, "Acme Widget Pro Edition Deluxe");
        // No numeric generation/model-number token on the source side at
        // all, so only the variant-suffix check can fire here — and it
        // correctly does, since "Pro" is a real variant word absent from
        // the request. This asserts the *reason*, not a blanket pass, to
        // prove gate 1 doesn't silently no-op on generic products.
        assert.strictEqual(r.hardReject, true);
        assert.strictEqual(r.primaryIssue, "variant_mismatch");
    });
    await test("evaluateVariantIdentity: truly generic products with no version/variant signal at all pass through", () => {
        const r = evaluateVariantIdentity({ brand: "Acme", model: "Widget", productName: "Widget" }, "Acme Widget Deluxe Edition");
        assert.strictEqual(r.hardReject, false);
    });

    console.log("\n=== SUMMARY ===");
    const passed = results.filter((r) => r.pass).length;
    console.log(`${passed}/${results.length} passed`);
    if (passed !== results.length) process.exitCode = 1;
}

main();
