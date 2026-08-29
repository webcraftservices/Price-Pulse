/**
 * Store Adapter Interface
 * ------------------------------------------------------------------
 * Every store adapter (real or stubbed) must export an object shaped
 * like this. This file documents the contract — it isn't imported by
 * adapters, but every adapter should conform to it so the comparison
 * engine can treat them interchangeably.
 *
 *   {
 *     id: "google_shopping",          // stable machine key
 *     label: "Google Shopping",       // display name
 *     implemented: true,              // false = adapter is a documented
 *                                      // stub, never called for live data
 *     reason: "..."                   // required when implemented=false —
 *                                      // why this store isn't wired up yet
 *
 *     async searchProduct(query, options) -> NormalizedOffer[]
 *     async getProductDetails(url, options) -> NormalizedOffer | null   (optional)
 *   }
 *
 * NormalizedOffer shape returned by searchProduct/getProductDetails:
 *   {
 *     store: string,                  // e.g. "Amazon"
 *     title: string,
 *     price: number | null,           // numeric, no currency symbols
 *     currency: string,               // e.g. "INR"
 *     availability: "in_stock" | "out_of_stock" | null,  // null = unknown, never guessed
 *     imageUrl: string | null,
 *     productUrl: string,
 *     productId: string | null,
 *     brand: string | null,
 *     model: string | null,
 *     rating: number | null,
 *   }
 *
 * Rules for any adapter that wants implemented: true:
 *   - Data must come from an official API, an authorized affiliate/product
 *     feed, or an authorized third-party product-search API.
 *   - No CAPTCHA/Cloudflare/bot-protection bypass, no auth evasion.
 *   - Must respect a request timeout (5-10s) and fail soft (throw/reject
 *     so the caller can catch it) rather than hang.
 *   - Never fabricate price, availability, or URLs. If a field can't be
 *     read from the response, it must be null — not guessed.
 */

/** Builds a NormalizedOffer with sensible nulls for anything not supplied. */
function normalizeOffer(partial) {
    return {
        store: partial.store || "Unknown",
        title: partial.title || "",
        price: typeof partial.price === "number" && Number.isFinite(partial.price) ? partial.price : null,
        currency: partial.currency || "INR",
        availability: partial.availability || null,
        imageUrl: partial.imageUrl || null,
        productUrl: partial.productUrl || null,
        productId: partial.productId || null,
        brand: partial.brand || null,
        model: partial.model || null,
        rating: typeof partial.rating === "number" ? partial.rating : null,
    };
}

/** Wraps an adapter call so one slow/failing store can't hang the whole comparison. */
function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

module.exports = { normalizeOffer, withTimeout };
