const assert = require("assert");
const { isEligibleForComparison } = require("../../comparison/offerEligibility");
const { injectSeedCandidates } = require("../../comparison/seedCandidateInjector");

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
    console.log("=== Phase 31.1 - Non-Commerce bestOffer Defect Fix ===");

    const createMockOffer = (overrides = {}) => ({
        hardReject: false,
        matchConfidence: 1.0,
        price: 1400,
        availability: "in_stock",
        productUrl: "https://example.com/product",
        usableForBestOffer: true,
        ...overrides
    });

    await test("1. Correct product + YouTube/social candidate + numeric price -> must NOT be eligible for bestOffer", () => {
        const offer = createMockOffer({ productUrl: "https://youtube.com/watch?v=123" });
        assert.strictEqual(isEligibleForComparison(offer), false);
    });

    await test("2. Correct product + legitimate unknown commercial seller + numeric price -> must remain eligible if all other existing rules pass", () => {
        const offer = createMockOffer({ productUrl: "https://unknown-legit-store.com/product" });
        assert.strictEqual(isEligibleForComparison(offer), true);
    });

    await test("3. Correct product + existing trusted retailer -> remains eligible", () => {
        const offer = createMockOffer({ productUrl: "https://amazon.in/product" });
        assert.strictEqual(isEligibleForComparison(offer), true);
    });

    await test("4. Existing Noise Twist Go correct commercial offer -> remains eligible", () => {
        const offer = createMockOffer({ productUrl: "https://flipkart.com/noise-twist-go" });
        assert.strictEqual(isEligibleForComparison(offer), true);
    });

    await test("5. Existing Phase 30 rental protection -> remains intact (requires usableForBestOffer = false)", () => {
        const offer = createMockOffer({ productUrl: "https://amazon.in/product", usableForBestOffer: false });
        assert.strictEqual(isEligibleForComparison(offer), false);
    });

    await test("6. Existing Phase 27 seed filtering -> remains intact", () => {
        const seeds = [
            { url: "https://youtube.com/watch?v=456", title: "Review" },
            { url: "https://legit-store.com/item", title: "Item" }
        ];
        const injected = injectSeedCandidates(seeds);
        assert.strictEqual(injected.length, 1);
        assert.strictEqual(injected[0].productUrl, "https://legit-store.com/item");
    });

    await test("7. Wrong product from a social/non-commerce source -> remains rejected by identity as before (hardReject = true)", () => {
        const offer = createMockOffer({ productUrl: "https://youtube.com/watch?v=123", hardReject: true });
        assert.strictEqual(isEligibleForComparison(offer), false);
    });

    console.log("\n=== SUMMARY ===");
    const passed = results.filter((r) => r.pass).length;
    console.log(`${passed}/${results.length} passed`);
    if (passed !== results.length) process.exitCode = 1;
}

main();
