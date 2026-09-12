const assert = require("assert");
const { evaluateOfferQuality } = require("../../comparison/offerQuality");
const { isEligibleForComparison } = require("../../comparison/offerEligibility");
const { canonicalizeProduct } = require("../../comparison/productIdentity");
const { evaluateVariantIdentity } = require("../../services/productMatcher");

const results = [];
async function test(name, fn) {
    try {
        await fn();
        results.push({ name, pass: true });
        console.log(`PASS  ${name}`);
    } catch (err) {
        results.push({ name, pass: false, error: err.message });
        console.log(`FAIL  ${name}`);
        console.log(`      ${err.stack || err.message}`);
    }
}

async function main() {
    console.log("\n=== Phase 30 - Offer Quality Safety Audit ===");

    const standardCluster = [
        { price: 120000 },
        { price: 122000 },
        { price: 125000 },
        { price: 130000 }
    ];

    const sourceProduct = canonicalizeProduct({
        brand: "Apple",
        model: "iPhone 17 Pro",
        name: "Apple iPhone 17 Pro"
    });

    await test("1. normal new product offer", async () => {
        const offer = { title: "Apple iPhone 17 Pro 256GB", price: 122990 };
        const quality = evaluateOfferQuality(offer, standardCluster);
        assert.strictEqual(quality.status, "trusted");
        assert.strictEqual(quality.usableForBestOffer, true);
    });

    await test("2. used/pre-owned", async () => {
        const offer = { title: "iPhone 17 Pro 256GB Pre-owned", price: 122990 };
        const quality = evaluateOfferQuality(offer, standardCluster);
        assert.strictEqual(quality.status, "suspicious");
        assert.ok(quality.reasons.includes("used_or_refurbished"));
        assert.strictEqual(quality.usableForBestOffer, false);
    });

    await test("3. refurbished", async () => {
        const offer = { title: "Apple iPhone 17 Pro Refurbished", price: 90000 };
        const quality = evaluateOfferQuality(offer, standardCluster);
        assert.strictEqual(quality.status, "suspicious");
        assert.ok(quality.reasons.includes("used_or_refurbished"));
        assert.strictEqual(quality.usableForBestOffer, false);
    });

    await test("4. rental", async () => {
        const offer = { title: "Apple iPhone 17 Pro Rental", price: 100000 };
        const quality = evaluateOfferQuality(offer, standardCluster);
        assert.strictEqual(quality.status, "suspicious");
        assert.ok(quality.reasons.includes("rental_or_service"));
        assert.strictEqual(quality.usableForBestOffer, false);
    });

    await test("5. malformed title", async () => {
        const offer = { title: "&&& && ( ) ) -", price: 120000 };
        const quality = evaluateOfferQuality(offer, standardCluster);
        assert.strictEqual(quality.status, "suspicious");
        assert.ok(quality.reasons.includes("malformed_title"));
        assert.strictEqual(quality.usableForBestOffer, false);
    });

    await test("6. extreme low price", async () => {
        const offer = { title: "Apple iPhone 17 Pro 256GB", price: 600 };
        const quality = evaluateOfferQuality(offer, standardCluster);
        assert.strictEqual(quality.status, "suspicious");
        assert.ok(quality.reasons.includes("extreme_price_outlier"));
        assert.strictEqual(quality.usableForBestOffer, false);
    });

    await test("7. legitimate low price", async () => {
        const offer = { title: "Apple iPhone 17 Pro 256GB", price: 85000 };
        const quality = evaluateOfferQuality(offer, standardCluster);
        assert.strictEqual(quality.status, "trusted");
        assert.strictEqual(quality.usableForBestOffer, true);
    });

    await test("8. trusted retailer + bad commercial offer", async () => {
        const offer = {
            title: "Apple iPhone 17 Pro Refurbished",
            price: 90000,
            hardReject: false,
            matchConfidence: 1.0,
            availability: "in_stock",
            productUrl: "https://amazon.in/dp/123"
        };
        const quality = evaluateOfferQuality(offer, standardCluster);
        offer.usableForBestOffer = quality.usableForBestOffer;
        
        assert.strictEqual(quality.status, "suspicious");
        assert.strictEqual(quality.usableForBestOffer, false);
        assert.strictEqual(isEligibleForComparison(offer), false);
    });

    await test("9. correct identity + bad offer quality", async () => {
        const offer = {
            title: "Apple Rent iPhone 17 Pro",
            price: 600,
            hardReject: false,
            matchConfidence: 1.0,
            availability: "in_stock",
            productUrl: "https://rentals.com/1"
        };
        
        const identity = evaluateVariantIdentity(sourceProduct, offer.title);
        assert.strictEqual(identity.hardReject, false);

        const quality = evaluateOfferQuality(offer, standardCluster);
        offer.usableForBestOffer = quality.usableForBestOffer;
        assert.strictEqual(quality.status, "suspicious");
        assert.strictEqual(isEligibleForComparison(offer), false);
    });

    await test("10. wrong identity + apparently good offer", async () => {
        const offer = {
            title: "Apple iPhone 16 Pro",
            price: 122990,
            hardReject: true,
            matchConfidence: 0.0,
            availability: "in_stock",
            productUrl: "https://store.com/1"
        };
        
        const identity = evaluateVariantIdentity(sourceProduct, offer.title);
        assert.strictEqual(identity.hardReject, true);

        const quality = evaluateOfferQuality(offer, standardCluster);
        offer.usableForBestOffer = quality.usableForBestOffer;
        
        assert.strictEqual(isEligibleForComparison(offer), false);
    });

    console.log("\n=== PHASE 30 SUMMARY ===");
    const passed = results.filter((r) => r.pass).length;
    console.log(`${passed}/${results.length} passed`);
    if (passed !== results.length) process.exitCode = 1;
}

main();
