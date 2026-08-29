/**
 * Offer / Price Quality Validation
 * ------------------------------------------------------------------
 * Root cause this fixes: Gate 0 (product type) and Gate 1 (product
 * identity) both answer "is this the right PRODUCT?" — neither has any
 * concept of "is this listing actually a TRUSTWORTHY, comparable price?".
 * A candidate can pass both gates perfectly (matchConfidence: 1,
 * EXACT_MATCH) and still be junk: the reported live bug was
 *
 *   desertcart — "Samsung Galaxy S26 Ultra & && ()" — ₹5,389
 *
 * a listing whose title is barely more than punctuation and whose price
 * is ~4% of every other legitimate S26 Ultra offer (₹94,999–₹1,39,999).
 * Nothing before this stage has any way to say "no" to that — Gate 0/1
 * are identity gates, not trust gates — so it sailed through as
 * bestOffer and inflated savings by over ₹1,00,000.
 *
 * IDENTITY MATCH != PRICE/OFFER TRUST. This module is the missing check,
 * inserted as its own stage (see compareEngine.js) strictly AFTER
 * Gate 0/1/token-scoring and BEFORE eligibility/ranking:
 *
 *   Gate 0 (type) -> Gate 1 (identity) -> Gate 2/3 (specs) -> Gate 4
 *   (token scoring) -> **Offer/Price Quality** -> Eligibility -> Ranking
 *   -> Best Offer / Savings
 *
 * Deliberately a SEPARATE concept from hardReject (spec section 10): a
 * suspicious/invalid offer is never hardReject:true, never disappears
 * from results/possibleMatches, and stays fully inspectable/debuggable
 * (offer.offerQuality). It is excluded from bestOffer/bestDirectOffer/
 * savings only — see offerEligibility.js's isEligibleForComparison,
 * which now also checks usableForBestOffer alongside the existing
 * hardReject/confidence/price/availability/URL checks.
 *
 * Multi-signal, not a single threshold (spec section 4: "reject anything
 * 50% cheaper than the median" is explicitly rejected as too blunt — a
 * genuine 30–40% discount must survive). Each signal is independent and
 * explainable; a candidate is only "suspicious" once one or more actually
 * fires, never from a single opaque score cutoff.
 *
 * Category-agnostic (spec section 5): every signal here operates on
 * generic properties (price ratio vs. the OTHER already-identity-filtered
 * candidates' median, raw title punctuation/token shape, a small reused
 * condition/pricing-pattern keyword list) — nothing Samsung- or
 * phone-specific, nothing hardcoded to ₹5,389.
 */

const { normalizeTitle } = require("../utils/text");

// ---------------------------------------------------------------------
// Signal 1: title quality
// ---------------------------------------------------------------------

/**
 * A malformed title is detected on the RAW (pre-normalize) token shape —
 * normalizeTitle() strips punctuation to spaces, which would silently
 * erase exactly the "& && ()" garbage that makes this title suspicious
 * in the first place ("samsung galaxy s26 ultra" looks fine once
 * normalized). So this checks the fraction of whitespace-split raw
 * tokens that contain NO letter or digit at all — a listing built mostly
 * out of symbol noise, not a real product description.
 *
 * Deliberately NOT "reject short titles" (spec section 7) — a title with
 * few but meaningful tokens (e.g. "PS5 Pro") is fine; the signal is
 * specifically about tokens that carry no information at all.
 */
function assessTitleQuality(title) {
    if (!title || typeof title !== "string" || !title.trim()) {
        return { malformed: true, reason: "missing_title" };
    }
    const rawTokens = title.trim().split(/\s+/);
    const symbolOnlyTokens = rawTokens.filter((t) => !/[a-zA-Z0-9]/.test(t));
    const meaningfulTokenCount = rawTokens.length - symbolOnlyTokens.length;
    const symbolRatio = rawTokens.length > 0 ? symbolOnlyTokens.length / rawTokens.length : 1;

    if (meaningfulTokenCount < 2) return { malformed: true, reason: "malformed_title" };
    if (symbolRatio >= 0.3) return { malformed: true, reason: "malformed_title" };
    return { malformed: false, reason: null };
}

