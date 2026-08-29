/**
 * Compare Service
 * ------------------------------------------------------------------
 * The public API this module exposes (compareProduct/compareByQuery/
 * compareByProduct) is unchanged for existing callers (routes/compare.js,
 * routes/search.js). Internally this file now owns only:
 *   1. URL -> title/image scraping (the "paste a URL" entry point)
 *   2. Mapping the engine's internal offer shape to the frontend/API
 *      contract (toFrontendOffer) — the adapter layer called for in
 *      spec Part 32, so a future response-shape change never forces a
 *      frontend rewrite
 *   3. The three public entry-point functions
 *
 * The actual comparison pipeline (product identity -> search -> match
 * -> dedup -> URL resolution -> ranking) now lives in
 * comparison/compareEngine.js. See that file for the pipeline itself.
 */

const axios = require("axios");
const cheerio = require("cheerio");

const { runComparison: runComparisonEngine } = require("../comparison/compareEngine");
const { buildSearchQuery } = require("../comparison/productNormalizer");
const { BEST_OFFER_MATCH_THRESHOLD } = require("../comparison/offerRanker");
const { cleanScrapedTitle, guessTitleFromUrl } = require("../utils/text");
const { roundCurrency } = require("../utils/numbers");
const { CompareError } = require("../utils/errors");

const BROWSER_HEADERS = {
    "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Accept-Language": "en-IN,en;q=0.9",
};

// ---------------------------------------------------------------------
// URL -> product title scraping (used only by the legacy "paste a URL" flow)
// ---------------------------------------------------------------------

async function scrapeProductDetails(url) {
    let title = "";
    let image = "";

    try {
        const response = await axios.get(url, {
            headers: BROWSER_HEADERS,
            timeout: 8000,
            maxRedirects: 5,
        });
        const $ = cheerio.load(response.data);

        const ogTitle = $('meta[property="og:title"]').attr("content");
        const rawTitle = ogTitle || $("title").first().text() || "";
        title = cleanScrapedTitle(rawTitle);

        image =
            $('meta[property="og:image"]').attr("content") ||
            $("#landingImage").attr("src") ||
            $("img#imgTagWrapperId img").attr("src") ||
            "";
    } catch (err) {
        console.log(`[COMPARE] Scrape failed for ${url}: ${err.message}`);
    }

    if (!title) {
        title = guessTitleFromUrl(url);
    }

    return { title, image };
}

// ---------------------------------------------------------------------
// Engine result -> frontend/API contract adapter
// ---------------------------------------------------------------------

