/**
 * Offer Ranker
 * ------------------------------------------------------------------
 * Takes match-scored, deduplicated offers for a single product and
 * turns them into the final comparison result: which offers are
 * trustworthy enough to count, which are only "possible matches", and
 * which one (if any) is the best price — kept distinct from which one
 * is the best DIRECT-URL price (spec Part 20: bestPriceOffer vs.
 * bestDealOffer).
 *
 * Nothing in here invents data — an offer with no confirmed price is
 * never chosen as the best offer, and a low-confidence match is never
 * silently treated as the real product. Ranking does not simply sort
 * by price: retailer tier and verified-URL status affect display
 * order, and only a strongly-matched, priced, in-stock, linkable offer
 * is eligible to be crowned "best". A Google Shopping redirect never
 * automatically wins just for showing a lower number (spec Part 20).
 *
 * HARD-REJECTED offers (product-type conflicts — e.g. a phone's
 * motherboard/case/charger, see productTypeClassifier.js) are filtered
 * out FIRST, before the confident/possible split even runs. They can
 * never become a confident match, a possible match, bestOffer, or
 * bestDirectOffer, and never affect the savings calculation — see
 * offerEligibility.js for the gate itself.
 *
 * Extracted from services/priceComparator.js (V1) with no behavior
 * change; that file now re-exports this module's buildComparison.
 */

const { isEligibleForResults, isEligibleForComparison, MATCH_CONFIDENCE_THRESHOLD, BEST_OFFER_MATCH_THRESHOLD } = require("./offerEligibility");
const { roundCurrency } = require("../utils/numbers");

const TIER_RANK = { major_retailer: 0, known_retailer: 1, other_seller: 2 };

function validityRank(o) {
    if (o.availability === "out_of_stock") return 1;
    if (o.price === null) return 1;
    return 0;
}

function tierRank(o) {
    return TIER_RANK[o._retailerTier] ?? TIER_RANK.other_seller;
}

// Phase 7: Rank EXACT_MATCH higher than STRONG_MATCH with unconfirmed
// attributes, so that all else being equal, the more SKU-confirmed offer
// is preferred. EXACT_MATCH (0) < STRONG_MATCH with unconfirmed (1) <
// STRONG_MATCH fully confirmed (2) < other (3). This is a display-order
// preference only — bestOffer selection below still respects price as the
// primary determinant within the eligible pool.
function matchQualityRank(o) {
    // Only applies to confident offers (EXACT_MATCH and STRONG_MATCH are both >= 0.75)
    if (o.matchDecision === "EXACT_MATCH") return 0;
    if (o.matchDecision === "STRONG_MATCH") {
        // Unconfirmed high-priority attributes (storage/RAM) rank lower
        if (o.matchIssue === "storage_unconfirmed" || o.matchIssue === "ram_unconfirmed") {
            return 1;
        }
        // Fully confirmed STRONG_MATCH (e.g., color mismatch only)
        return 2;
    }
    // Fallback for edge cases
    return 3;
}

// Within the same tier, a verified direct merchant URL ranks ahead of a
// Google Shopping redirect. Display ordering only — bestOffer below stays
// price/confidence/availability-based regardless of URL type, preserving
// "always the true cheapest valid offer" as its own separate guarantee.
function directRank(o) {
    return o.productUrl && !o._isGoogleRedirectUrl ? 0 : 1;
}

/**
 * scoredOffers: Array<NormalizedOffer & { matchConfidence: number, matchReason: string, hardReject?: boolean }>
 *
 * Returns { offers, possibleMatches, rejectedOffers, bestOffer, bestDirectOffer, savings }
 */