// ---------------------------------------------------------------------
// Signal 2: condition / pricing-pattern keywords
// ---------------------------------------------------------------------
// Deliberately small and NOT a duplicate of Gate 0's accessory/part list
// (spec section 8: "reuse existing product-type/accessory logic where
// possible" — an accessory/part title is already hardReject:true via
// productTypeClassifier.js LONG before an offer ever reaches this
// module, so re-checking "case"/"cover"/"motherboard" here would be
// redundant dead code). This list covers two PRICING/CONDITION concepts
// Gate 0 has no concept of at all — a listing can be a genuine,
// correctly-typed, correctly-identified product ad and still not be a
// full-price, condition-comparable listing.
//
// Split into two buckets, matched differently (bug fix — see Phase 2
// live-code audit): single words are matched with a \b...\b WORD-boundary
// regex, never a bare substring check. A plain `.includes()` on "emi"
// matches inside "pr-EMI-um" ("Premium Edition" — an extremely common,
// completely legitimate listing descriptor), and a plain `.includes()`
// on "used" matches inside "un-USED" ("Unused", "Refocused", "Housed",
// ...) — both would have wrongly excluded a perfectly legitimate,
// possibly cheapest offer from bestOffer eligibility. Multi-word/symbol
// phrases ("per month", "/month", "open box") don't have this problem —
// a phrase that long appearing coincidentally inside an unrelated word is
// not a realistic risk — so those stay simple substring checks.
const CONDITION_WORDS = ["refurbished", "renewed", "used"];
const CONDITION_PHRASES = ["pre owned", "preowned", "pre-owned", "open box", "openbox", "second hand", "secondhand"];
const INSTALLMENT_WORDS = ["emi", "installment", "installments", "subscription"];
const INSTALLMENT_PHRASES = ["per month", "/month", "down payment", "downpayment", "deposit only", "starting from", "starting at", "from rs", "from inr"];

// Matches `words` as whole words only (\b-bounded — never a bare substring
// of an unrelated word), then falls back to `phrases` as plain substring
// checks (safe at that length/shape). Returns the matched term, or null.
function findKeywordSignal(text, words, phrases) {
    for (const w of words) {
        if (new RegExp(`\\b${w}\\b`, "i").test(text)) return w;
    }
    for (const p of phrases) {
        if (text.includes(p)) return p;
    }
    return null;
}

// ---------------------------------------------------------------------
// Signal 3: price outlier vs. the identity-filtered comparable cluster
// ---------------------------------------------------------------------

/**
 * clusterPrices: prices of the OTHER already Gate-0/1-filtered, priced
 * candidates for the same product (never the raw/unfiltered Serper set —
 * spec section 6: "wrong-generation phones must already be removed").
 * Comparing against "OTHER" (not including this offer itself) so a
 * single extreme price can't drag its own reference point down.
 *
 * Uses a RATIO against the median, not a fixed rupee/dollar gap, so the
 * same logic works unmodified for a ₹500 accessory-priced phone or a
 * ₹1,50,000 GPU (spec section 5).
 *
 * Two severity bands, deliberately conservative so a genuine 30–40%
 * discount (ratio 0.6–0.7) never fires either one (spec section 4/TEST 4):
 *   - price_below_cluster:       0.3 <= ratio < 0.5  (mild — 50–70% below)
 *   - extreme_price_outlier:     ratio < 0.3          (extreme — 70%+ below)
 *
 * Statistical-confidence guard (spec section 6 / TEST 5, 6): with fewer
 * than 3 OTHER comparable priced offers, there isn't enough evidence to
 * call something an outlier outright — an extreme-looking LOW ratio is
 * downgraded to a soft "low_confidence" signal instead of the full
 * extreme_price_outlier signal, and a merely-mild ratio isn't flagged at
 * all. This never hard-rejects on price alone in low-data situations.
 *
 * Phase 7 — HIGH-side outlier detection (symmetric with the low side):
 *   - extreme_price_outlier:     ratio > 2.0           (extreme — 100%+ above)
 * Real-world root cause (Phase 5 live audit): a ~₹1,17,000–₹1,25,000 S26
 * Ultra cluster included a ₹2,47,934 "ubuy.co" listing (ratio ~2.0) that
 * passed every existing check (not cheap, not malformed, not
 * used/refurbished) and inflated savings by treating that price as the
 * legitimate ceiling. The high side needs its OWN support gate rather
 * than reusing the low side's >=3 rule outright: two other offers already
 * form a meaningful reference median for "is this 2x+ the going rate",
 * whereas a single other offer cannot (see hasHighSideSupport below).
 */