// Maps an internal NormalizedOffer (+ match score) to the shape the existing
// frontend (js/compare.js) already knows how to render, plus the new fields
// it can optionally use (matchConfidence, availability, isPossibleMatch).
function toFrontendOffer(offer, { sourceHost = null, isPossibleMatch = false } = {}) {
    let hostname = offer._hostname || null;
    if (!hostname && offer.productUrl) {
        try {
            hostname = new URL(offer.productUrl).hostname.replace(/^www\./, "");
        } catch {
            hostname = null;
        }
    }

    return {
        platform: offer.store,
        title: offer.title,
        url: offer.productUrl,
        // Rounded at this API boundary (spec Phase 4 — currency values must
        // never leak IEEE-754 float artifacts like 47562.79999999999). The
        // underlying engine keeps full precision internally; only what's
        // actually shown to a person/consumer gets rounded.
        price: roundCurrency(offer.price),
        mrp: null,
        discount: 0,
        color: offer._color || "default",
        isSource: sourceHost ? hostname === sourceHost : false,
        rating: offer.rating,
        availability: offer.availability, // "in_stock" | "out_of_stock" | null (unknown)
        matchConfidence: offer.matchConfidence,
        isPossibleMatch,
        // "strong": cleared the bestOffer bar (>= BEST_OFFER_MATCH_THRESHOLD).
        // "uncertain": shown as a real offer (>= MATCH_CONFIDENCE_THRESHOLD)
        // but too weak to ever be bestOffer.
        // "possible": below the display threshold entirely (isPossibleMatch).
        matchTier: isPossibleMatch ? "possible" : offer.matchConfidence >= BEST_OFFER_MATCH_THRESHOLD ? "strong" : "uncertain",
        // Specific reason a listing was demoted, when applicable — lets the
        // frontend show "Variant mismatch"/"Storage mismatch"/etc instead of
        // a blanket "Low confidence" for every non-strong offer.
        matchIssue: offer.matchIssue || null,
        // Spec Steps 2/8 — product-type classification and the overall
        // match decision label. Additive fields; existing matchTier/
        // isPossibleMatch logic above is unchanged.
        productType: offer.candidateProductType || null,
        matchDecision: offer.matchDecision || null,
        // Spec Part 18 — a separate signal from matchConfidence: how much a
        // user should trust clicking this specific listing (match strength +
        // URL trustworthiness + retailer reputation + data completeness).
        // Never affects ranking/bestOffer selection, purely informational.
        qualityScore: typeof offer.qualityScore === "number" ? offer.qualityScore : null,
        urlConfidence: typeof offer.urlConfidence === "number" ? offer.urlConfidence : null,
        // True when `url` is Google's Shopping redirect rather than the
        // merchant's own product page.
        isGoogleRedirect: !!offer._isGoogleRedirectUrl,
        // True only when the URL is genuinely the merchant's own page (never
        // a Google Shopping redirect).
        isDirectMerchantUrl: !!offer.productUrl && !offer._isGoogleRedirectUrl,
        // Which field/path the URL came from — debugging/reporting metadata only.
        merchantUrlSource: offer._merchantUrlSource || null,
        // Phase 3 (Merchant URL Resolution) diagnostics — optional/additive,
        // never required by existing consumers. "not_attempted": still a
        // Google redirect, resolver never tried (disabled, over the bounded
        // limit, or offer wasn't eligible per Phase 5's priority filter).
        // "already_direct": Serper itself gave a non-Google URL, no
        // resolution needed. "resolved": the bounded secondary search
        // upgraded it. "failed": resolution was attempted but found nothing
        // trustworthy — the original Google URL is still preserved above.
        urlResolutionStatus: offer._urlResolutionStatus || "not_attempted",
        // Classification, not a filter — every merchant Serper returns is
        // still included. "retailerTier" is the 3-tier classification
        // (major_retailer/known_retailer/other_seller); "isMajorRetailer" is
        // kept for backward compatibility with the existing UI, derived from
        // the same source so the two can never disagree.
        retailerTier: offer._retailerTier || "other_seller",
        isMajorRetailer: offer._retailerTier === "major_retailer",
        // Phase 8 — registry-based trusted-retailer classification (see
        // merchantRegistry.isTrustedMerchant). Independent of tier/
        // isMajorRetailer above: a major_retailer entry is not necessarily
        // trusted:true yet (e.g. Tata Cliq today) — see merchantRegistry.js.
        isTrustedRetailer: !!offer._isTrustedRetailer,
        // Phase 2 Offer/Price Quality fix — a SEPARATE concept from
        // matchConfidence/matchDecision above: whether this specific
        // listing's price/title looks trustworthy enough to compare at
        // all (see comparison/offerQuality.js). A suspicious/invalid
        // offer still appears here (never silently dropped — spec
        // section 3) but is excluded from bestOffer/bestDirectOffer/
        // savings; usableForBestOffer explains why at a glance without
        // the caller needing to inspect offerQuality.reasons.
        offerQuality: offer.offerQuality ? offer.offerQuality.status : "trusted",
        offerQualityScore: typeof offer.offerQualityScore === "number" ? offer.offerQualityScore : 1,
        offerQualityReasons: offer.offerQualityReasons || [],
        usableForBestOffer: offer.usableForBestOffer !== false,
    };
}

