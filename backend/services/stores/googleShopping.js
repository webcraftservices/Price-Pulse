/**
 * Google Shopping adapter (via Serper.dev)
 * ------------------------------------------------------------------
 * Data source: Serper (https://serper.dev) is an authorized third-party
 * product-search API that surfaces Google Shopping listings. It requires
 * a paid API key (SERPER_API_KEY), never touches store pages directly,
 * and involves no scraping, CAPTCHA bypass, or bot-protection evasion.
 *
 * This is the only "store" adapter with implemented: true right now.
 * It returns real, live listings aggregated across whichever merchants
 * Google Shopping has indexed for the query (Amazon, Flipkart, Croma,
 * etc. commonly appear here without us talking to those sites at all).
 *
 * V2 note: this file is now a thin adapter — the actual Serper HTTP call
 * lives in providers/serper/shoppingSearch.js, and turning raw items into
 * NormalizedOffers lives in comparison/offerExtractor.js. This file's job
 * is just: call the provider, hand results to the extractor, log, return.
 */

const { searchShopping } = require("../../providers/serper/shoppingSearch");
const { extractOffers } = require("../../comparison/offerExtractor");

async function searchProduct(query, options = {}) {
    const shoppingResults = await searchShopping(query, options);

    if (process.env.DEBUG_COMPARE === "true" && shoppingResults.length > 0) {
        console.log(`[COMPARE] Raw Serper results: ${shoppingResults.length}`);
        console.log("[COMPARE] Raw Serper item sample (field names as actually returned):");
        console.log(JSON.stringify(shoppingResults[0], null, 2));
    }

    const offers = extractOffers(shoppingResults, query);

    if (process.env.DEBUG_COMPARE === "true") {
        console.log(`[COMPARE] Normalized offers: ${offers.length}`);
        console.log(`[COMPARE] Merchant labels seen: ${offers.map((o) => o.store).join(", ")}`);
        console.log("[COMPARE] URL resolution per offer:");
        offers.forEach((o) => {
            console.log(`  ${o.store} | source=${o._merchantUrlSource} | isGoogleRedirect=${o._isGoogleRedirectUrl} | ${o.productUrl}`);
        });
    }

    return offers;
}

module.exports = {
    id: "google_shopping",
    label: "Google Shopping",
    implemented: true,
    searchProduct,
};
