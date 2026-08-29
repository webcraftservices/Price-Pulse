/**
 * Flipkart adapter — NOT IMPLEMENTED (documented stub)
 * ------------------------------------------------------------------
 * Why direct scraping isn't used:
 *   Flipkart's search/product pages are protected against automated
 *   access (rate limiting, request fingerprinting) and their terms
 *   restrict unauthorized scraping. This project does not build scrapers
 *   that evade that protection.
 *
 * What would activate this adapter:
 *   The Flipkart Affiliate API, which requires an approved Flipkart
 *   Affiliate account and API credentials. Once available, set:
 *     FLIPKART_AFFILIATE_ID=
 *     FLIPKART_AFFILIATE_TOKEN=
 *   and implement searchProduct()/getProductDetails() below using the
 *   official Affiliate API, then flip `implemented` to true and
 *   register this adapter as active in ./index.js.
 *
 * Until then this file only exists so the comparison engine has a place
 * to plug Flipkart in later — it is never called for live data.
 */

async function searchProduct() {
    throw new Error(
        "Flipkart adapter is not implemented — requires Flipkart Affiliate API credentials."
    );
}

module.exports = {
    id: "flipkart",
    label: "Flipkart",
    implemented: false,
    reason:
        "Requires the official Flipkart Affiliate API and an approved affiliate account. Direct scraping is not used because it would require bypassing Flipkart's bot protection, which this project does not do.",
    searchProduct,
};