async function runComparison(sourceProduct, { sourceHost = null } = {}) {
    const { canonicalProduct, offers, possibleMatches, bestOffer, bestDirectOffer, savings, query, trusted } =
        await runComparisonEngine(sourceProduct, { sourceHost });

    const frontendOffers = [
        ...offers.map((o) => toFrontendOffer(o, { sourceHost })),
        ...possibleMatches.map((o) => toFrontendOffer(o, { sourceHost, isPossibleMatch: true })),
    ];

    const displayName =
        canonicalProduct.name ||
        [canonicalProduct.brand, canonicalProduct.productName || canonicalProduct.model].filter(Boolean).join(" ") ||
        query;

    // Phase 8 — Trusted Retailer layer. Mapped through the SAME
    // toFrontendOffer adapter as the full-internet results above, so
    // every field a trusted-mode offer exposes (matchTier, offerQuality,
    // retailerTier, isDirectMerchantUrl, ...) means exactly the same thing
    // it already means everywhere else in the API — no parallel offer
    // shape to keep in sync.
    const trustedFrontendOffers = trusted
        ? [
              ...trusted.offers.map((o) => toFrontendOffer(o, { sourceHost })),
              ...trusted.possibleMatches.map((o) => toFrontendOffer(o, { sourceHost, isPossibleMatch: true })),
          ]
        : [];

    return {
        product: {
            name: displayName,
            image: sourceProduct.image || "",
            brand: canonicalProduct.brand || null,
            model: canonicalProduct.model || null,
        },
        // UNCHANGED (Phase 8 backward compatibility): every field below this
        // point keeps its pre-Phase-8 meaning exactly — the full-internet
        // pool, same as every existing consumer already expects. Cap
        // generously — the whole point of Stage 2.1 was preserving every
        // legitimate merchant Serper returns; a low cap here would silently
        // throw results away after the pipeline correctly found them.
        results: frontendOffers.slice(0, 30),
        bestOffer: bestOffer ? toFrontendOffer(bestOffer, { sourceHost }) : null,
        // The cheapest offer that ALSO has a verified direct merchant URL
        // (never a Google Shopping redirect). Distinct from bestOffer above,
        // which reflects the true cheapest discovered price regardless of
        // URL type — the two intentionally are NOT conflated.
        bestDirectOffer: bestDirectOffer ? toFrontendOffer(bestDirectOffer, { sourceHost }) : null,
        savings,

        // ADDITIVE (Phase 8): the default, curated trusted-retailer pool.
        // Every offer here is a strict subset of `results` above — nothing
        // in `results`/`bestOffer`/`savings` is removed or recalculated to
        // make room for this (spec Section 8: non-trusted offers are never
        // destroyed, only not included here).
        trustedOffers: trustedFrontendOffers.slice(0, 30),
        bestTrustedOffer: trusted && trusted.bestOffer ? toFrontendOffer(trusted.bestOffer, { sourceHost }) : null,
        bestTrustedDirectOffer:
            trusted && trusted.bestDirectOffer ? toFrontendOffer(trusted.bestDirectOffer, { sourceHost }) : null,
        // Same "spread across the eligible pool" definition offerRanker.js
        // already uses for `savings` above, just computed over the trusted
        // pool only — a non-trusted merchant's price (outlier or not) can
        // never inflate or deflate this number (spec Section 10).
        trustedSavings: trusted ? trusted.savings : 0,
        // Count of unique TRUSTED merchants with a confident, eligible
        // offer. Each entry in offers/trusted.offers is already one row
        // per distinct store (offerDeduplicator.deduplicateByMerchant
        // runs before matching), so this count IS a store/merchant count,
        // not a raw listing count.
        trustedRetailerCount: trusted ? trusted.offers.length : 0,
        // Count of the full-internet confident matches (offers.length) —
        // i.e. the TOTAL number of unique merchants in the broader pool,
        // trusted retailers included. Named separately so the frontend
        // never has to reach into `results.length` (which also includes
        // lower-confidence "possible matches") to answer "how many
        // TOTAL stores did the wider internet search find".
        internetOfferCount: offers.length,
        // Phase 8.1 (spec Section 23 fix) — the number of unique merchants
        // "Search Full Internet" would reveal that AREN'T already shown in
        // the default trusted view. trusted.offers is guaranteed to be a
        // subset of `offers` (same buildComparison() call, same per-offer
        // eligibility rules, just filtered to _isTrustedRetailer===true
        // beforehand — see compareEngine.js), so a simple set difference
        // is correct and never double-counts. This is the number the
        // "Search Full Internet (N more stores)" button must use — using
        // internetOfferCount there (the TOTAL, not the delta) was the bug:
        // it double-counted retailers already visible in the trusted view.
        additionalOfferCount: Math.max(0, offers.length - (trusted ? trusted.offers.length : 0)),
    };
}

// ---------------------------------------------------------------------
// Public API (kept backward-compatible with existing routes)
// ---------------------------------------------------------------------

// URL-based compare: scrape the pasted product page for its title/image,
// then run the same matching pipeline as everything else.
async function compareProduct(url) {
    let parsedUrl;
    try {
        parsedUrl = new URL(url);
    } catch {
        throw new CompareError("Please paste a valid product page URL (including https://).", 400, "INVALID_INPUT");
    }

    const { title, image } = await scrapeProductDetails(url);

    if (!title) {
        throw new CompareError(
            "Couldn't identify the product from this link. Try pasting a direct product page URL.",
            400,
            "PRODUCT_NOT_IDENTIFIED"
        );
    }

    const sourceHost = parsedUrl.hostname.replace(/^www\./, "");
    return runComparison({ name: title, image }, { sourceHost });
}

// Text-query variant: caller only knows a plain product name/description
// (typed search, suggestion chip, or a Find result with no structured fields).
async function compareByQuery(query) {
    const title = (query || "").trim();

    if (!title) {
        throw new CompareError("Please enter a product to search for.", 400, "INVALID_INPUT");
    }

    return runComparison({ name: title });
}

// Structured product variant: caller has the AI Find output (brand, model,
// storage, color, category, ...). This is what powers the automatic
// "Compare Prices" handoff from Find, and gives the best match accuracy
// since brand/model/variant are known rather than inferred from a title.
async function compareByProduct(product) {
    if (!product || typeof product !== "object") {
        throw new CompareError("A product is required.", 400, "INVALID_INPUT");
    }

    const hasSomeIdentity = product.name || product.brand || product.productName || product.model;
    if (!hasSomeIdentity) {
        throw new CompareError("Product must include at least a name, brand, or model.", 400, "INVALID_INPUT");
    }

    return runComparison(product);
}

module.exports = {
    compareProduct,
    compareByQuery,
    compareByProduct,
    buildSearchQuery,
    CompareError,
};
