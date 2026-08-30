/**
 * URL Resolver
 * ------------------------------------------------------------------
 * Two responsibilities, both about turning "some URL Serper gave us"
 * into an honestly-labeled merchant URL:
 *
 *  1. resolveMerchantUrl(item) — given one raw Serper Shopping item,
 *     pick the best URL it already contains (never Google-hosted if
 *     an alternative exists) and flag whether what's left is a Google
 *     Shopping redirect rather than the merchant's own page.
 *
 *  2. resolveDirectMerchantUrlDetailed(merchant, query) — a bounded,
 *     cached, verified attempt to upgrade a Google-redirect-only offer
 *     to a real merchant product page via a scoped web search. Disabled
 *     by default (ENABLE_MERCHANT_URL_RESOLVER) — see
 *     providers/serper/webSearch.js for the underlying call. Never
 *     fabricates a URL: any failure, timeout, domain mismatch, page-type
 *     mismatch, or relevance mismatch means the caller keeps the
 *     original Google Shopping URL and honest labeling.
 *
 *     Two search strategies, tried in order (Phase 3 precision fix —
 *     "Merchant URL Resolution & Direct Buy Links"):
 *       (a) HIGH-confidence: for the small pre-vetted allowlist of major
 *           retailers (merchantRegistry.js), a domain-scoped
 *           `site:domain query` search — the domain itself is already
 *           trusted, so only relevance/page-shape need checking.
 *       (b) MEDIUM-confidence: for every OTHER merchant (e.g. the real
 *           live bestOffer merchant, "MRV electronics", which isn't in
 *           the ~10-domain static allowlist and therefore could never
 *           get a direct URL under the old allowlist-only design) — an
 *           unscoped `merchantName query` search, with the resulting
 *           domain independently fuzzy-verified against the merchant
 *           name (merchantNameMatchesHostname) before being trusted at
 *           all. Both strategies apply the same page-shape
 *           (looksLikeGenericOrSearchPage) and SSRF-safety
 *           (isSafeExternalUrl) checks before accepting a result.
 *
 *     `resolveDirectMerchantUrl` (bare-string return) is kept as a thin
 *     backward-compatible wrapper around the detailed function — existing
 *     callers/tests that only care about the URL string are unaffected.
 *
 * Only http/https, non-Google, non-private/local URLs are ever considered
 * valid (see utils/url.js). Extracted from stores/googleShopping.js and
 * stores/merchantUrlResolver.js (V1) with no behavior change to Part 1;
 * Part 2's allowlist path is also unchanged — only genuinely NEW behavior
 * (the MEDIUM-confidence fallback path) was added, additively.
 */

const { isGoogleHost, belongsToDomain, isSafeExternalUrl } = require("../utils/url");
const { getResolvableDomain } = require("../providers/merchants/merchantRegistry");
const { searchWeb } = require("../providers/serper/webSearch");

// ---------------------------------------------------------------------
// Part 1: pick the best URL already present on a raw Serper item
// ---------------------------------------------------------------------

// Fields we check for a direct merchant/product URL, in priority order.
// NOTE: we cannot confirm Serper's exact Shopping-endpoint schema without a
// live response — `link` is confirmed (by live evidence) to be a
// google.com/search?ibp=oshop redirect. These other names are checked
// defensively because some shopping-style APIs expose an alternate
// merchant URL; none are assumed to exist.
const ALT_URL_FIELDS = [
    "productLink", "product_link",
    "merchantLink", "merchant_link",
    "offerLink", "offer_link",
    "sourceUrl", "source_url",
    "dealUrl", "buyLink", "url",
];

// Some shopping-style APIs nest multi-seller info instead of a flat field.
// Checked defensively for the same reason as above.
function nestedMerchantUrl(item) {
    const arrays = [item.offers, item.sellers, item.merchants];
    for (const arr of arrays) {
        if (!Array.isArray(arr)) continue;
        for (const entry of arr) {
            const url = entry && (entry.link || entry.url || entry.productLink);
            if (url && !isGoogleHost(url)) return { url, source: "nested:offers[].link" };
        }
    }
    const objects = [item.merchant, item.product, item.offer];
    for (const obj of objects) {
        const url = obj && (obj.link || obj.url);
        if (url && !isGoogleHost(url)) return { url, source: "nested:merchant/product/offer.url" };
    }
    return null;
}