function assessPriceOutlier(offer, otherClusterOffers) {
    const otherPrices = otherClusterOffers.filter((o) => o !== offer && typeof o.price === "number" && o.price > 0).map((o) => o.price);

    if (typeof offer.price !== "number" || offer.price <= 0) {
        return { signal: null, clusterSize: otherPrices.length, median: null, ratio: null, priceOutlierDirection: null };
    }
    if (otherPrices.length === 0) {
        return { signal: null, clusterSize: 0, median: null, ratio: null, priceOutlierDirection: null };
    }

    const sorted = [...otherPrices].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    const ratio = offer.price / median;

    // Full statistical support (existing, low-side thresholds .3/.5 rely on
    // this) requires >= 3 OTHER comparable offers.
    const hasStatisticalSupport = sorted.length >= 3;

    // Phase 7: a SEPARATE, lighter-weight support gate specifically for the
    // high side. A single other offer isn't enough evidence that a price is
    // pathologically expensive (two data points can't establish a
    // "cluster") — but two others already can, since the ratio is being
    // measured against their median, not against a single reference point.
    // Deliberately looser than the low-side's >=3 gate: the low side already
    // has a softened low-confidence fallback for 1-2 comparators (below),
    // and asymmetric caution is intentional — see Phase 7 report section 5.
    const hasHighSideSupport = sorted.length >= 2;

    // LOW-SIDE OUTLIER DETECTION (existing, Phase 2/4 — unchanged)
    if (!hasStatisticalSupport) {
        if (ratio < 0.3) return { signal: "price_below_cluster_low_confidence", clusterSize: sorted.length, median, ratio, priceOutlierDirection: "low" };
        // Still allow a high-side check even when full (>=3) low-side
        // support is absent, as long as the lighter high-side gate (>=2) is
        // met — otherwise a 2-offer cluster with one wildly expensive
        // outlier would never be caught (TEST 2).
        if (hasHighSideSupport && ratio > 2.0) return { signal: "extreme_price_outlier", clusterSize: sorted.length, median, ratio, priceOutlierDirection: "high" };
        return { signal: null, clusterSize: sorted.length, median, ratio, priceOutlierDirection: null };
    }

    if (ratio < 0.3) return { signal: "extreme_price_outlier", clusterSize: sorted.length, median, ratio, priceOutlierDirection: "low" };
    if (ratio < 0.5) return { signal: "price_below_cluster", clusterSize: sorted.length, median, ratio, priceOutlierDirection: "low" };

    // HIGH-SIDE OUTLIER DETECTION (Phase 7 addition)
    if (ratio > 2.0) return { signal: "extreme_price_outlier", clusterSize: sorted.length, median, ratio, priceOutlierDirection: "high" };

    return { signal: null, clusterSize: sorted.length, median, ratio, priceOutlierDirection: null };
}

// ---------------------------------------------------------------------
// Combine signals -> offerQuality
// ---------------------------------------------------------------------

const SIGNAL_WEIGHTS = {
    malformed_title: 0.35,
    used_or_refurbished: 0.3,
    installment_or_partial_price: 0.4,
    extreme_price_outlier: 0.6,
    price_below_cluster: 0.25,
    price_below_cluster_low_confidence: 0.15,
};

/**
 * evaluateOfferQuality(offer, otherIdentityValidOffers) -> offerQuality
 *
 * otherIdentityValidOffers: the full set of Gate-0/1-passing (hardReject
 * false), priced candidates for this product — used ONLY to build the
 * price cluster (this offer itself is excluded from its own comparison
 * inside assessPriceOutlier).
 *
 * Returns { status: "trusted"|"suspicious"|"invalid", score: 0..1,
 *           reasons: string[], usableForBestOffer: boolean }
 *
 * status is decided from discrete reasons, not a single opaque score
 * cutoff (spec section 4's "do not use a simplistic rule" applies to the
 * whole decision, not just the price check):
 *   - "invalid": the offer isn't even usable as a comparison point at all
 *     (no real price, or no real title) — nothing else matters.
 *   - "suspicious": has a usable price+title, but one or more trust
 *     signals fired.
 *   - "trusted": no signals fired at all.
 * usableForBestOffer is true only for "trusted" — see the desertcart
 * example, which is "suspicious" (not "invalid") per spec section 9's
 * own worked example, since it does have a parseable price and a title.
 */
