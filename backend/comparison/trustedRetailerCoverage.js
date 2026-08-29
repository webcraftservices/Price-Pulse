/**
 * Trusted Retailer Coverage (Phase 8.1)
 * ------------------------------------------------------------------
 * A single general Google Shopping query does not reliably surface
 * every major trusted retailer for a product (Phase 8.1 spec, Section
 * 1 — live example: Samsung Galaxy S26 Ultra returned only Reliance
 * Digital out of five category-relevant trusted retailers). This
 * module decides — ADDITIVELY, never touching matching/quality logic —
 * whether a small, bounded number of supplemental shopping-search
 * queries should be issued to improve the odds that category-relevant
 * trusted retailers appear among the CANDIDATES.
 *
 * CRITICAL ARCHITECTURAL RULE (spec Section 2): this module only ever
 * PLANS QUERY STRINGS. It does not fetch, match, score, deduplicate,
 * or rank anything itself. Every candidate a supplemental query turns
 * up still goes through the exact same collectCandidates -> dedup ->
 * scoreOffers -> offerQuality -> offerEligibility -> offerRanker
 * pipeline as general-query candidates (see compareEngine.js's
 * queryActiveAdapters, the only call site). A trusted retailer is
 * never granted a matching shortcut for being trusted — see spec
 * Section 9's own example (a trusted-but-wrong-variant Amazon listing
 * must still HARD_REJECT).
 *
 * WHY NOT `site:domain` SYNTAX (spec Section 4 asks for this to be
 * verified, not assumed): `site:` is a documented operator of Google's
 * organic web-search index (see Google's own search-operator docs).
 * Google's Shopping tab / Shopping Graph is served from a separate
 * structured product-feed index (Merchant Center listings), not the
 * crawled organic index `site:` filters. There is no vendor
 * documentation (Google's or Serper's) confirming `site:` reliably
 * restricts Shopping-endpoint results the same way it restricts
 * `/search`. This codebase already relies on `site:domain` successfully
 * for exactly one thing — urlResolver.js's resolveDirectMerchantUrlDetailed
 * — but that call goes through providers/serper/webSearch.js (the
 * `/search` organic endpoint), never `/shopping`. Reusing the same
 * operator against `/shopping` would be an unverified assumption this
 * task was explicitly told not to make.
 *
 * Because this sandbox's network egress does not include
 * google.serper.dev (see IMPLEMENTATION REPORT), a live A/B comparison
 * of `site:domain` vs. plain-keyword bias on the /shopping endpoint
 * could not be performed. This module therefore uses the conservative,
 * unambiguously-supported mechanism instead: appending the retailer's
 * own display name as a plain keyword to the existing canonical query
 * (e.g. "Samsung Galaxy S26 Ultra 12GB 256GB Amazon") — the same
 * keyword-biasing technique a human shopper already uses on Google
 * Shopping, and one that requires no unverified assumption about
 * operator support. MERCHANT_QUERY_BUILDER below is the single place
 * to change if a live Serper test later confirms `site:` scoping also
 * works for /shopping — no other file would need to change.
 */

const { REGISTRY } = require("../providers/merchants/merchantRegistry");
const { classifyProductType } = require("./productTypeClassifier");

function readIntEnv(name, fallback) {
    const raw = Number(process.env[name]);
    return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : fallback;
}

// Conservative default (spec Section 6: "Do not automatically perform 9+
// additional API calls... Prefer the smallest number that materially
// improves coverage"). Configurable without a code change.
const MAX_TRUSTED_RETAILER_QUERIES = readIntEnv("MAX_TRUSTED_RETAILER_QUERIES", 3);

function isCoverageEnabled() {
    return (process.env.TRUSTED_COVERAGE_ENABLED || "true").trim().toLowerCase() !== "false";
}