/**
 * Resolves the best available URL for an offer without ever inventing one.
 * Priority: (1) a top-level alternate field that isn't Google-hosted,
 * (2) a nested merchant/offer URL, (3) Serper's `link` field even if it IS
 * the Google redirect — better than no link at all, but callers get
 * `isGoogleRedirect: true` so they never mistake it for the merchant's page.
 */
function resolveMerchantUrl(item) {
    for (const field of ALT_URL_FIELDS) {
        const url = item[field];
        if (url && typeof url === "string" && !isGoogleHost(url)) {
            return { url, isGoogleRedirect: false, merchantUrlSource: field };
        }
    }

    const nested = nestedMerchantUrl(item);
    if (nested) return { url: nested.url, isGoogleRedirect: false, merchantUrlSource: nested.source };

    if (item.link && typeof item.link === "string") {
        const isRedirect = isGoogleHost(item.link);
        return { url: item.link, isGoogleRedirect: isRedirect, merchantUrlSource: isRedirect ? "link (google redirect fallback)" : "link" };
    }

    return { url: null, isGoogleRedirect: false, merchantUrlSource: "none" };
}

// ---------------------------------------------------------------------
// Part 2: bounded secondary resolution — upgrade a redirect to a direct URL
// ---------------------------------------------------------------------

// In-memory cache for the lifetime of the process — dedupes identical
// (merchant, query) resolution attempts across offers/requests. A null
// value is cached too, so a failed lookup isn't retried every time. Keyed
// by merchant name (not domain — the MEDIUM-confidence path doesn't know
// a domain ahead of time) + the full canonical query, which already
// encodes model/storage/RAM, so two different products for the same
// merchant never collide (Phase 12).
const resolutionCache = new Map();

function normalizeMerchantKey(name) {
    return String(name || "").toLowerCase().replace(/\.(in|com|co)$/i, "").trim();
}

function isEnabled() {
    return (process.env.ENABLE_MERCHANT_URL_RESOLVER || "").trim().toLowerCase() === "true";
}

// Exclusion-based, not inclusion-based (Phase 7 explicitly warns against
// hardcoding "/product/", "/dp/", etc. as universal truth — merchants use
// wildly different URL schemes). Rejects only the shapes that are reliably
// NOT a single product's detail page, regardless of merchant.
//
// Phase 11 precision fix ("Direct Store URL Precision Fix"): a live
// 20-product/274-offer test found the resolver accepting pages that are
// on the correct merchant domain, textually relevant, and NOT a
// search/category page by the checks above — but are still not a
// purchasable product page. Two concrete shapes were observed:
//   - editorial/content pages, e.g. croma.com/unboxed/10-settings-to-...
//     and reliancedigital.in/c/resource-center/bg/lenovo-ideapad-...
//   - brand storefront pages, e.g. amazon.in/stores/DellIndia/page/...
//     (a whole-brand landing page, not one product)
// Both are additive exclusions, matched on path segments (not arbitrary
// substrings) so a legitimate product slug that happens to contain one of
// these words elsewhere isn't caught — e.g. a product literally named
// "news" would not trip this unless "news" is itself a path segment.
function looksLikeGenericOrSearchPage(url) {
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return true; // unparsable — never treat as a usable product page
    }
    const path = parsed.pathname.replace(/\/+$/, "");
    if (path === "" || path === "/") return true; // bare homepage
    if (/\/(search|s|find|query|browse|category|categories|collections?)(\/|$)/i.test(path)) return true;
    // Common search/listing query params ("?q=", "?query=", "?k=" on
    // Amazon-style search URLs) mean this is a results page, not a product.
    if (["q", "query", "k", "search"].some((p) => parsed.searchParams.has(p))) return true;
    // Editorial/content pages (Phase 11): blog posts, buying guides, news
    // articles, and generic "resource center" hubs. Matched as whole path
    // segments so a real merchant path segment isn't accidentally caught
    // by a substring (e.g. "/unboxed/" is a segment, not a substring test).
    if (/\/(unboxed|resource-center|resources?|blogs?|guides?|news|articles?)(\/|$)/i.test(path)) return true;
    // Brand/manufacturer storefront pages (Phase 11): a whole-brand landing
    // page, not a single product — e.g. amazon.in/stores/DellIndia/page/...
    // Deliberately narrow (requires the /stores/<brand>/page/ shape, not a
    // bare "/stores/" anywhere) to avoid rejecting an unrelated merchant's
    // legitimate path that happens to contain the word "stores".
    if (/\/stores\/[^/]+\/page(\/|$)/i.test(path)) return true;
    // Dated CMS/editorial URLs (Phase 13): a live test found a genuine
    // blog article — cutetechgadgets.com/2024/03/10/on-the-spotlight-...
    // — accepted as a direct product URL because it contained no /blog/
    // or /news/ segment at all; it's a WordPress-style dated post path
    // instead. Anchored to require /YYYY/MM(/DD)?/ followed by a further
    // segment (the slug) so it only matches genuine dated-post shapes,
    // not an arbitrary numeric ID anywhere in a product path (a bare
    // "/product/1234/2024" with nothing after the year is NOT matched —
    // there's no following "/MM" segment, let alone a slug after that).
    if (/\/(19|20)\d{2}\/(0[1-9]|1[0-2])(?:\/(0[1-9]|[12]\d|3[01]))?\/[^/]+/i.test(path)) return true;
    // Sell / trade-in / buyback pages (Phase 13): a live test found
    // cashify.in/sell-old-laptop/used-dell-xps-13 accepted as a direct
    // "buy" URL when it's actually the merchant's own device-trade-in
    // intake page — the reverse transaction. Matched only when "sell"
    // (optionally hyphen-suffixed, e.g. "sell-old-laptop"), "trade-in",
    // "tradein", or "buyback" is an entire path SEGMENT starting right
    // after a "/" — so a product slug that merely contains "sell" as
    // part of a longer word (e.g. "/products/best-seller-headphones")
    // is untouched, since that segment doesn't begin with "sell".
    if (/\/(sell(?:-[a-z0-9-]+)?|trade-in|tradein|buyback)(?:\/|$)/i.test(path)) return true;
    return false;
}

