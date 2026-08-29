/**
 * Live test runner for Stage 2 price comparison.
 * ------------------------------------------------------------------
 * This does NOT modify or duplicate the app's logic — it imports the
 * real backend/services/compareService.js (the exact code the server
 * uses) and calls it directly, so results reflect exactly what the
 * running app would do. Requires a real SERPER_API_KEY in backend/.env
 * and a working internet connection.
 *
 * USAGE (run from the backend/ folder):
 *
 *   node scripts/run-live-tests.js query "boAt Airdopes 141"
 *
 *   node scripts/run-live-tests.js product '{"brand":"Samsung","model":"Galaxy M14","storage":"128GB"}'
 *
 *   node scripts/run-live-tests.js query "asdkfjhqwlekjhasdlkfjh nonsense product"
 *     (tests the "no comparable offers found" path — test 20)
 *
 * Each run prints:
 *   - the exact search query sent to Serper
 *   - every [COMPARE] log line (query/store/matched/best price) —
 *     the same lines the real server prints
 *   - the full JSON response the frontend would receive
 *   - a short PASS/CHECK summary against the Stage 2 acceptance criteria
 */

require("dotenv").config();
const path = require("path");
const { compareByQuery, compareByProduct } = require(path.join(__dirname, "..", "services", "compareService"));
const { isEligibleForComparison } = require(path.join(__dirname, "..", "comparison", "offerEligibility"));

// The frontend/API response shape (toFrontendOffer in compareService.js)
// uses different field names than the engine's internal offer objects
// isEligibleForComparison actually expects (`url` vs `productUrl`; no
// `hardReject` field at all, since a hard-rejected offer is never even
// present in `result.results` to begin with). This adapter maps the
// public response shape onto that internal shape so this script can
// call the REAL eligibility function — not a hand-rolled copy of its
// rules that could silently drift out of sync with the engine.
function toEligibilityShape(frontendOffer) {
    return {
        hardReject: false, // always false here — a truly hard-rejected offer never reaches result.results
        matchConfidence: frontendOffer.matchConfidence,
        price: frontendOffer.price,
        availability: frontendOffer.availability,
        productUrl: frontendOffer.url,
        usableForBestOffer: frontendOffer.usableForBestOffer,
    };
}

function summarize(result) {
    console.log("\n--- SUMMARY ---");
    console.log("Total results:", result.results.length);

    const confident = result.results.filter((r) => !r.isPossibleMatch);
    const possible = result.results.filter((r) => r.isPossibleMatch);
    console.log("Confident matches:", confident.length, confident.map((r) => `${r.platform}(${r.matchConfidence})`));
    console.log("Possible matches:", possible.length, possible.map((r) => `${r.platform}(${r.matchConfidence})`));

    const withPrice = result.results.filter((r) => r.price !== null);
    const withoutPrice = result.results.filter((r) => r.price === null);
    console.log("Offers with a real numeric price:", withPrice.length);
    console.log("Offers with 'Price unavailable':", withoutPrice.length);

    const badUrls = result.results.filter((r) => !r.url || !/^https?:\/\//.test(r.url));
    console.log("Offers with a missing/invalid URL:", badUrls.length, badUrls.map((r) => r.platform));

    if (result.bestOffer) {
        console.log("\nbestOffer:", result.bestOffer.platform, result.bestOffer.price, result.bestOffer.availability, "confidence=" + result.bestOffer.matchConfidence);
        console.log("  CHECK: bestOffer.availability should NOT be 'out_of_stock' ->", result.bestOffer.availability !== "out_of_stock" ? "OK" : "FAIL");
        console.log("  CHECK: bestOffer should be the min price among eligible offers (confident, in-stock, priced, usableForBestOffer) ->",
            (() => {
                // Root-cause fix: this used to compute "eligible" as just
                // confident+priced+in-stock, which does NOT match what the
                // engine itself actually requires for bestOffer (it also
                // requires a real URL and usableForBestOffer !== false — see
                // offerEligibility.js's isEligibleForComparison). That gap
                // is exactly why a live run flagged a FALSE failure: a
                // refurbished offer (usableForBestOffer: false) was being
                // counted as "eligible" here even though the real engine
                // correctly excludes it. Reusing the actual eligibility
                // function (via the adapter above) instead of a second,
                // hand-written copy of its rules means this check can never
                // drift out of sync with the engine again.
                const eligible = result.results.filter((r) => isEligibleForComparison(toEligibilityShape(r)));
                if (eligible.length === 0) return "N/A (no eligible offers)";
                const min = Math.min(...eligible.map((r) => r.price));
                return min === result.bestOffer.price ? "OK" : `FAIL (expected ${min}, got ${result.bestOffer.price})`;
            })()
        );
    } else {
        console.log("\nbestOffer: null (no confidently-matched, in-stock, priced offer found)");
    }
}

async function main() {
    const [, , mode, arg] = process.argv;

    if (!mode || !arg) {
        console.log(__filename.split(path.sep).pop() + " usage:");
        console.log('  node scripts/run-live-tests.js query "product name"');
        console.log("  node scripts/run-live-tests.js product '{\"brand\":\"...\",\"model\":\"...\",\"storage\":\"...\"}'");
        process.exit(1);
    }

    try {
        let result;
        if (mode === "query") {
            console.log(`Running compareByQuery("${arg}") against the REAL Serper API...\n`);
            result = await compareByQuery(arg);
        } else if (mode === "product") {
            const product = JSON.parse(arg);
            console.log(`Running compareByProduct(${JSON.stringify(product)}) against the REAL Serper API...\n`);
            result = await compareByProduct(product);
        } else {
            console.log('First argument must be "query" or "product".');
            process.exit(1);
        }

        console.log("\n--- FULL RESPONSE (what the frontend receives) ---");
        console.log(JSON.stringify(result, null, 2));
        summarize(result);
    } catch (err) {
        console.log("\n--- THREW (this is what the Compare page would show as an error) ---");
        console.log("message:", err.message);
        console.log("statusCode:", err.statusCode);
    }
}

main();
