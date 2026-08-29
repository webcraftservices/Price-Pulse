/**
 * Serper Client
 * ------------------------------------------------------------------
 * Thin, low-level wrapper around Serper.dev's HTTP API. Knows nothing
 * about shopping vs. web search semantics or offer shapes — that's
 * shoppingSearch.js / webSearch.js. This file only owns: the base URL,
 * the API key header, and request timeout handling.
 *
 * Serper.dev is an authorized third-party product-search API (requires
 * a paid API key) — never touches store pages directly, no scraping,
 * no CAPTCHA/bot-protection bypass.
 */

const axios = require("axios");

const SERPER_BASE_URL = "https://google.serper.dev";

/**
 * POSTs to a Serper endpoint (e.g. "/shopping", "/search").
 * Throws if SERPER_API_KEY isn't configured — callers that want a
 * soft no-op instead (e.g. an optional/feature-flagged resolver) must
 * check for the key themselves before calling this.
 */
async function post(path, body, { timeoutMs = 10000 } = {}) {
    if (!process.env.SERPER_API_KEY) {
        throw new Error("SERPER_API_KEY is not configured.");
    }

    const response = await axios.post(`${SERPER_BASE_URL}${path}`, body, {
        headers: {
            "X-API-KEY": process.env.SERPER_API_KEY,
            "Content-Type": "application/json",
        },
        timeout: timeoutMs,
    });

    return response.data;
}

module.exports = { post, SERPER_BASE_URL };