// MEDIUM-confidence path only (the HIGH-confidence allowlist path already
// trusts its domain via belongsToDomain — a pre-vetted, hand-curated
// domain, not a guess). Deliberately conservative: the merchant name's
// FULL normalized form (not an individual token) must relate to the
// resolved URL's own hostname label as a contiguous unit — one must
// contain the other. This is verification of what Serper's search
// independently found — never a guess at what the domain "should" be
// (Phase 18).
//
// Phase 13 hardening: the previous version matched on individual tokens
// (>=3 chars) found anywhere inside the hostname label, which let a
// short, common token slip through against an unrelated real domain —
// a live test found "Shopy Vision" (tokens ["shopy","vision"]) passing
// against "datavision.com" purely because "vision" is a substring of
// "datavision", even though the two names share nothing else. Matching
// on the full concatenated name instead of loose tokens keeps the
// legitimate cases this function exists for (a merchant name that's an
// exact or near-exact match for the hostname label, e.g. "MRV
// electronics" -> mrvelectronics.in, or "Harsha" -> harshaindia.com,
// where the merchant name is a genuine prefix/substring of the real
// hostname) while rejecting the disjoint-token coincidence above.
function normalizeForHostnameCompare(str) {
    return String(str || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function merchantNameMatchesHostname(merchantName, url) {
    let hostname;
    try {
        hostname = new URL(url).hostname.replace(/^www\./, "");
    } catch {
        return false;
    }
    const hostLabel = normalizeForHostnameCompare(hostname.split(".")[0]);
    const merchantConcat = normalizeForHostnameCompare(merchantName);
    if (!hostLabel || !merchantConcat) return false;
    // Very short names/labels: substring containment is unreliable at
    // this length (almost anything "contains" a 1-2 char string), so
    // require exact equality instead. 5 is short enough to still cover
    // real short brand names ("Jio", "Boat"→"boat") via the equality
    // branch, while any genuine substring relationship at this length
    // would be coincidental.
    const MIN_LENGTH_FOR_SUBSTRING_MATCH = 5;
    if (merchantConcat.length < MIN_LENGTH_FOR_SUBSTRING_MATCH || hostLabel.length < MIN_LENGTH_FOR_SUBSTRING_MATCH) {
        return merchantConcat === hostLabel;
    }
    return hostLabel.includes(merchantConcat) || merchantConcat.includes(hostLabel);
}

/**
 * The full detailed resolver: tries the HIGH-confidence allowlist path
 * first, falls back to the MEDIUM-confidence verified-discovery path.
 * Returns { url, confidence: "high"|"medium" } on success, or null
 * (never throws, never fabricates a URL).
 *
 * matchValidator, if provided, is called with each candidate result's
 * title/snippet text and must return true for the URL to be accepted
 * (product-relevance validation — reuses the caller's own matching logic
 * rather than duplicating it here, per Phase 9).
 */
async function resolveDirectMerchantUrlDetailed(merchantName, canonicalQuery, { matchValidator } = {}) {
    const cacheKey = `${normalizeMerchantKey(merchantName)}::${canonicalQuery}`;
    if (resolutionCache.has(cacheKey)) return resolutionCache.get(cacheKey);

    if (!isEnabled() || !process.env.SERPER_API_KEY) {
        // Feature disabled or unconfigured — no-op, not an error. Caller
        // keeps the existing Google Shopping URL. Not cached: cheap to
        // re-check, and caching a "disabled" result could outlive a
        // runtime flag flip within the same process.
        return null;
    }

    let result = null;
    const domain = getResolvableDomain(merchantName);

    try {
        if (domain) {
            // HIGH confidence: domain is pre-vetted (merchantRegistry.js),
            // only relevance + page-shape need checking.
            const organic = await searchWeb(`site:${domain} ${canonicalQuery}`);
            for (const candidate of organic) {
                if (!candidate.link || !belongsToDomain(candidate.link, domain)) continue; // domain validation
                if (!isSafeExternalUrl(candidate.link)) continue; // Phase 11 safety
                if (looksLikeGenericOrSearchPage(candidate.link)) continue; // Phase 7
                const relevanceText = [candidate.title, candidate.snippet].filter(Boolean).join(" ");
                if (matchValidator && !matchValidator(relevanceText)) continue; // Phase 9
                result = { url: candidate.link, confidence: "high" };
                break;
            }
        }

        if (!result) {
            // MEDIUM confidence: no pre-vetted domain (or the scoped
            // search found nothing) — search generically for the
            // merchant + product, then independently verify the
            // resulting hostname actually looks like this merchant
            // before trusting it at all (Phase 8).
            const organic = await searchWeb(`${merchantName} ${canonicalQuery}`);
            for (const candidate of organic) {
                if (!candidate.link) continue;
                if (!isSafeExternalUrl(candidate.link)) continue; // Phase 11 safety (also excludes Google hosts)
                // Phase 11 region/TLD consistency: if the registry already
                // knows this merchant's canonical domain (e.g. Amazon ->
                // amazon.in), the MEDIUM path must not accept a different
                // country/TLD variant (amazon.com, amazon.co.uk, ...) just
                // because merchantNameMatchesHostname's fuzzy token check
                // would otherwise pass it — a live test found exactly this
                // ("Amazon" resolving to amazon.com for an India-targeted
                // comparison). Merchants with NO registered domain are
                // unaffected — fuzzy hostname matching is still the only
                // signal available for them, unchanged from before.
                if (domain) {
                    if (!belongsToDomain(candidate.link, domain)) continue;
                } else if (!merchantNameMatchesHostname(merchantName, candidate.link)) { // Phase 8
                    continue;
                }
                if (looksLikeGenericOrSearchPage(candidate.link)) continue; // Phase 7 / Phase 11
                const relevanceText = [candidate.title, candidate.snippet].filter(Boolean).join(" ");
                if (matchValidator && !matchValidator(relevanceText)) continue; // Phase 9
                result = { url: candidate.link, confidence: "medium" };
                break;
            }
        }
    } catch (err) {
        console.log(`[COMPARE] Merchant URL resolver failed for ${merchantName}: ${err.message}`);
        result = null;
    }

    resolutionCache.set(cacheKey, result);
    return result;
}

/**
 * Backward-compatible wrapper: same behavior as before this Phase 3 fix,
 * bare URL string (or null) instead of the detailed { url, confidence }
 * shape. Existing callers/tests that only need the URL string are
 * unaffected by the new MEDIUM-confidence path or the confidence model.
 */
async function resolveDirectMerchantUrl(merchantName, canonicalQuery, options) {
    const result = await resolveDirectMerchantUrlDetailed(merchantName, canonicalQuery, options);
    return result ? result.url : null;
}

module.exports = {
    resolveMerchantUrl,
    resolveDirectMerchantUrl,
    resolveDirectMerchantUrlDetailed,
    looksLikeGenericOrSearchPage,
    merchantNameMatchesHostname,
    isEnabled,
    ALT_URL_FIELDS,
};