// Category -> ordered list of trusted-registry KEYS worth prioritizing for
// supplemental coverage (spec Section 7). This NEVER marks a retailer
// trusted and never adds a retailer merchantRegistry.js doesn't already
// list with trusted:true — it only orders WHICH already-trusted retailers
// are worth a supplemental query for a given product category.
// Categories match productTypeClassifier.js's PRODUCT_CATEGORY_SIGNALS
// exactly (that module is Phase 1-7/locked and is only ever READ here,
// never modified) — this repo's classifier currently only recognizes
// electronics categories, so fashion/beauty retailers (Myntra, Ajio,
// Nykaa) are intentionally left out of this table until a fashion/beauty
// classifier exists; they simply never receive supplemental coverage
// today (they can still appear via the general query as before).
const CATEGORY_RETAILER_PRIORITY = {
    smartphone: ["amazon", "flipkart", "croma", "reliance digital", "vijay sales"],
    tablet: ["amazon", "flipkart", "croma", "reliance digital"],
    smartwatch: ["amazon", "flipkart", "croma", "reliance digital"],
    earbuds: ["amazon", "flipkart", "croma", "reliance digital"],
    headphones: ["amazon", "flipkart", "croma", "reliance digital"],
    laptop: ["amazon", "flipkart", "croma", "reliance digital", "vijay sales"],
    desktop: ["amazon", "flipkart", "croma", "reliance digital"],
    monitor: ["amazon", "flipkart", "croma", "reliance digital"],
    television: ["amazon", "flipkart", "croma", "reliance digital", "vijay sales"],
    camera: ["amazon", "flipkart", "croma"],
    gaming_console: ["amazon", "flipkart", "croma", "reliance digital"],
    graphics_card: ["amazon", "flipkart"],
    cpu: ["amazon", "flipkart"],
    ssd: ["amazon", "flipkart"],
    hdd: ["amazon", "flipkart"],
    ram: ["amazon", "flipkart"],
    printer: ["amazon", "flipkart", "croma"],
    appliance: ["amazon", "flipkart", "croma", "reliance digital"],
    // "unknown" (classifier found no category signal at all) — kept
    // deliberately small; we're speculating less confidently here.
    unknown: ["amazon", "flipkart"],
};

function normalizeStoreLabel(name) {
    return String(name || "").toLowerCase().replace(/\.(in|com|co)$/i, "").trim();
}

/** Which trusted-registry keys are already represented among `offers`
 * (matched against each offer's own resolved `store` label — never
 * against title text, per merchantRegistry.js's own trust-classification
 * rule). Pure inspection, no side effects. */
function trustedKeysRepresented(offers) {
    const present = new Set();
    for (const offer of offers || []) {
        const label = normalizeStoreLabel(offer && offer.store);
        if (!label) continue;
        for (const key of Object.keys(REGISTRY)) {
            if (REGISTRY[key].trusted && (label === key || label.includes(key))) {
                present.add(key);
            }
        }
    }
    return present;
}

// See the file-level "WHY NOT site:domain SYNTAX" comment above.
function buildSupplementalQuery(baseQuery, retailerLabel) {
    return `${baseQuery} ${retailerLabel}`.replace(/\s+/g, " ").trim();
}

/**
 * canonicalProduct: see productIdentity.js's shape ({ name, brand, ... }).
 * baseQuery: the already-built canonical search query string
 *   (productNormalizer.buildSearchQuery) — the SAME string the general
 *   query already used.
 * generalOffers: NormalizedOffer[] already collected from the general
 *   query — inspected ONLY to detect which trusted retailers are
 *   already represented; never re-matched or re-scored here.
 *
 * Returns { queries: string[], targetedRetailers: string[] } — both
 * arrays are index-aligned (queries[i] targets targetedRetailers[i]),
 * capped at MAX_TRUSTED_RETAILER_QUERIES, and never include a retailer
 * already represented in generalOffers.
 */
function planTrustedCoverageQueries(canonicalProduct, baseQuery, generalOffers) {
    if (!isCoverageEnabled() || MAX_TRUSTED_RETAILER_QUERIES <= 0 || !baseQuery) {
        return { queries: [], targetedRetailers: [] };
    }

    const classifyText = [
        canonicalProduct && canonicalProduct.name,
        canonicalProduct && canonicalProduct.productName,
    ]
        .filter(Boolean)
        .join(" ");
    const classification = classifyProductType(classifyText);
    const category = (classification && !classification.isPart && classification.type) || "unknown";
    const priority = CATEGORY_RETAILER_PRIORITY[category] || CATEGORY_RETAILER_PRIORITY.unknown;

    const alreadyPresent = trustedKeysRepresented(generalOffers);

    const targetedRetailers = [];
    const queries = [];
    for (const key of priority) {
        if (queries.length >= MAX_TRUSTED_RETAILER_QUERIES) break;
        if (alreadyPresent.has(key)) continue; // spec Section 11: already covered, don't spend budget
        const entry = REGISTRY[key];
        if (!entry || entry.trusted !== true) continue; // registry is authoritative — never guess
        targetedRetailers.push(key);
        queries.push(buildSupplementalQuery(baseQuery, entry.label));
    }

    return { queries, targetedRetailers };
}

module.exports = {
    planTrustedCoverageQueries,
    trustedKeysRepresented,
    MAX_TRUSTED_RETAILER_QUERIES,
    isCoverageEnabled,
    CATEGORY_RETAILER_PRIORITY,
};
