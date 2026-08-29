/**
 * Quality Scorer
 * ------------------------------------------------------------------
 * matchConfidence (variantMatcher.js) answers "is this the right
 * product?". qualityScore answers a related but different question:
 * "how much should a user trust clicking this specific listing?" —
 * combining match strength with URL trustworthiness, retailer
 * reputation, and how complete the listing's data is.
 *
 * Deliberately does not feed back into offer ranking or bestOffer
 * selection (offerRanker.js) — it's presented alongside matchScore
 * (spec Part 18: "qualityScore: 94, matchScore: 98") as additional
 * context, not a replacement sort key. Never invents data: a missing
 * rating/availability simply scores 0 on that component instead of
 * being assumed absent-but-fine.
 */

// Numeric mapping for the Phase 3 URL Resolution confidence model
// (comparison/urlResolver.js) — "high"/"medium"/"low"/"none" strings map
// onto this existing 0-100 scale rather than inventing a new one
// (Phase 10: "reuse the existing urlConfidence conventions"). "low" keeps
// the original redirect value (50) for exact backward compatibility with
// every pre-existing consumer of this scale.
const URL_CONFIDENCE = {
    high: 100, // verified direct merchant URL — allowlisted domain or fuzzy-verified + relevance-checked
    medium: 70, // verified direct merchant URL via the non-allowlisted discovery path (Phase 3)
    low: 50, // only a Google Shopping redirect available
    none: 0, // no usable URL at all
    // Back-compat aliases for the pre-Phase-3 binary model, in case any
    // offer never passes through the resolver/extractor's new
    // `_urlConfidenceLevel` field at all (e.g. a hand-built test fixture).
    direct: 100,
    redirect: 50,
};

function urlConfidenceFor(offer) {
    if (!offer.productUrl) return URL_CONFIDENCE.none;
    if (offer._urlConfidenceLevel && URL_CONFIDENCE[offer._urlConfidenceLevel] !== undefined) {
        return URL_CONFIDENCE[offer._urlConfidenceLevel];
    }
    return offer._isGoogleRedirectUrl ? URL_CONFIDENCE.redirect : URL_CONFIDENCE.direct;
}

const TIER_POINTS = { major_retailer: 15, known_retailer: 8, other_seller: 0 };

/**
 * Returns { qualityScore: 0-100, urlConfidence: 0-100 } for one scored
 * offer (expects matchConfidence, productUrl, _isGoogleRedirectUrl,
 * _retailerTier, price, availability, rating already present).
 */
function computeQualityScore(offer) {
    const urlConfidence = urlConfidenceFor(offer);

    let score = 0;
    score += (offer.matchConfidence ?? 0) * 50; // up to 50 — match correctness dominates
    score += urlConfidence * 0.2; // up to 20 — can the user actually reach the merchant
    score += TIER_POINTS[offer._retailerTier] ?? 0; // up to 15 — retailer reputation
    score += offer.price !== null ? 5 : 0; // has a real, parsed price
    score += offer.availability === "in_stock" ? 5 : 0; // known to be purchasable
    score += typeof offer.rating === "number" ? 5 : 0; // has social proof

    return { qualityScore: Math.round(Math.max(0, Math.min(100, score))), urlConfidence };
}

/** Batch helper — attaches qualityScore/urlConfidence to each offer without mutating the input. */
function attachQualityScores(offers) {
    return offers.map((offer) => ({ ...offer, ...computeQualityScore(offer) }));
}

module.exports = { computeQualityScore, attachQualityScores };