function evaluateOfferQuality(offer, otherIdentityValidOffers) {
    if (typeof offer.price !== "number" || !(offer.price > 0)) {
        return { status: "invalid", score: 0, reasons: ["missing_or_invalid_price"], usableForBestOffer: false };
    }
    if (!offer.title || typeof offer.title !== "string" || !offer.title.trim()) {
        return { status: "invalid", score: 0, reasons: ["missing_title"], usableForBestOffer: false };
    }

    const reasons = [];
    let score = 1;

    const titleCheck = assessTitleQuality(offer.title);
    if (titleCheck.malformed && titleCheck.reason !== "missing_title") {
        reasons.push("malformed_title");
        score -= SIGNAL_WEIGHTS.malformed_title;
    }

    const normalized = normalizeTitle(offer.title);
    if (findKeywordSignal(normalized, CONDITION_WORDS, CONDITION_PHRASES)) {
        reasons.push("used_or_refurbished");
        score -= SIGNAL_WEIGHTS.used_or_refurbished;
    }
    // Installment phrasing ("EMI", "/month") often includes a symbol
    // (₹, /) normalizeTitle would strip, so also check the raw lowercase
    // title, not only the normalized form.
    const rawLower = offer.title.toLowerCase();
    if (findKeywordSignal(normalized, INSTALLMENT_WORDS, INSTALLMENT_PHRASES) || findKeywordSignal(rawLower, INSTALLMENT_WORDS, INSTALLMENT_PHRASES)) {
        reasons.push("installment_or_partial_price");
        score -= SIGNAL_WEIGHTS.installment_or_partial_price;
    }

    const priceCheck = assessPriceOutlier(offer, otherIdentityValidOffers);
    if (priceCheck.signal) {
        reasons.push(priceCheck.signal);
        score -= SIGNAL_WEIGHTS[priceCheck.signal];
    }

    score = Math.max(0, Math.min(1, score));
    const status = reasons.length === 0 ? "trusted" : "suspicious";

    // Phase 7: surface WHICH side of the cluster a price-outlier reason
    // came from (reasons[] itself stays the same string either direction —
    // "extreme_price_outlier" — so this doesn't change the existing signal
    // vocabulary/weights, it's purely additive diagnostic metadata for
    // logging/debugging, e.g. compareEngine.js's OFFER QUALITY log line).
    return {
        status,
        score: Number(score.toFixed(2)),
        reasons,
        usableForBestOffer: status === "trusted",
        priceOutlierDirection: priceCheck.priceOutlierDirection || null,
    };
}

/**
 * Batch helper — attaches offerQuality to every NON-hard-rejected offer
 * (a hard-rejected offer is already fully excluded upstream by Gate 0/1;
 * evaluating its price quality would be meaningless work). Never mutates
 * the input. The price cluster for every offer is built from the SAME
 * fixed set (every hardReject:false, priced offer in this batch) — order
 * of evaluation doesn't change any offer's own outlier assessment.
 */
function attachOfferQuality(scoredOffers) {
    const identityValidPriced = scoredOffers.filter((o) => !o.hardReject && typeof o.price === "number" && o.price > 0);

    return scoredOffers.map((offer) => {
        if (offer.hardReject) return offer;
        const offerQuality = evaluateOfferQuality(offer, identityValidPriced);
        return {
            ...offer,
            offerQuality,
            offerQualityScore: offerQuality.score,
            offerQualityReasons: offerQuality.reasons,
            usableForBestOffer: offerQuality.usableForBestOffer,
        };
    });
}

module.exports = { evaluateOfferQuality, attachOfferQuality, assessTitleQuality, assessPriceOutlier };