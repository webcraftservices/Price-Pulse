/**
 * Offer Deduplicator
 * ------------------------------------------------------------------
 * The same product can appear multiple times in one Serper response
 * (multiple listings from the same seller, near-duplicate titles,
 * etc.). Dedup key priority per the target spec is: exact product
 * identifier > canonical merchant URL > normalized identity > merchant
 * + title/variant. In practice, with a single Google-Shopping-only
 * provider, only the last tier is reachable today — Serper's `link`
 * field is a google.com/search?ibp=oshop redirect for every result, so
 * hostname is identical across all offers and useless as a dedup key.
 * `store` (from Serper's `source` field) is the reliable, per-item-
 * distinct merchant identity and is what actually drives dedup here.
 *
 * Never merges two different variants just because titles are
 * similar — dedup is keyed on merchant identity, not fuzzy title
 * matching, so two genuinely different products from the same store
 * would need their own future identifier-based key (not yet reachable
 * with today's single provider). Extracted from compareService.js (V1)
 * with no behavior change.
 */

/** Keeps only the top (first-seen) listing per store. Not a filter —
 * every distinct store seen in `offers` is kept. */
function deduplicateByMerchant(offers) {
    const storeMap = new Map();
    const deduped = [];
    for (const offer of offers) {
        const key = (offer.store || offer._hostname || "").toLowerCase();
        if (!storeMap.has(key)) {
            storeMap.set(key, offer);
            deduped.push(offer);
        } else {
            const existing = storeMap.get(key);
            // Identity Safety: We MUST NOT blindly merge URLs between a seed and a Google offer,
            // because the seed might point to a completely different product (e.g. Pixel 10 Pro XL vs Pixel 10 Pro).
            // If they collide on the same store, we prioritize the rich Google Shopping offer (which has a price)
            // over the unpriced seed. The Google offer will have its redirect URL safely resolved later by the urlResolver.

            const existingIsSeed = existing._candidateSource === "seed_injection";
            const offerIsSeed = offer._candidateSource === "seed_injection";

            // If the existing offer is a seed, and the new offer is a Google offer, replace the seed.
            if (existingIsSeed && !offerIsSeed) {
                storeMap.set(key, offer);
                const idx = deduped.indexOf(existing);
                if (idx !== -1) {
                    deduped[idx] = offer;
                }
            }
            // If Google came first, and seed came second (!existingIsSeed && offerIsSeed), we ignore the seed.
            // If both are Google or both are seeds, we keep the first one seen (original behavior).
        }
    }
    return deduped;
}

/**
 * Exact-URL dedup — used only when merging candidates gathered from more
 * than one search query (searchPlanner + candidateCollector), where the
 * same listing can legitimately be returned twice for two different query
 * strings. Keeps the first-seen occurrence. Offers with no URL are always
 * kept (nothing to compare against), matching deduplicateByMerchant's
 * "never over-collapse" stance.
 */
function deduplicateByUrl(offers) {
    const seenUrls = new Set();
    const deduped = [];
    for (const offer of offers) {
        if (!offer.productUrl) {
            deduped.push(offer);
            continue;
        }
        if (seenUrls.has(offer.productUrl)) continue;
        seenUrls.add(offer.productUrl);
        deduped.push(offer);
    }
    return deduped;
}

module.exports = { deduplicateByMerchant, deduplicateByUrl };
