/**
 * Serper Shopping Search
 * ------------------------------------------------------------------
 * Calls Serper's /shopping endpoint and returns the raw `shopping`
 * array exactly as Serper returns it — no normalization, no offer
 * shaping. That's comparison/offerExtractor.js's job. Keeping this
 * layer dumb is what lets the comparison engine depend on a stable
 * internal format instead of Serper's response shape directly.
 */

const { post } = require("./serperClient");

const REQUEST_TIMEOUT_MS = 10000;

async function searchShopping(query, { gl = "in", hl = "en", num = 15 } = {}) {
    const data = await post("/shopping", { q: query, gl, hl, num }, { timeoutMs: REQUEST_TIMEOUT_MS });
    return data.shopping || [];
}

module.exports = { searchShopping };
