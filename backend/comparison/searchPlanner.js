/**
 * Search Planner
 * ------------------------------------------------------------------
 * Turns one canonical product identity into one or more search
 * queries. The strongest available identifier always leads (see
 * productNormalizer.js's buildSearchQuery, which already prefers
 * productId > brand+model > name).
 *
 * V1 behavior is preserved exactly: planQueries() returns a single
 * query (identical to the pre-Phase-4 pipeline) unless multiQuery is
 * explicitly requested. Multi-query fan-out — the actual behavior
 * change — only activates when the caller opts in (compareEngine.js
 * gates this on COMPARISON_ENGINE_V2), so the default pipeline's
 * output, and every existing regression test, is untouched.
 *
 * Bounded and adaptive, not exhaustive: at most MAX_QUERIES queries,
 * and a query is only added when it's likely to surface something the
 * base query wouldn't (spec Part 9: "do not generate unnecessary
 * queries").
 */

const { buildSearchQuery } = require("./productNormalizer");

const MAX_QUERIES = Number(process.env.SEARCH_PLANNER_MAX_QUERIES) || 3;

/**
 * canonicalProduct: see productIdentity.js's shape.
 * multiQuery: when false (default), returns exactly one query — the
 *   same base query the pipeline has always used. When true, may
 *   return up to MAX_QUERIES queries.
 *
 * Returns string[] (never contains duplicates or empty strings).
 */
function planQueries(canonicalProduct, { multiQuery = false } = {}) {
    const base = buildSearchQuery(canonicalProduct);
    if (!base) return [];

    if (!multiQuery) return [base];

    const queries = [base];
    const baseLower = base.toLowerCase();

    // A product-ID-only query (ASIN/SKU/etc.) is already maximally specific
    // — fanning out further would only dilute precision with noisier
    // matches, so stop here.
    if (canonicalProduct.productId) return queries;

    // Regional price hint: this app compares India-listed offers (INR,
    // amazon.in/flipkart.com/etc. per merchantRegistry.js), so a query
    // that doesn't already mention a region benefits from one that does —
    // some listings only surface for region-qualified searches.
    if (!/\bindia\b/.test(baseLower)) {
        queries.push(`${base} price India`);
    }

    // Drop the loosest identity component (color) to catch retailers whose
    // titles omit color from the listing text entirely — common for
    // storage/RAM-led titles ("... 12GB 256GB" with no color mentioned).
    if (canonicalProduct.color) {
        const withoutColor = base.replace(new RegExp(`\\b${canonicalProduct.color}\\b`, "i"), "").replace(/\s+/g, " ").trim();
        if (withoutColor && withoutColor.toLowerCase() !== baseLower) {
            queries.push(withoutColor);
        }
    }

    // De-dupe (case-insensitive) and cap.
    const seen = new Set();
    const deduped = [];
    for (const q of queries) {
        const key = q.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(q);
        if (deduped.length >= MAX_QUERIES) break;
    }
    return deduped;
}

module.exports = { planQueries, MAX_QUERIES };
