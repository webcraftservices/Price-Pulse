/**
 * Serper Web Search
 * ------------------------------------------------------------------
 * Calls Serper's /search endpoint and returns the raw `organic` array.
 * Used by comparison/urlResolver.js's scoped site: searches (e.g.
 * "site:amazon.in Samsung Galaxy S26 Ultra 256GB").
 *
 * NOTE: this is intentionally separate from AI Find's own web-search
 * call (backend/services/search/serper.js), which stays untouched per
 * the "don't touch AI Find" constraint — Compare Prices and AI Find
 * each own their own thin Serper wrapper rather than sharing one, so a
 * change to one search flow can never accidentally affect the other.
 */

const { post } = require("./serperClient");

const REQUEST_TIMEOUT_MS = 6000;

async function searchWeb(query) {
    const data = await post("/search", { q: query }, { timeoutMs: REQUEST_TIMEOUT_MS });
    return data.organic || [];
}

module.exports = { searchWeb };
