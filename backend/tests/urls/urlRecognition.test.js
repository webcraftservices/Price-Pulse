/**
 * Phase 5 — URL recognition & input-handling tests
 * ------------------------------------------------------------------
 * Fills gaps in the spec's 20-point test list not covered by
 * scripts/regression-tests.js: Amazon short-URL recognition
 * (amzn.in/amzn.to), invalid URL rejection, empty search rejection,
 * and missing-field (price/rating/stock) honesty (never fabricated).
 *
 * USAGE: node tests/urls/urlRecognition.test.js
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

const { compareProduct, compareByQuery, compareByProduct } = require(path.join(__dirname, "..", "..", "services", "compareService"));
const { isGoogleHost, hasSafeProtocol, belongsToDomain } = require(path.join(__dirname, "..", "..", "utils", "url"));

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

async function assertRejects(promise, statusCode, code) {
    try {
        await promise;
        throw new Error("expected rejection, but it resolved");
    } catch (err) {
        if (err.message === "expected rejection, but it resolved") throw err;
        if (statusCode) assert.strictEqual(err.statusCode, statusCode, `expected statusCode ${statusCode}, got ${err.statusCode}`);
        if (code) assert.strictEqual(err.code, code, `expected code ${code}, got ${err.code}`);
    }
}

async function main() {
    // --- URL type recognition (utils/url.js) ---

    await test("isGoogleHost: recognizes google.com and every country-TLD as Google", () => {
        assert.strictEqual(isGoogleHost("https://www.google.com/search?ibp=oshop"), true);
        assert.strictEqual(isGoogleHost("https://www.google.co.in/search?ibp=oshop"), true);
        assert.strictEqual(isGoogleHost("https://www.google.co.uk/search?ibp=oshop"), true);
    });

    await test("isGoogleHost: Amazon short URLs (amzn.in, amzn.to) are NOT Google — recognized as legitimate merchant URLs", () => {
        assert.strictEqual(isGoogleHost("https://amzn.in/d/abc123"), false);
        assert.strictEqual(isGoogleHost("https://amzn.to/3xYzABC"), false);
    });

    await test("isGoogleHost: full Amazon/Flipkart domains are NOT Google", () => {
        assert.strictEqual(isGoogleHost("https://www.amazon.in/dp/B0ABCDEF"), false);
        assert.strictEqual(isGoogleHost("https://www.flipkart.com/product/p/itm123"), false);
    });

    await test("hasSafeProtocol: only http/https accepted, javascript:/file:/data: rejected", () => {
        assert.strictEqual(hasSafeProtocol("https://amazon.in/dp/x"), true);
        assert.strictEqual(hasSafeProtocol("http://amazon.in/dp/x"), true);
        assert.strictEqual(hasSafeProtocol("javascript:alert(1)"), false);
        assert.strictEqual(hasSafeProtocol("file:///etc/passwd"), false);
        assert.strictEqual(hasSafeProtocol("data:text/html,<script>1</script>"), false);
    });

    await test("belongsToDomain: exact and subdomain match accepted, lookalike domain rejected", () => {
        assert.strictEqual(belongsToDomain("https://www.amazon.in/dp/x", "amazon.in"), true);
        assert.strictEqual(belongsToDomain("https://amazon.in/dp/x", "amazon.in"), true);
        assert.strictEqual(belongsToDomain("https://amazon.in.evil.com/dp/x", "amazon.in"), false);
        assert.strictEqual(belongsToDomain("https://myamazonfake.com/dp/x", "amazon.in"), false);
    });

    // --- Short-URL offers flow straight through the extractor as valid, non-redirect merchant URLs ---

    await test("Offer extraction: an amzn.to short URL from Serper is preserved as a direct (non-redirect) merchant URL", async () => {
        setFixture([{ title: "boAt Airdopes 141 Bluetooth Earbuds", source: "Amazon.in", link: "https://amzn.to/3xYzABC", price: "₹799" }]);
        const result = await compareByProduct({ name: "boAt Airdopes 141", brand: "boAt", productName: "Airdopes 141" });
        assert.strictEqual(result.results.length, 1);
        assert.strictEqual(result.results[0].isGoogleRedirect, false);
        assert.strictEqual(result.results[0].isDirectMerchantUrl, true);
        assert.strictEqual(result.results[0].url, "https://amzn.to/3xYzABC");
    });

    // --- Input validation ---

    await test("Invalid URL input: compareProduct rejects malformed URL with INVALID_INPUT, 400", async () => {
        await assertRejects(compareProduct("not a url at all"), 400, "INVALID_INPUT");
    });

    await test("Empty search input: compareByQuery rejects blank/whitespace-only query with INVALID_INPUT, 400", async () => {
        await assertRejects(compareByQuery(""), 400, "INVALID_INPUT");
        await assertRejects(compareByQuery("   "), 400, "INVALID_INPUT");
    });

    await test("Empty product input: compareByProduct rejects an object with no identity fields", async () => {
        await assertRejects(compareByProduct({}), 400, "INVALID_INPUT");
        await assertRejects(compareByProduct(null), 400, "INVALID_INPUT");
    });

    // --- Never fabricate missing fields ---

    await test("Missing price/rating/stock: never fabricated — all stay null, not guessed", async () => {
        setFixture([{ title: "Samsung Galaxy S26 Ultra 256GB Titanium Black", source: "Amazon.in", link: "https://amazon.in/dp/aaa" /* no price, no rating, no availability */ }]);
        const result = await compareByProduct({ name: "Samsung Galaxy S26 Ultra", brand: "Samsung", productName: "Galaxy S26 Ultra", storage: "256gb", color: "Titanium Black" });
        assert.strictEqual(result.results.length, 1);
        const offer = result.results[0];
        assert.strictEqual(offer.price, null, "price must be null, not fabricated");
        assert.strictEqual(offer.rating, null, "rating must be null, not fabricated");
        assert.strictEqual(offer.availability, null, "availability must be null (unknown), not assumed in_stock");
        // An unpriced offer can never be crowned bestOffer, even alone.
        assert.strictEqual(result.bestOffer, null);
    });

    // --- Different product family must never match ---

    await test("Different product family: Sony WH-1000XM5 request never matches a WH-1000XM4 listing", async () => {
        setFixture([{ title: "Sony WH-1000XM4 Wireless Noise Cancelling Headphones", source: "Amazon.in", link: "https://amazon.in/dp/xm4", price: "₹24,990" }]);
        const result = await compareByProduct({ name: "Sony WH-1000XM5", brand: "Sony", productName: "WH-1000XM5", model: "WH-1000XM5" });
        assert.strictEqual(result.bestOffer, null, "XM4 must never be crowned best offer for an XM5 request");
        const offer = result.results.find((o) => o.platform === "Amazon");
        assert.ok(offer.isPossibleMatch || offer.matchConfidence < 0.5, "XM4 vs XM5 should be a low-confidence/possible match, not confident");
    });

    console.log("\n=== SUMMARY ===");
    const passed = results.filter((r) => r.pass).length;
    console.log(`${passed}/${results.length} passed`);
    if (passed !== results.length) process.exitCode = 1;
}

main();
