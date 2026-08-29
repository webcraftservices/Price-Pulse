/**
 * Regression guard: the multi-store dedup bug.
 * ------------------------------------------------------------------
 * Stage 2.1 found that Serper's Google Shopping `link` field is a
 * google.com/search?ibp=oshop redirect for every result — identical
 * across all offers. An earlier version of the dedup key used that
 * hostname first, which collapsed 40 raw results down to 1.
 *
 * This test proves that regression can't silently come back: it feeds
 * the real (unmodified) compareService/googleShopping code 40 fake
 * items — every one with a Google-redirect `link` — cycling through
 * 15 distinct `source` (merchant) values, and asserts the pipeline
 * still recognizes all 15.
 *
 * No network or SERPER_API_KEY needed — axios is stubbed for the
 * duration of this script only (via a `require` patch, not a change
 * to any production file), so this is safe to run anytime, including
 * without an internet connection.
 *
 * USAGE: node scripts/regression-dedup-test.js
 */

const assert = require("assert");
const path = require("path");
const Module = require("module");

// The 15 real store names from the live evidence in the Stage 2.1 report.
const LIVE_EVIDENCE_STORES = [
    "boAt", "bigbasket", "Zepto", "Wholemonkey", "Cashify", "Shopy Vision",
    "Fliptwirls", "Amazon", "Swagilo", "LowestRate Shopping", "Gadgets Now",
    "Giftana India", "Solutions World", "JioMart Grocery", "Bazaar",
];

// 40 fake Serper items, every `link` a Google Shopping redirect (as live
// evidence showed is typical), cycling through the 15 stores above so some
// stores legitimately repeat (dedup should still collapse those, but must
// not collapse DIFFERENT stores together).
const fakeShoppingResults = Array.from({ length: 40 }, (_, i) => ({
    title: "boAt Airdopes 141 Bluetooth Truly Wireless Earbuds",
    source: LIVE_EVIDENCE_STORES[i % LIVE_EVIDENCE_STORES.length],
    link: `https://www.google.com/search?ibp=oshop&q=boat+airdopes+141&item=${i}`,
    price: `₹${(799 + i * 5).toLocaleString("en-IN")}`,
    rating: 4.2,
}));

// Patch `require("axios")` for the lifetime of this process only — no
// production file is modified, and this only affects this standalone script.
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
    if (id === "axios") {
        return { post: async () => ({ data: { shopping: fakeShoppingResults } }), get: async () => ({ data: "" }) };
    }
    if (id === "cheerio") {
        return { load: () => () => ({ attr: () => null, first: () => ({ text: () => "" }) }) };
    }
    return originalRequire.apply(this, arguments);
};

process.env.SERPER_API_KEY = process.env.SERPER_API_KEY || "fake_key_for_regression_test";

const { compareByQuery } = require(path.join(__dirname, "..", "services", "compareService"));

async function main() {
    console.log("Running dedup regression test (40 Google-redirect offers, 15 sources)...\n");

    const result = await compareByQuery("boAt Airdopes 141");
    const uniqueStores = new Set(result.results.map((r) => r.platform));

    console.log("Final offers:", result.results.length);
    console.log("Unique stores in result:", uniqueStores.size, "->", [...uniqueStores].join(", "));

    assert.strictEqual(
        uniqueStores.size,
        LIVE_EVIDENCE_STORES.length,
        `Expected ${LIVE_EVIDENCE_STORES.length} unique merchants, got ${uniqueStores.size}. ` +
            `This means the Google-hostname dedup bug may have regressed — check that ` +
            `compareService.js's dedup key still prioritizes offer.store over offer._hostname.`
    );

    assert.ok(
        uniqueStores.size > 1,
        "Regression: all offers collapsed to a single merchant despite 15 distinct sources."
    );

    console.log("\nPASS: 40 Google-redirect offers with 15 distinct sources correctly yielded 15 unique merchants.");
    process.exitCode = 0;
}

main().catch((err) => {
    console.error("\nFAIL:", err.message);
    process.exitCode = 1;
});
