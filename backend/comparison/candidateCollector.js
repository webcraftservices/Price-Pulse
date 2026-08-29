/**
 * Candidate Collector
 * ------------------------------------------------------------------
 * Runs every planned query (see searchPlanner.js) against the active
 * store adapters, in parallel, with short-TTL caching per query text
 * (comparisonCache.js) so repeated/overlapping queries don't re-hit
 * the provider. One failing query or adapter never blocks the others
 * (spec RULE 5 / Part 22) — only if EVERY query fails at the adapter
 * level does this raise PROVIDER_FAILURE.
 *
 * With a single planned query (the default, pre-Phase-4 behavior) this
 * behaves identically to the original queryActiveAdapters: one call,
 * one result set, same error semantics.
 */

const { ACTIVE_ADAPTERS } = require("../services/stores");
const { CompareError } = require("../utils/errors");
const { deduplicateByUrl } = require("./offerDeduplicator");
const cache = require("./comparisonCache");

// Runs every active adapter for a single query. One failing/slow store
// never blocks the others — its result is just dropped and logged.
async function runAdaptersForQuery(query) {
    const settled = await Promise.allSettled(
        ACTIVE_ADAPTERS.map((adapter) => adapter.searchProduct(query))
    );

    const offers = [];
    const providersSucceeded = [];
    const providersFailed = [];

    settled.forEach((result, i) => {
        const adapter = ACTIVE_ADAPTERS[i];
        if (result.status === "fulfilled") {
            console.log(`[COMPARE] Store: ${adapter.id} Results: ${result.value.length}`);
            offers.push(...result.value);
            providersSucceeded.push(adapter.id);
        } else {
            providersFailed.push(adapter.id);
            console.log(`[COMPARE] Store: ${adapter.id} status: unavailable (${result.reason?.message || "error"})`);
        }
    });

    return { offers, providersSucceeded, providersFailed };
}

/**
 * queries: string[] from searchPlanner.planQueries().
 * useCache: opt-in only (compareEngine.js passes true only when
 *   COMPARISON_ENGINE_V2 is enabled). Caching is a V2 behavior change —
 *   the default single-query path makes a fresh call every time, exactly
 *   like the pre-Phase-4 pipeline, so cached results from one comparison
 *   can never leak into an unrelated one that happens to share query text.
 *
 * Returns { offers, diagnostics: { providersAttempted, providersSucceeded,
 * providersFailed, queriesRun } }. Throws CompareError only for
 * configuration (no adapters at all) or total provider failure (every
 * query, every adapter, failed).
 */
async function collectCandidates(queries, { useCache = false } = {}) {
    if (ACTIVE_ADAPTERS.length === 0) {
        throw new CompareError(
            "No store data sources are currently configured. Add store adapter credentials to enable price comparison.",
            503,
            "CONFIGURATION_ERROR"
        );
    }

    const allOffers = [];
    const succeededSet = new Set();
    const failedSet = new Set();
    let anyQuerySucceeded = false;

    for (const query of queries) {
        const cacheKey = query.toLowerCase().trim();
        const cached = useCache ? cache.get("search", cacheKey) : undefined;
        if (cached) {
            allOffers.push(...cached);
            anyQuerySucceeded = true;
            continue;
        }

        const { offers, providersSucceeded, providersFailed } = await runAdaptersForQuery(query);
        providersSucceeded.forEach((id) => succeededSet.add(id));
        providersFailed.forEach((id) => failedSet.add(id));

        if (providersSucceeded.length > 0) {
            anyQuerySucceeded = true;
            if (useCache) cache.set("search", cacheKey, offers);
        }

        allOffers.push(...offers);
    }

    // Every query's every adapter failed, and nothing at all came back —
    // this is a provider outage, not "the product doesn't exist".
    if (!anyQuerySucceeded && allOffers.length === 0) {
        throw new CompareError(
            "Couldn't reach the price comparison service right now. Please try again in a moment.",
            502,
            "PROVIDER_FAILURE"
        );
    }

    // Only relevant when multiple queries were actually run — the same
    // listing can legitimately come back for two different query strings.
    // A single-query call (the default, pre-Phase-4 path) skips this
    // entirely so its output stays byte-for-byte identical to before.
    const mergedOffers = queries.length > 1 ? deduplicateByUrl(allOffers) : allOffers;

    return {
        offers: mergedOffers,
        diagnostics: {
            providersAttempted: ACTIVE_ADAPTERS.map((a) => a.id),
            providersSucceeded: [...succeededSet],
            providersFailed: [...failedSet],
            queriesRun: queries,
        },
    };
}

module.exports = { collectCandidates, runAdaptersForQuery };
