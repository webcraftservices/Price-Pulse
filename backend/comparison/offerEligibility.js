/**
 * Offer Eligibility
 * ------------------------------------------------------------------
 * Spec Step 9 ("bestOffer safety"): the cheapest result must never
 * automatically become bestOffer. This module is the single place that
 * decides which scored offers are even allowed to participate in
 * comparison — a hard-rejected offer (wrong product type — see
 * productTypeClassifier.js) must never appear as a confident match, a
 * possible match, bestOffer, or bestDirectOffer, no matter how cheap it
 * is or how high its raw token-overlap score happened to be.
 */

// Two different bars for two different jobs (unchanged from before this
// fix — moved here so offerRanker.js and offerEligibility.js share one
// definition instead of two):
//  - MATCH_CONFIDENCE_THRESHOLD: the line between "shown as a real offer"
//    and "shown separately as a possible match".
//  - BEST_OFFER_MATCH_THRESHOLD: the line for actually being crowned the
//    best price.
const MATCH_CONFIDENCE_THRESHOLD = 0.5;
const BEST_OFFER_MATCH_THRESHOLD = 0.75;

/**
 * Gate 1 — is this offer even allowed to appear in the results at all?
 * Only a product-type conflict excludes an offer entirely (spec Steps 5/8:
 * "HARD_REJECT must never enter final offers"). Everything else (wrong
 * generation, wrong storage, low title overlap, ...) is a CONFIDENCE
 * problem, not an eligibility problem, and is handled by the existing
 * confident-vs-possible split in offerRanker.js — unchanged from before
 * this fix (see Test J, which requires a wrong-generation candidate to
 * remain visible as a possible match).
 */
function isEligibleForResults(offer) {
    return !offer.hardReject;
}

/**
 * Gate 2 — is this offer eligible to be crowned bestOffer/bestDirectOffer?
 * Strictly stronger than gate 1: must also clear the "strong" confidence
 * bar, have a real parsed price, be in-stock (or unknown — never
 * confirmed out of stock), have a real URL, AND — Phase 2 Offer/Price
 * Quality fix — not be flagged unusable by offerQuality.js (a malformed
 * title, a suspicious price outlier vs. the identity-filtered comparable
 * cluster, an EMI/installment price, a used/refurbished listing, etc.).
 * A hard-rejected offer fails this automatically via matchConfidence
 * being forced to 0 (see productMatcher.js), but the explicit
 * `!offer.hardReject` check here documents the guarantee rather than
 * relying on that side effect.
 *
 * offerQuality is a DIFFERENT concept from hardReject (see offerQuality.js's
 * doc comment) — a suspicious/invalid offer never becomes hardReject:true,
 * so it still passes Gate 1 (isEligibleForResults) and remains visible in
 * results/possibleMatches; it's specifically excluded here, from
 * bestOffer/bestDirectOffer eligibility only. `offer.usableForBestOffer`
 * defaults to true (`!== false`) for any offer offerQuality.js hasn't run
 * on yet (e.g. direct unit tests of this function) — the pipeline
 * (compareEngine.js) always runs attachOfferQuality before this gate.
 */
function isEligibleForComparison(offer) {
    return (
        !offer.hardReject &&
        offer.matchConfidence >= BEST_OFFER_MATCH_THRESHOLD &&
        offer.price !== null &&
        offer.availability !== "out_of_stock" &&
        !!offer.productUrl &&
        offer.usableForBestOffer !== false
    );
}

module.exports = {
    isEligibleForResults,
    isEligibleForComparison,
    MATCH_CONFIDENCE_THRESHOLD,
    BEST_OFFER_MATCH_THRESHOLD,
};
