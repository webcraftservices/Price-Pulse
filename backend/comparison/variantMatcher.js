/**
 * Variant Matcher
 * ------------------------------------------------------------------
 * V2 entry point for "is this candidate listing actually the same
 * product/variant the user asked for?" The weighted-evidence scoring
 * itself (brand, model, generation, storage, RAM, variant-suffix,
 * color guards) lives in services/productMatcher.js — this module is
 * the comparison-engine-facing surface: scoreOffers() batch-applies it
 * to a list of candidate offers, matching the ProductOffer.matchScore/
 * matchLevel shape from the target API contract.
 *
 * Extracted from compareService.js (V1) with no behavior change.
 */

const { computeMatchConfidence, confidenceLabel, evaluateProductIdentity, evaluateVariantIdentity, getMatchDecision } = require("../services/productMatcher");

/** Single candidate: returns { confidence, reason, primaryIssue, hardReject, matchDecision, requestedType, candidateType }. */
function matchOffer(sourceProduct, candidateTitle) {
    return computeMatchConfidence(sourceProduct, candidateTitle);
}

/**
 * Batch-scores a list of offers against the canonical source product.
 * Never mutates the input offers — returns new objects with matching
 * fields attached (matchConfidence, matchLabel, matchReason, matchIssue,
 * hardReject, matchDecision, productType).
 */
function scoreOffers(sourceProduct, offers) {
    return offers.map((offer) => {
        const { confidence, reason, primaryIssue, hardReject, matchDecision, requestedType, candidateType } =
            computeMatchConfidence(sourceProduct, offer.title);
        return {
            ...offer,
            matchConfidence: Number(confidence.toFixed(2)),
            matchLabel: confidenceLabel(confidence),
            matchReason: reason,
            // null | "product_type_conflict" | "accessory" | "variant_mismatch" |
            // "storage_mismatch" | "ram_mismatch" | "generation_mismatch" |
            // "model_number_mismatch" | "brand_mismatch"
            matchIssue: primaryIssue,
            // True only for a product-type conflict (spec Steps 5/8) — an
            // accessory/replacement-part/component/wrong-category candidate.
            // A hardReject offer must never enter final offers, possible
            // matches, or bestOffer (enforced in offerRanker.js).
            hardReject,
            // HARD_REJECT | EXACT_MATCH | STRONG_MATCH | POSSIBLE_MATCH | UNCERTAIN
            matchDecision,
            // The classifier's read on each side — "smartphone", "replacement_part",
            // "unknown", etc. Diagnostic/logging metadata, also exposed to the frontend.
            requestedProductType: requestedType,
            candidateProductType: candidateType,
        };
    });
}

module.exports = { matchOffer, scoreOffers, confidenceLabel, evaluateProductIdentity, evaluateVariantIdentity, getMatchDecision };
