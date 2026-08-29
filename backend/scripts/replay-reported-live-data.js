/**
 * Replay of user-reported live data
 * ------------------------------------------------------------------
 * NOT a live Serper call. This sandbox has no SERPER_API_KEY / .env
 * (confirmed by actually attempting `run-live-tests.js`, which threw
 * "Couldn't reach the price comparison service" — see the accompanying
 * report). This script instead replays the EXACT merchant names,
 * titles, and prices the user already reported from their OWN real
 * live run against the real, completely unmodified compareService.js
 * (no test doubles of the matching/ranking logic — only the HTTP layer
 * is stubbed, exactly like scripts/regression-tests.js does).
 *
 * USAGE: node scripts/replay-reported-live-data.js
 */

const Module = require("module");
const path = require("path");

const REPORTED_SHOPPING_RESULTS = [
    // The false positive at the center of the bug report.
    { title: "Samsung Galaxy S26 Ultra 256GB 12GB RAM Motherboard PCB", source: "Cellspare", link: "https://www.google.com/search?ibp=oshop&q=x&item=cellspare", price: "₹71,999" },
    // Legitimate listings the user quoted from their own live output.
    { title: "Samsung Galaxy S26 Ultra 5G", source: "Amazon.in", link: "https://www.google.com/search?ibp=oshop&q=x&item=amazon", price: "₹124999" },
    { title: "Samsung Galaxy S26 Ultra 5G SM-S948B Dual Sim 256GB Pink Gold (12GB RAM)", source: "Etoren", link: "https://www.google.com/search?ibp=oshop&q=x&item=etoren", price: "₹164075.98" },
    { title: "SAMSUNG GALAXY S26 ULTRA 12/256", source: "Ganesh Mobile Galaxy", link: "https://www.google.com/search?ibp=oshop&q=x&item=ganesh", price: "₹139999" },
];

const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
    if (id === "axios") {
        return {
            post: async (url) => {
                if (typeof url === "string" && url.includes("/shopping")) return { data: { shopping: REPORTED_SHOPPING_RESULTS } };
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

process.env.SERPER_API_KEY = "replay_harness_key"; // never a real key — HTTP layer is stubbed above
delete process.env.COMPARISON_ENGINE_V2;

const { compareByQuery } = require(path.join(__dirname, "..", "services", "compareService"));

async function main() {
    console.log("REPLAY (not a live Serper call — see header comment) of compareByQuery(\"Samsung Galaxy S26 Ultra 12GB 256GB\")\n");
    console.log("Raw shopping results fed in (verbatim from the user's reported live output):", REPORTED_SHOPPING_RESULTS.length, "\n");

    const result = await compareByQuery("Samsung Galaxy S26 Ultra 12GB 256GB");

    console.log("\n--- FULL RESPONSE (what compareService.js / the frontend receives) ---");
    console.log(JSON.stringify(result, null, 2));

    console.log("\n--- CHECKS ---");
    const cellspare = result.results.find((r) => r.platform === "Cellspare");
    console.log("Cellspare present in result.results:", !!cellspare, cellspare ? "FAIL" : "PASS (excluded)");
    console.log("bestOffer:", result.bestOffer ? `${result.bestOffer.platform} ₹${result.bestOffer.price}` : "null");
    console.log("bestOffer is Cellspare:", result.bestOffer?.platform === "Cellspare" ? "FAIL" : "PASS");
    console.log("savings:", result.savings, result.savings > 60000 ? "SUSPICIOUS (may be inflated by an excluded offer)" : "OK");
}

main();
