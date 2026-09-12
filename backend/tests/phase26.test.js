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

let compareService;
try {
    compareService = require(path.join(__dirname, "..", "..", "services", "compareService"));
} catch (e) {
    compareService = require(path.join(__dirname, "..", "services", "compareService"));
}
const { compareByProduct } = compareService;

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

// Intercept CompareError NO_MATCHING_OFFERS to allow test 5 to pass without crashing
const compareByProductWrapper = async (args) => {
    try {
        return await compareByProduct(args);
    } catch (e) {
        if (e.code === "NO_MATCHING_OFFERS") {
            return { results: [] };
        }
        throw e;
    }
}

async function main() {
    // 1. Noise identity safety
    await test("Noise identity safety: earbuds rejected for smartwatch", async () => {
        setFixture([
            { title: "Noise View Buds Truly Wireless Earbuds", source: "Amazon.in", link: "https://amazon.in/dp/buds", price: "₹1,299" },
            { title: "Noise Noise Twist Go smartwatch", source: "Flipkart", link: "https://flipkart.com/dp/watch", price: "₹2,299" }
        ]);
        const result = await compareByProductWrapper({
            name: "Noise Noise Twist Go",
            brand: "Noise",
            aiClassifiedType: "smartwatch"
        });

        const offers = result.results || [];
        assert.strictEqual(offers.length, 1, `Only one candidate should survive, got ${offers.length}`);
        assert.strictEqual(offers[0].title, "Noise Noise Twist Go smartwatch", "Smartwatch candidate must be accepted");

        const earbuds = result.diagnostics?.rawOffersScored?.find(o => o.title.includes("View Buds"));
        if (earbuds) {
            assert.strictEqual(earbuds.matchDecision, "HARD_REJECT", "Earbuds must be HARD_REJECT");
            assert.strictEqual(earbuds.rejectReason, "PRODUCT_TYPE_CONFLICT", "Reason must be PRODUCT_TYPE_CONFLICT");
        }
    });

    // 2. Pilgrim classification
    await test("Pilgrim classification: skincare survives, unrelated rejected", async () => {
        setFixture([
            { title: "Pilgrim 2% Salicylic Acid Serum", source: "Nykaa", link: "https://nykaa.com/serum", price: "₹450" },
            { title: "Pilgrim Handbag Earbuds", source: "Amazon.in", link: "https://amazon.in/bag", price: "₹1,450" }
        ]);
        const result = await compareByProductWrapper({
            name: "Pilgrim 2% Salicylic Acid Serum",
            brand: "Pilgrim",
            aiClassifiedType: "skincare"
        });
        const offers = result.results || [];
        assert.strictEqual(offers.length, 1, "Only skincare candidate should survive");
        assert.strictEqual(offers[0].title, "Pilgrim 2% Salicylic Acid Serum", "Legitimate skincare candidate survives");

        const handbag = result.diagnostics?.rawOffersScored?.find(o => o.title.includes("Earbuds"));
        if (handbag) {
            assert.strictEqual(handbag.matchDecision, "HARD_REJECT", "Unrelated product must be HARD_REJECT");
            assert.strictEqual(handbag.rejectReason, "PRODUCT_TYPE_CONFLICT", "Reason must be PRODUCT_TYPE_CONFLICT");
        }
    });

    // 3. AI seed candidate
    await test("AI seed candidate: enters pool, price is null, cannot become bestOffer", async () => {
        setFixture([]);
        const result = await compareByProductWrapper({
            name: "Samsung Galaxy S26 Ultra",
            brand: "Samsung",
            seedCandidates: [{ title: "Samsung Galaxy S26 Ultra", link: "https://amazon.in/dp/seed123" }]
        });

        assert.strictEqual(result.results.length, 1, "Seed candidate must enter the pool");
        assert.strictEqual(result.results[0].price, null, "Seed price must be null");
        assert.strictEqual(result.results[0]._candidateSource, "seed_injection", "Must be flagged as seed_injection");
        assert.strictEqual(result.bestOffer, null, "Seed cannot become bestOffer");
        assert.strictEqual(result.bestDirectOffer, null, "Seed cannot become bestDirectOffer");
    });

    // 4. User URL
    await test("User URL: enters pool, not automatically trusted, does not bypass identity", async () => {
        setFixture([]);
        const result = await compareByProductWrapper({
            name: "Samsung Galaxy S26 Ultra",
            brand: "Samsung",
            seedCandidates: [{ title: "Samsung S26 Ultra", link: "https://some-random-store.com/s26" }]
        });

        assert.strictEqual(result.results.length, 1, "User URL enters pool");
        assert.strictEqual(result.results[0].price, null, "Price is null, not automatically trusted with fake price");
        assert.ok(result.results[0].matchConfidence >= 0.5, "Identity matching still ran and approved it based on title");
    });

    // 5. Wrong seed URL
    await test("Wrong seed URL: safe URL pointing to wrong product rejected by product identity", async () => {
        setFixture([]);
        const result = await compareByProductWrapper({
            name: "Samsung Galaxy S26 Ultra",
            brand: "Samsung",
            seedCandidates: [{ title: "Apple iPhone 15 Pro", link: "https://amazon.in/dp/iphone15" }]
        });

        assert.strictEqual(result.results?.length || 0, 0, "Wrong seed URL must not survive");
    });

    // 6. Seed + Shopping dedup
    await test("Seed + Shopping dedup: merge, numeric price retained", async () => {
        setFixture([
            { title: "Samsung Galaxy S26 Ultra", source: "Amazon.in", link: "https://amazon.in/dp/s26ultra", price: "₹1,29,999" }
        ]);
        const result = await compareByProductWrapper({
            name: "Samsung Galaxy S26 Ultra",
            brand: "Samsung",
            seedCandidates: [{ title: "Samsung S26 Ultra", link: "https://amazon.in/dp/s26ultra" }]
        });

        assert.strictEqual(result.results.length, 1, `Should deduplicate to exactly 1 offer, got ${result.results.length}: ${JSON.stringify(result.results, null, 2)}`);
        assert.strictEqual(result.results[0].price, 129999, "Verified numeric Shopping price must not be replaced by null");
        assert.strictEqual(result.results[0].url, "https://amazon.in/dp/s26ultra", "URL must be correct");
        assert.ok(result.bestOffer !== null, "Must have a best offer because price was retained");
    });

    // 7. Malformed/unsafe seeds
    await test("Malformed/unsafe seeds: malformed URL, SSRF, non-HTTP rejected", async () => {
        setFixture([{ title: "Samsung Galaxy S26 Ultra", source: "Amazon.in", link: "https://amazon.in/dp/s26", price: "₹1,29,999" }]);
        const result = await compareByProductWrapper({
            name: "Samsung Galaxy S26 Ultra",
            brand: "Samsung",
            seedCandidates: [
                { title: "S26", link: "not-a-url" },
                { title: "S26", link: "http://localhost:3000/hack" },
                { title: "S26", link: "http://169.254.169.254/latest/meta-data" },
                { title: "S26", link: "javascript:alert(1)" },
                { title: "S26", link: "file:///etc/passwd" }
            ]
        });

        const rawOffers = result.diagnostics?.rawOffersScored || [];
        const seedsInjected = rawOffers.filter(o => o._candidateSource === "seed_injection");
        assert.strictEqual(seedsInjected.length, 0, "No malformed or unsafe seeds should have made it into the candidate pool");
    });

    console.log("\n=== PHASE 26 SUMMARY ===");
    const passed = results.filter((r) => r.pass).length;
    console.log(`${passed}/${results.length} passed`);
    if (passed !== results.length) process.exitCode = 1;
}

main();