function buildComparison(scoredOffers) {
    // Product-type conflicts are excluded BEFORE anything else — they can
    // never become a confident match, a possible match, or bestOffer,
    // regardless of price or raw token-overlap score (spec Steps 5/8/9).
    // Kept separately (not just dropped) so the caller can log why.
    const rejectedOffers = scoredOffers.filter((o) => !isEligibleForResults(o));
    const candidateOffers = scoredOffers.filter((o) => isEligibleForResults(o));

    const confidentOffers = [];
    const possibleMatches = [];

    for (const offer of candidateOffers) {
        // Bookkeeping fix (Phase 2 Offer Quality spec, section 15): this
        // used to split confident/possible at MATCH_CONFIDENCE_THRESHOLD
        // (0.5) — a SECOND, independently-drifted definition of
        // "confident" that disagreed with the canonical "strong" bar
        // (BEST_OFFER_MATCH_THRESHOLD, 0.75) every other field in the
        // system already uses: productMatcher.js's getMatchDecision
        // (EXACT_MATCH/STRONG_MATCH >= 0.75) and compareService.js's
        // toFrontendOffer (matchTier "strong" >= 0.75). A real live run
        // showed the mismatch directly: JioMart at matchConfidence 0.64
        // has matchDecision "POSSIBLE_MATCH" and displays matchTier
        // "uncertain" — yet the OLD 0.5-threshold split here filed it
        // under confidentOffers, and the "[COMPARE] CONFIDENT MATCHES"
        // log counted it as confident. Two thresholds, same underlying
        // number, two different answers for the same offer.
        //
        // Fix: use the SAME 0.75 bar (BEST_OFFER_MATCH_THRESHOLD) every
        // other "is this confident/strong" check in the codebase already
        // uses, instead of the disagreeing 0.5 constant. Not a new
        // threshold value — it's the existing one, already imported here,
        // already the canonical meaning of "confident/strong" everywhere
        // else. See tests/matching/offerQuality.test.js's "confident/
        // possible bookkeeping matches matchDecision" test for the
        // JioMart/Hariom repro.
        if (offer.matchConfidence >= BEST_OFFER_MATCH_THRESHOLD) {
            confidentOffers.push(offer);
        } else {
            possibleMatches.push(offer);
        }
    }

    const sortedOffers = [...confidentOffers].sort((a, b) => {
        const validityDiff = validityRank(a) - validityRank(b);
        if (validityDiff !== 0) return validityDiff;

        const tierDiff = tierRank(a) - tierRank(b);
        if (tierDiff !== 0) return tierDiff;

        // Phase 7: Prefer EXACT_MATCH over STRONG_MATCH with unconfirmed attributes
        const matchQualityDiff = matchQualityRank(a) - matchQualityRank(b);
        if (matchQualityDiff !== 0) return matchQualityDiff;

        const directDiff = directRank(a) - directRank(b);
        if (directDiff !== 0) return directDiff;

        if (a.price === null && b.price === null) return 0;
        if (a.price === null) return 1;
        if (b.price === null) return -1;
        return a.price - b.price;
    });

    // Only a STRONGLY-matched, priced, in-stock, actually-linkable,
    // non-hard-rejected offer is eligible to be "the" best price — a cheap
    // offer that's merely "possible/uncertain" (or a wrong product type)
    // must never win just for being the lowest number.
    const eligibleForBest = candidateOffers.filter(isEligibleForComparison);

    const bestOffer =
        eligibleForBest.length > 0
            ? eligibleForBest.reduce((min, o) => (o.price < min.price ? o : min))
            : null;

    // bestOffer = cheapest valid match, regardless of URL type. bestDirectOffer
    // = cheapest valid match that ALSO has a verified, non-Google URL. A Google
    // Shopping redirect must never be presented as if it were a directly
    // actionable merchant deal just for being cheaper — but it's also not
    // deleted from the results list, and bestOffer still honestly reflects the
    // true cheapest discovered price.
    const eligibleForDirectBest = eligibleForBest.filter((o) => !o._isGoogleRedirectUrl);
    const bestDirectOffer =
        eligibleForDirectBest.length > 0
            ? eligibleForDirectBest.reduce((min, o) => (o.price < min.price ? o : min))
            : null;

    // savings is computed only from valid, eligible offers (spec Step 10) —
    // a hard-rejected offer's price never leaks into this number, since it
    // was already excluded from candidateOffers/eligibleForBest above.
    //
    // DEFINITION (audited/confirmed, not changed, per the Phase 4 live-data
    // review — see PHASE4_LIVE_FIXES_REPORT.md): savings is the SPREAD
    // across the entire eligible/trusted price range for this product —
    // max(eligible prices) - min(eligible prices) — i.e. "how much more
    // the most expensive legitimate listing costs than the cheapest one",
    // NOT "bestOffer vs. one specific other offer" (there is no single
    // fixed "benchmark" merchant). A live Samsung run showing savings
    // 50643.81 against a displayed bestOffer of 89355.19 looked suspicious
    // at a glance (89355.19 + 50643.81 = 140,000 ≈ Manik Mobile Shopee's
    // ₹139,999 — the correct MAX of the eligible set that run, not Amazon's
    // ₹124,999) — confirmed correct under this definition, not a bug.
    const pricedEligible = eligibleForBest;
    const savings =
        pricedEligible.length > 1
            ? roundCurrency(Math.max(...pricedEligible.map((o) => o.price)) - Math.min(...pricedEligible.map((o) => o.price)))
            : 0;

    return { offers: sortedOffers, possibleMatches, rejectedOffers, bestOffer, bestDirectOffer, savings };
}

module.exports = { buildComparison, MATCH_CONFIDENCE_THRESHOLD, BEST_OFFER_MATCH_THRESHOLD };