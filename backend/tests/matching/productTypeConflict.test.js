/**
 * Product-Type Conflict tests (fixes the Cellspare motherboard bug)
 * ------------------------------------------------------------------
 * Root cause: the matcher only scored brand/model/variant TOKEN
 * OVERLAP. "Samsung Galaxy S26 Ultra 256GB 12GB RAM Motherboard PCB"
 * shares nearly every token with the requested phone, so it reached
 * confidence=1.0 despite being a spare part. This suite proves the new
 * comparison/productTypeClassifier.js + productMatcher.js hard-reject
 * gate fixes it — deterministically, with fake Serper data, no network
 * or API key required — and that the fix generalizes across product
 * categories (spec Step 15), not just Samsung phones.
 *
 * USAGE: node tests/matching/productTypeConflict.test.js
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
const { computeMatchConfidence } = require(path.join(__dirname, "..", "..", "services", "productMatcher"));
const { classifyProductType, detectProductTypeConflict } = require(path.join(__dirname, "..", "..", "comparison", "productTypeClassifier"));

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

// ---------------------------------------------------------------------
// Steps 14: the exact reported bug, plus every listed variant
// ---------------------------------------------------------------------

const S26_ULTRA_256 = { brand: "Samsung", model: "Galaxy S26 Ultra", productName: "Galaxy S26 Ultra", storage: "256GB", ram: "12GB" };

async function main() {
    console.log("=== TEST 1: the exact reported bug — Cellspare motherboard/PCB ===");
    await test("TEST 1: Cellspare motherboard is HARD_REJECT, excluded from results, never bestOffer", async () => {
        const r = computeMatchConfidence(S26_ULTRA_256, "Samsung Galaxy S26 Ultra 256GB 12GB RAM Motherboard PCB");
        assert.strictEqual(r.hardReject, true, "must be hard-rejected");
        assert.strictEqual(r.matchDecision, "HARD_REJECT");
        assert.strictEqual(r.confidence, 0, "confidence must be forced to 0, not left at 1.0");

        setFixture([
            { title: "Samsung Galaxy S26 Ultra 256GB 12GB RAM Motherboard PCB", source: "Cellspare", link: "https://cellspare.com/p/x", price: "₹71999" },
            { title: "Samsung Galaxy S26 Ultra 5G", source: "Amazon.in", link: "https://amazon.in/dp/real", price: "₹124999" },
        ]);
        const result = await compareByProduct(S26_ULTRA_256);
        assert.ok(!result.results.some((o) => o.platform === "Cellspare"), "Cellspare must not appear anywhere in results (not confident, not possible)");
        assert.ok(result.bestOffer, "a valid bestOffer must still be found");
        assert.strictEqual(result.bestOffer.platform, "Amazon", "bestOffer must be the real phone, not the motherboard");
        assert.ok(result.savings === 0 || result.savings < 60000, "savings must not be inflated by the excluded ₹71,999 motherboard");
    });

    console.log("\n=== TEST 2/3: legitimate phone listings still match ===");
    await test("TEST 2: 'Samsung Galaxy S26 Ultra 5G' (Amazon, ₹124999) is a valid match", () => {
        const r = computeMatchConfidence(S26_ULTRA_256, "Samsung Galaxy S26 Ultra 5G");
        assert.strictEqual(r.hardReject, false);
        assert.ok(r.confidence >= 0.5, `expected valid match, got ${r.confidence}`);
    });

    await test("TEST 3: full spec listing (Etoren-style, SM-S948B Dual Sim 256GB Pink Gold 12GB RAM) is strong/exact", () => {
        const r = computeMatchConfidence(S26_ULTRA_256, "Samsung Galaxy S26 Ultra 5G SM-S948B Dual Sim 256GB Pink Gold (12GB RAM)");
        assert.strictEqual(r.hardReject, false);
        assert.ok(r.confidence >= 0.75, `expected strong/exact, got ${r.confidence} (${r.matchDecision})`);
    });

    console.log("\n=== TEST 4/5: wrong variant/generation — demoted, not confident (existing behavior preserved) ===");
    await test("TEST 4: 'Samsung Galaxy S26+' is NOT a confident match", () => {
        const r = computeMatchConfidence(S26_ULTRA_256, "Samsung Galaxy S26+");
        assert.ok(r.confidence < 0.5, `expected < 0.5, got ${r.confidence}`);
    });

    await test("TEST 5: 'Samsung Galaxy S25 Ultra 12GB 256GB' does NOT match an S26 Ultra request", () => {
        const r = computeMatchConfidence(S26_ULTRA_256, "Samsung Galaxy S25 Ultra 12GB 256GB");
        assert.ok(r.confidence < 0.5, `expected < 0.5, got ${r.confidence}`);
    });

    console.log("\n=== TEST 6: wrong storage — not exact, but not necessarily hard-rejected ===");
    await test("TEST 6: 'Samsung Galaxy S26 Ultra 512GB 12GB RAM' vs 256GB request is not exact/strong", () => {
        const r = computeMatchConfidence(S26_ULTRA_256, "Samsung Galaxy S26 Ultra 512GB 12GB RAM");
        assert.ok(r.confidence < 0.75, `must not be treated as an exact 256GB offer, got ${r.confidence}`);
        assert.strictEqual(r.hardReject, false, "a storage mismatch alone is not a HARD_REJECT");
    });

    console.log("\n=== TEST 7/8/9: accessories and replacement parts — HARD_REJECT ===");
    await test("TEST 7: 'Samsung Galaxy S26 Ultra Case' is HARD_REJECT", () => {
        const r = computeMatchConfidence(S26_ULTRA_256, "Samsung Galaxy S26 Ultra Case");
        assert.strictEqual(r.hardReject, true);
        assert.strictEqual(r.matchDecision, "HARD_REJECT");
    });

    await test("TEST 8: 'Samsung Galaxy S26 Ultra Screen Protector' is HARD_REJECT", () => {
        const r = computeMatchConfidence(S26_ULTRA_256, "Samsung Galaxy S26 Ultra Screen Protector");
        assert.strictEqual(r.hardReject, true);
    });

    await test("TEST 9: 'Samsung Galaxy S26 Ultra Battery Replacement' is HARD_REJECT", () => {
        const r = computeMatchConfidence(S26_ULTRA_256, "Samsung Galaxy S26 Ultra Battery Replacement");
        assert.strictEqual(r.hardReject, true);
    });

    console.log("\n=== TEST 10: a plain, unadorned listing with no contradictory variant is a valid candidate ===");
    await test("TEST 10: 'Samsung Galaxy S26 Ultra' (₹119999) is not hard-rejected", () => {
        const r = computeMatchConfidence(S26_ULTRA_256, "Samsung Galaxy S26 Ultra");
        assert.strictEqual(r.hardReject, false);
    });

    // ---------------------------------------------------------------------
    // Step 15: other product categories — proves this is general, not a
    // Samsung-specific patch. Each includes one accessory/component false
    // positive that must never become the main product match.
    // ---------------------------------------------------------------------

    console.log("\n=== Step 15: other product categories ===");

    await test("iPhone 17 Pro 256GB: 'iPhone 17 Pro case' is HARD_REJECT", () => {
        const r = computeMatchConfidence({ brand: "Apple", model: "iPhone 17 Pro", productName: "iPhone 17 Pro", storage: "256GB" }, "iPhone 17 Pro case");
        assert.strictEqual(r.hardReject, true);
    });
    await test("iPhone 17 Pro 256GB: 'Apple iPhone 17 Pro 256GB' is a valid match", () => {
        const r = computeMatchConfidence({ brand: "Apple", model: "iPhone 17 Pro", productName: "iPhone 17 Pro", storage: "256GB" }, "Apple iPhone 17 Pro 256GB");
        assert.ok(r.confidence >= 0.5 && !r.hardReject);
    });

    await test("MacBook Air M4 16GB/512GB: 'MacBook Air replacement battery' is HARD_REJECT", () => {
        const r = computeMatchConfidence({ brand: "Apple", model: "MacBook Air M4", productName: "MacBook Air M4", storage: "512GB", ram: "16GB" }, "MacBook Air replacement battery");
        assert.strictEqual(r.hardReject, true);
    });
    await test("MacBook Air M4 16GB/512GB: 'Apple MacBook Air M4 16GB 512GB' is a valid match", () => {
        const r = computeMatchConfidence({ brand: "Apple", model: "MacBook Air M4", productName: "MacBook Air M4", storage: "512GB", ram: "16GB" }, "Apple MacBook Air M4 16GB 512GB");
        assert.ok(r.confidence >= 0.5 && !r.hardReject);
    });

    await test("Sony WH-1000XM6: 'replacement ear pads for WH-1000XM6' is HARD_REJECT", () => {
        const r = computeMatchConfidence({ brand: "Sony", model: "WH-1000XM6", productName: "WH-1000XM6" }, "Replacement Ear Pads for Sony WH-1000XM6");
        assert.strictEqual(r.hardReject, true);
    });
    await test("Sony WH-1000XM6: 'Sony WH-1000XM6 Wireless Noise Cancelling Headphones' is a valid match", () => {
        const r = computeMatchConfidence({ brand: "Sony", model: "WH-1000XM6", productName: "WH-1000XM6" }, "Sony WH-1000XM6 Wireless Noise Cancelling Headphones");
        assert.ok(r.confidence >= 0.5 && !r.hardReject);
    });

    await test("PlayStation 5: 'PS5 DualSense Controller' is HARD_REJECT", () => {
        const r = computeMatchConfidence({ brand: "Sony", model: "PlayStation 5", productName: "PlayStation 5" }, "PS5 DualSense Wireless Controller");
        assert.strictEqual(r.hardReject, true);
    });
    await test("PlayStation 5: 'Sony PlayStation 5 Console' is a valid match", () => {
        const r = computeMatchConfidence({ brand: "Sony", model: "PlayStation 5", productName: "PlayStation 5" }, "Sony PlayStation 5 Console");
        assert.ok(r.confidence >= 0.5 && !r.hardReject);
    });

    await test("RTX 5070: 'RTX 5070 water block' is HARD_REJECT", () => {
        const r = computeMatchConfidence({ brand: "NVIDIA", model: "RTX 5070", productName: "RTX 5070" }, "RTX 5070 GPU Water Block");
        assert.strictEqual(r.hardReject, true);
    });
    await test("RTX 5070: 'NVIDIA GeForce RTX 5070 Graphics Card' is a valid match", () => {
        const r = computeMatchConfidence({ brand: "NVIDIA", model: "RTX 5070", productName: "RTX 5070" }, "NVIDIA GeForce RTX 5070 Graphics Card");
        assert.ok(r.confidence >= 0.5 && !r.hardReject);
    });

    await test("Samsung 990 Pro 2TB: 'Samsung 990 Pro heatsink' is HARD_REJECT (no literal 'ssd' keyword in either title)", () => {
        const r = computeMatchConfidence({ brand: "Samsung", model: "990 Pro", productName: "990 Pro", storage: "2TB" }, "Samsung 990 Pro Heatsink Cover 2TB Compatible");
        assert.strictEqual(r.hardReject, true, "must reject even though requestedType could not be confidently classified as a main category");
    });
    await test("Samsung 990 Pro 2TB: 'Samsung 990 Pro SSD 2TB NVMe' is a valid match", () => {
        const r = computeMatchConfidence({ brand: "Samsung", model: "990 Pro", productName: "990 Pro", storage: "2TB" }, "Samsung 990 Pro SSD 2TB NVMe");
        assert.ok(r.confidence >= 0.5 && !r.hardReject);
    });

    // ---------------------------------------------------------------------
    // Positive-signal asymmetry (spec Step 4): searching for the part
    // itself must not be rejected.
    // ---------------------------------------------------------------------

    console.log("\n=== Positive-signal asymmetry: requesting the part itself is not rejected ===");
    await test("Requesting 'Samsung Galaxy S26 Ultra Motherboard' matches a motherboard listing", () => {
        const r = computeMatchConfidence({ name: "Samsung Galaxy S26 Ultra Motherboard", brand: "Samsung", productName: "Galaxy S26 Ultra Motherboard" }, "Samsung Galaxy S26 Ultra Motherboard PCB Replacement");
        assert.strictEqual(r.hardReject, false, "requesting the part itself must not be rejected");
    });

    // ---------------------------------------------------------------------
    // Classifier unit tests
    // ---------------------------------------------------------------------

    console.log("\n=== classifyProductType / detectProductTypeConflict unit tests ===");
    await test("classifyProductType: unknown vs unknown never conflicts (spec Step 3 — absence of signal is not rejection)", () => {
        const a = classifyProductType("Some Obscure Gadget XJ200");
        const b = classifyProductType("Some Obscure Gadget XJ200 Pro");
        const { conflict } = detectProductTypeConflict(a, b);
        assert.strictEqual(conflict, false);
    });

    await test("classifyProductType: main-category vs main-category conflict (smartphone vs tablet)", () => {
        const requested = classifyProductType("Samsung Galaxy S26 Ultra Smartphone");
        const candidate = classifyProductType("Samsung Galaxy Tab S10 Tablet");
        const { conflict } = detectProductTypeConflict(requested, candidate);
        assert.strictEqual(conflict, true);
    });

    // ---------------------------------------------------------------------
    // Live-validation follow-up: expanded part-phrase coverage (word-order
    // variants + additional phrases named explicitly in the follow-up
    // request), and the "display" ambiguity called out in point 11.
    // ---------------------------------------------------------------------

    console.log("\n=== Expanded part-phrase coverage (word-order variants + new phrases) ===");
    const EXTRA_PART_TITLES = [
        "Samsung Galaxy S26 Ultra Replacement Screen",       // reversed word order
        "Samsung Galaxy S26 Ultra Replacement Display",      // reversed word order
        "Samsung Galaxy S26 Ultra Charging Board",
        "Samsung Galaxy S26 Ultra Camera Module",
        "Samsung Galaxy S26 Ultra Housing Replacement Body", // housing/body replacement
        "Samsung Galaxy S26 Ultra Spare Part",
        "Samsung Galaxy S26 Ultra Replacement Part",
        "Samsung Galaxy S26 Ultra Internal Component",
        "Samsung Galaxy S26 Ultra Repair Component",
        "Samsung Galaxy S26 Ultra Flex Cable",
        "Samsung Galaxy S26 Ultra Charging Connector",
        "Samsung Galaxy S26 Ultra Cooling Accessory Heatsink",
        "Samsung Galaxy S26 Ultra Replacement Shell",
    ];
    for (const title of EXTRA_PART_TITLES) {
        await test(`Expanded coverage: "${title}" is HARD_REJECT`, () => {
            const r = computeMatchConfidence(S26_ULTRA_256, title);
            assert.strictEqual(r.hardReject, true, `expected HARD_REJECT, got matchDecision=${r.matchDecision}`);
        });
    }

    console.log("\n=== Point 11: 'display' ambiguity — spec vs. replacement part ===");
    await test("'Samsung Galaxy S26 Ultra 6.9 inch Display 5G' (spec mention) is NOT hard-rejected", () => {
        const r = computeMatchConfidence(S26_ULTRA_256, "Samsung Galaxy S26 Ultra 5G 6.9 inch Display 256GB");
        assert.strictEqual(r.hardReject, false, "a bare spec mention of 'display' must not be treated as a replacement part");
    });
    await test("'Samsung Galaxy S26 Ultra Display Replacement' IS hard-rejected", () => {
        const r = computeMatchConfidence(S26_ULTRA_256, "Samsung Galaxy S26 Ultra Display Replacement");
        assert.strictEqual(r.hardReject, true);
    });
    await test("'Samsung Galaxy S26 Ultra Replacement Display' (reversed order) IS hard-rejected", () => {
        const r = computeMatchConfidence(S26_ULTRA_256, "Samsung Galaxy S26 Ultra Replacement Display Assembly");
        assert.strictEqual(r.hardReject, true);
    });

    console.log("\n=== Point 16: additional categories x2 (legitimate + false positive) ===");
    const CATEGORY_CASES = [
        {
            name: "MacBook Air M4 16GB 256GB",
            source: { brand: "Apple", model: "MacBook Air M4", productName: "MacBook Air M4", storage: "256GB", ram: "16GB" },
            good: "Apple MacBook Air M4 16GB 256GB Laptop",
            bad: "MacBook Air M4 Replacement Battery",
        },
        {
            name: "Sony WH-1000XM6",
            source: { brand: "Sony", model: "WH-1000XM6", productName: "WH-1000XM6" },
            good: "Sony WH-1000XM6 Wireless Noise Cancelling Headphones",
            bad: "Sony WH-1000XM6 Replacement Ear Pads Cushions",
        },
        {
            name: "PlayStation 5",
            source: { brand: "Sony", model: "PlayStation 5", productName: "PlayStation 5" },
            good: "Sony PlayStation 5 Console 1TB",
            bad: "PlayStation 5 Docking Station Charging Dock",
        },
        {
            name: "RTX 5090",
            source: { brand: "NVIDIA", model: "RTX 5090", productName: "RTX 5090" },
            good: "NVIDIA GeForce RTX 5090 Graphics Card 32GB",
            bad: "RTX 5090 Cooling Accessory Heatsink Water Block",
        },
        {
            name: "Samsung 990 Pro 2TB",
            source: { brand: "Samsung", model: "990 Pro", productName: "990 Pro", storage: "2TB" },
            good: "Samsung 990 Pro SSD 2TB NVMe M.2",
            bad: "Samsung 990 Pro Heatsink Cooling Accessory 2TB Compatible",
        },
    ];
    for (const c of CATEGORY_CASES) {
        await test(`${c.name}: legitimate listing is a valid match`, () => {
            const r = computeMatchConfidence(c.source, c.good);
            assert.strictEqual(r.hardReject, false, `unexpected hardReject for "${c.good}"`);
        });
        await test(`${c.name}: accessory/component false positive is HARD_REJECT`, () => {
            const r = computeMatchConfidence(c.source, c.bad);
            assert.strictEqual(r.hardReject, true, `expected HARD_REJECT for "${c.bad}"`);
        });
    }

    console.log("\n=== SUMMARY ===");
    const passed = results.filter((r) => r.pass).length;
    console.log(`${passed}/${results.length} passed`);
    if (passed !== results.length) process.exitCode = 1;
}

main();
