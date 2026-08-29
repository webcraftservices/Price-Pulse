/**
 * Amazon adapter — NOT IMPLEMENTED (documented stub)
 * ------------------------------------------------------------------
 * Why direct scraping isn't used:
 *   Amazon product/search pages sit behind bot-detection (CAPTCHA,
 *   request fingerprinting, aggressive rate limiting) and Amazon's
 *   Conditions of Use prohibit automated data collection outside their
 *   official programs. Building a scraper that works around that would
 *   mean bypassing anti-bot protection, which this project intentionally
 *   does not do.
 *
 * What would activate this adapter:
 *   The Amazon Product Advertising API (PA-API 5.0), which requires an
 *   approved Amazon Associates account and API credentials. Once
 *   available, set:
 *     AMAZON_PAAPI_ACCESS_KEY=
 *     AMAZON_PAAPI_SECRET_KEY=
 *     AMAZON_PAAPI_PARTNER_TAG=
 *   and implement searchProduct()/getProductDetails() below using the
 *   official PA-API SDK, then flip `implemented` to true and register
 *   this adapter as active in ./index.js.
 *
 * Until then this file only exists so the comparison engine has a place
 * to plug Amazon in later — it is never called for live data.
 */

async function searchProduct() {
    throw new Error(
        "Amazon adapter is not implemented — requires Amazon Product Advertising API credentials."
    );
}

module.exports = {
    id: "amazon",
    label: "Amazon",
    implemented: false,
    reason:
        "Requires the official Amazon Product Advertising API (PA-API 5.0) and an approved Associates account. Direct scraping is not used because it would require bypassing Amazon's bot protection, which this project does not do.",
    searchProduct,
};
