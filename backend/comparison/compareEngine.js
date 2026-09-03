/**
 * Compare Engine
 * ------------------------------------------------------------------
 * The orchestrator: composes productIdentity -> productNormalizer ->
 * (candidate collection via store adapters) -> variantMatcher ->
 * offerDeduplicator -> urlResolver (bounded secondary resolution) ->
 * offerRanker, and returns an engine-level result. Deliberately does
 * NOT shape the response into the frontend/API contract — that
 * adaptation happens one layer up (services/compareService.js), so
 * this module can be reused by a future API version without dragging
 * frontend-shape concerns into the engine itself.
 *
 * RULE 1 (spec Part 40): exact product correctness over result count.
 * RULE 5: one provider failure never destroys the whole comparison —
 * see queryActiveAdapters below, which uses Promise.allSettled.
 *
 * Extracted from services/compareService.js's runComparison() (V1)
 * with no behavior change — compareService.js now delegates here and
 * only owns request scraping, response shaping, and the public API.
 */

const { ACTIVE_ADAPTERS } = require("../services/stores");
const { canonicalizeProduct, extractCanonicalProduct } = require("./productIdentity");
const { buildSearchQuery } = require("./productNormalizer");
const { planQueries } = require("./searchPlanner");
const { collectCandidates, runAdaptersForQuery } = require("./candidateCollector");
const { scoreOffers, confidenceLabel, matchOffer } = require("./variantMatcher");
const { deduplicateByMerchant, deduplicateByUrl } = require("./offerDeduplicator");
const { planTrustedCoverageQueries } = require("./trustedRetailerCoverage");
const { buildComparison, MATCH_CONFIDENCE_THRESHOLD, BEST_OFFER_MATCH_THRESHOLD } = require("./offerRanker");
const { attachQualityScores } = require("./qualityScorer");
const { attachOfferQuality } = require("./offerQuality");
const { resolveDirectMerchantUrlDetailed, isEnabled: isMerchantResolverEnabled } = require("./urlResolver");
const { CompareError } = require("../utils/errors");

// Feature flag (spec Part 35): default OFF. Off = exactly one search query,
// byte-for-byte the same pipeline this engine has always run. On = the
// search planner may fan out to multiple targeted queries (searchPlanner.js)
// for broader, still-bounded candidate coverage. Kept here as a single
// source of truth rather than checked ad hoc at each call site.
function isV2Enabled() {
    return (process.env.COMPARISON_ENGINE_V2 || "").trim().toLowerCase() === "true";
}

// Thin wrapper: plans queries (1 by default, up to searchPlanner.MAX_QUERIES
// under the V2 flag) and collects candidates for them. Error semantics
// (CONFIGURATION_ERROR, PROVIDER_FAILURE) are owned by candidateCollector.js.
//
// Phase 8.1 — bounded, ADAPTIVE trusted-retailer coverage (spec Sections
// 1-11): after the general query(ies) above complete, inspect which
// category-relevant trusted retailers are already represented and issue
// only a small, bounded number of supplemental queries for the ones
// missing (trustedRetailerCoverage.js owns that decision entirely — this
// function only runs the queries it's handed and merges results). One
// failing supplemental query never affects the others or the general
// result (Promise.allSettled, same RULE 5 guarantee as candidateCollector.js).
// Every supplemental candidate is merged into the SAME rawOffers array the
// general query produced and flows through the IDENTICAL downstream
// pipeline in runComparison below (dedup -> scoreOffers -> offerQuality ->
// eligibility -> ranking) — nothing here special-cases a "trusted" offer's
// matching or quality (spec Section 9: trust never grants a matching
// shortcut).
async function queryActiveAdapters(canonicalProduct, query) {
    const multiQuery = isV2Enabled();
    const queries = multiQuery ? planQueries(canonicalProduct, { multiQuery: true }) : [query];
    console.log(`[COMPARE] Search plan: ${queries.length} quer${queries.length === 1 ? "y" : "ies"}${multiQuery ? " (V2)" : ""} — ${queries.join(" | ")}`);
    const general = await collectCandidates(queries, { useCache: multiQuery });

    const { queries: coverageQueries, targetedRetailers } = planTrustedCoverageQueries(
        canonicalProduct,
        query,
        general.offers
    );

    const coverageDiagnostics = { targetedRetailers, queriesRun: coverageQueries, succeeded: [], failed: [] };

    if (coverageQueries.length === 0) {
        console.log("[COMPARE] Trusted coverage: no supplemental queries needed (already covered, disabled, or category not applicable)");
        return { offers: general.offers, diagnostics: { ...general.diagnostics, trustedCoverage: coverageDiagnostics } };
    }

    console.log(`[COMPARE] Trusted coverage: ${coverageQueries.length} supplemental quer${coverageQueries.length === 1 ? "y" : "ies"} for ${targetedRetailers.join(", ")}`);
    const settled = await Promise.allSettled(coverageQueries.map((q) => runAdaptersForQuery(q)));

    const supplementalOffers = [];
    settled.forEach((result, i) => {
        const retailerKey = targetedRetailers[i];
        if (result.status === "fulfilled") {
            supplementalOffers.push(...result.value.offers);
            coverageDiagnostics.succeeded.push(retailerKey);
        } else {
            coverageDiagnostics.failed.push(retailerKey);
            console.log(`[COMPARE] Trusted coverage query failed for ${retailerKey}: ${result.reason?.message || "error"}`);
        }
    });

    // Same exact-URL dedup already used to merge multi-query general results
    // (offerDeduplicator.js) — no second dedup algorithm (spec Section 10).
    const mergedOffers = supplementalOffers.length > 0
        ? deduplicateByUrl([...general.offers, ...supplementalOffers])
        : general.offers;

    if (supplementalOffers.length > 0) {
        console.log(`[COMPARE] Trusted coverage: +${supplementalOffers.length} raw candidate(s), +${mergedOffers.length - general.offers.length} new after dedup`);
    }

    return { offers: mergedOffers, diagnostics: { ...general.diagnostics, trustedCoverage: coverageDiagnostics } };
}

// Phase 3 (Merchant URL Resolution): how many Google-redirect offers we're
// willing to spend a secondary Serper search on, per comparison. Bounded
// and configurable (spec Phase 5) rather than a bare hardcoded constant —
// operators can tune it without a code change, but it defaults to the
// same conservative value this engine has always used.
function maxResolutionAttempts() {
    const raw = Number(process.env.MERCHANT_URL_RESOLVER_MAX_OFFERS);
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 5;
}

// Bounded, cached, allowlist-validated attempt to upgrade a Google Shopping
// redirect to a real merchant URL for a small set of the most-confident
// redirect-only offers — never one resolution request per result. Disabled
// by default (ENABLE_MERCHANT_URL_RESOLVER); a no-op until explicitly
// enabled and verified against the live API. Mutates the offer objects it
// upgrades in place (offers array is already this request's own copy).
//
// Phase 3 precision fix — candidate selection now follows the spec's own
// priority list exactly (Phase 5): only offers that are simultaneously
// (1) confident matches, (2) trusted offerQuality, (3) validly priced,
// (4) not hard-rejected — i.e. exactly the pool that could ever actually
// BECOME bestOffer — are even considered, sorted by retailer tier then
// price ascending so the resolver budget is spent first on the offer(s)
// most likely to actually need a direct URL (the true cheapest eligible
// price, which is exactly where "bestDirectOffer: null" hurts the most).
// This requires offerQuality to already be computed — see runComparison's
// call order below, which now runs attachOfferQuality BEFORE this.
async function attemptSecondaryUrlResolution(scoredOffers, canonicalProduct, query) {
    if (!isMerchantResolverEnabled()) return;

    const TIER_RANK = { major_retailer: 0, known_retailer: 1, other_seller: 2 };
    const candidates = scoredOffers
        .filter(
            (o) =>
                o._isGoogleRedirectUrl &&
                !o.hardReject &&
                typeof o.price === "number" &&
                o.price > 0 &&
                o.matchConfidence >= BEST_OFFER_MATCH_THRESHOLD &&
                (!o.offerQuality || o.offerQuality.status === "trusted")
        )
        .sort((a, b) => {
            const tierDiff = (TIER_RANK[a._retailerTier] ?? 2) - (TIER_RANK[b._retailerTier] ?? 2);
            if (tierDiff !== 0) return tierDiff;
            return a.price - b.price;
        })
        .slice(0, maxResolutionAttempts());

    await Promise.all(
        candidates.map(async (offer) => {
            offer._urlResolutionStatus = "failed"; // default; overwritten below on success
            try {
                // Phase 15 (Offer-to-Resolved-URL Identity Validation): the
                // canonicalProduct-only check below only confirms the resolved
                // candidate matches what the user asked for in general — it
                // never confirms the candidate matches what THIS SPECIFIC
                // offer's own title already promised (e.g. a live-verified
                // failure: offer.title said "Apple iPhone 17 512GB" but
                // canonicalProduct never mentioned storage at all, because the
                // user's query was just "iPhone 17" — so a resolved 256GB page
                // passed canonicalProduct validation unchallenged). Reuses
                // extractCanonicalProduct() (already used to parse the user's
                // OWN pasted title/URL in canonicalizeProduct above) to parse
                // this offer's title into the same structured shape, then
                // reuses computeMatchConfidence()/matchOffer() completely
                // unmodified — no new matching logic, no change to
                // urlResolver.js's matchValidator contract (still
                // text => boolean). Because computeMatchConfidence only ever
                // compares an attribute the SOURCE side actually has (see
                // productMatcher.js's storage/ram/color/model-code checks),
                // a generic offer title (offerIdentity.storage/ram/color all
                // null) imposes no extra constraint here — "absence of signal
                // is never a conflict" is preserved without any special-casing.
                const offerIdentity = extractCanonicalProduct(offer.title);
                const resolved = await resolveDirectMerchantUrlDetailed(offer.store, query, {
                    matchValidator: (text) =>
                        matchOffer(canonicalProduct, text).confidence >= MATCH_CONFIDENCE_THRESHOLD &&
                        matchOffer(offerIdentity, text).confidence >= MATCH_CONFIDENCE_THRESHOLD,
                });
                if (resolved) {
                    offer.productUrl = resolved.url;
                    offer._isGoogleRedirectUrl = false;
                    offer._merchantUrlSource = "merchant_url_resolver";
                    offer._urlConfidenceLevel = resolved.confidence; // "high" | "medium"
                    offer._urlResolutionStatus = "resolved";
                    console.log(`[COMPARE] Resolved direct URL for ${offer.store} (confidence: ${resolved.confidence})`);
                } else {
                    console.log(`[COMPARE] URL resolution found nothing usable for ${offer.store} — keeping Google Shopping fallback`);
                }
            } catch (err) {
                // Never let one merchant's resolution failure affect the
                // comparison itself (spec Phase 13) — the offer keeps its
                // original Google Shopping URL and stays fully eligible
                // for bestOffer (just not bestDirectOffer).
                console.log(`[COMPARE] URL resolution error for ${offer.store}: ${err.message}`);
            }
        })
    );
}

/**
 * Runs the full comparison pipeline for one product and returns an
 * engine-level result (not yet shaped for the frontend/API contract —
 * see compareService.js's toFrontendOffer for that mapping).
 *
 * sourceProduct: { name, brand?, productName?, model?, storage?, ram?,
 *                  color?, image?, productId? } — a URL-scraped title, a
 *                  typed query, or an AI Find structured object.
 *
 * Returns { canonicalProduct, query, offers, possibleMatches, bestOffer,
 *           bestDirectOffer, savings, diagnostics }
 */
async function runComparison(sourceProduct, { sourceHost = null } = {}) {
    const debug = process.env.DEBUG_COMPARE === "true";

    // PRODUCT IDENTIFICATION -> CANONICAL PRODUCT PROFILE
    const canonicalProduct = canonicalizeProduct(sourceProduct);
    const query = buildSearchQuery(canonicalProduct);

    console.log("[COMPARE] Canonical product:", JSON.stringify({
        name: canonicalProduct.name,
        brand: canonicalProduct.brand,
        model: canonicalProduct.model || canonicalProduct.productName,
        storage: canonicalProduct.storage,
        // Phase 5 fix: this line previously omitted `ram` entirely, even
        // though canonicalizeProduct/extractCanonicalProduct has always
        // populated it (via extractRamAndStorage) when the query mentions
        // it — that omission was the entire reason a prior live review
        // mistakenly concluded RAM extraction was "not wired in" at all.
        // It always was; only this diagnostic line didn't show it.
        ram: canonicalProduct.ram,
        color: canonicalProduct.color,
    }));
    console.log(`[COMPARE] Search query: ${query}`);
    console.log(`[COMPARE] Active adapters: ${ACTIVE_ADAPTERS.map((a) => a.id).join(", ") || "none"}`);

    if (!query) {
        throw new CompareError("Couldn't determine what to search for. Try a more specific product.", 400, "PRODUCT_NOT_IDENTIFIED");
    }

    // SEARCH STRATEGY -> CANDIDATE OFFERS (searchPlanner.js + candidateCollector.js;
    // single query unless COMPARISON_ENGINE_V2 is enabled)
    const { offers: rawOffers, diagnostics } = await queryActiveAdapters(canonicalProduct, query);
    console.log(`[COMPARE] RAW SERPER RESULTS: ${rawOffers.length}`);
    console.log(`[COMPARE] NORMALIZED OFFERS: ${rawOffers.length}`);

    if (rawOffers.length === 0) {
        throw new CompareError(
            "No comparable offers found for this product yet. Try a more specific product name or link.",
            404,
            "NO_MATCHING_OFFERS"
        );
    }

    // DEDUPLICATION
    const dedupedOffers = deduplicateByMerchant(rawOffers);
    console.log(`[COMPARE] UNIQUE MERCHANTS: ${dedupedOffers.length} (${dedupedOffers.map((o) => o.store).join(", ")})`);

    // EXACT PRODUCT / VARIANT MATCHING
    const scored = scoreOffers(canonicalProduct, dedupedOffers);
    console.log(`[COMPARE] MATCHING CANDIDATES: ${scored.length}`);

    // OFFER / PRICE QUALITY VALIDATION (Phase 2 precision fix, Gate 2) —
    // a DIFFERENT question from matchConfidence/qualityScore below: "is
    // this listing's PRICE actually trustworthy/comparable?", not "is it
    // the right product" or "how good is this listing overall". Computed
    // against the identity-filtered candidate set (Gate 0/1 already
    // removed wrong-type/wrong-generation/wrong-variant offers by this
    // point — spec section 6 requires the price cluster be built from
    // THIS set, never raw/unfiltered Serper results). Unlike qualityScore,
    // this DOES feed into eligibility — see offerEligibility.js's
    // isEligibleForComparison — because an untrustworthy price must never
    // win bestOffer/corrupt savings just for being the lowest number.
    //
    // Deliberately computed BEFORE URL resolution (Phase 3 precision fix,
    // Merchant URL Resolution): the resolver must prioritize spending its
    // bounded request budget on trusted, confident offers (spec Phase 5)
    // — that prioritization is impossible unless offerQuality already
    // exists by the time attemptSecondaryUrlResolution runs its candidate
    // filter below.
    const offerQualityScored = attachOfferQuality(scored);

    // URL RESOLUTION (secondary pass — upgrade redirects where possible,
    // bounded to a small number of the most useful candidates; see
    // attemptSecondaryUrlResolution's own doc comment for the exact
    // priority order). A DIFFERENT concern from matching/quality above —
    // see urlResolver.js: a failed resolution never removes an offer or
    // changes matchConfidence/matchDecision/hardReject/offerQuality, it
    // only leaves the offer on its original, honestly-labeled Google
    // Shopping URL.
    await attemptSecondaryUrlResolution(offerQualityScored, canonicalProduct, query);

    // QUALITY SCORING (spec Part 18) — additive metadata alongside
    // matchConfidence; never affects ranking/bestOffer selection below,
    // which is owned entirely by offerRanker.js. Computed after URL
    // resolution so an upgraded direct URL (and its confidence tier) is
    // reflected in the score.
    const qualityScored = attachQualityScores(offerQualityScored);

    if (debug) {
        scored.forEach((o) => {
            console.log(`[COMPARE] Matched: ${o.store} -> "${o.title}" confidence=${o.matchConfidence} (${o.matchLabel}) — ${o.matchReason}`);
        });
    }

    // OFFER VALIDATION -> RANKING
    // "Full internet" pool — the existing, unchanged Phase 1-7 behavior.
    // Every consumer that only reads offers/bestOffer/etc keeps working
    // exactly as before Phase 8 (backward compatibility, spec Section 9).
    const { offers, possibleMatches, rejectedOffers, bestOffer, bestDirectOffer, savings } = buildComparison(qualityScored);
    console.log(`[COMPARE] CONFIDENT MATCHES: ${offers.length} (${offers.map((o) => o.store).join(", ")})`);
    console.log(`[COMPARE] POSSIBLE MATCHES: ${possibleMatches.length} (${possibleMatches.map((o) => o.store).join(", ")})`);
    console.log(`[COMPARE] FINAL OFFERS: ${offers.length + possibleMatches.length}`);

    // Phase 8 — TRUSTED RETAILER pool. Deliberately reuses buildComparison()
    // unmodified against a pre-filtered subset of the SAME qualityScored
    // array, rather than duplicating any matching/eligibility/ranking
    // logic (spec Principle 7: "Do not duplicate the matching engine for
    // trusted and full-internet modes"). Every Gate 0/1 rejection, Phase 7
    // outlier exclusion, and offerQuality/eligibility rule that already ran
    // above applies identically here — trusted filtering is strictly a
    // narrower SELECTION on top of the already-validated candidate pool,
    // never a separate decision about whether an offer is the right
    // product (spec Section 10).
    const trustedScored = qualityScored.filter((o) => o._isTrustedRetailer === true);
    const trustedComparison = buildComparison(trustedScored);
    console.log(`[COMPARE] TRUSTED RETAILER OFFERS: ${trustedComparison.offers.length} (${trustedComparison.offers.map((o) => o.store).join(", ")})`);
    if (trustedComparison.bestOffer) {
        console.log(`[COMPARE] Best TRUSTED offer: ${trustedComparison.bestOffer.store} ${trustedComparison.bestOffer.currency} ${trustedComparison.bestOffer.price}`);
    } else {
        console.log("[COMPARE] Best TRUSTED offer: none (no eligible offer from an enabled trusted retailer)");
    }

    // Diagnostic logging for every hard-rejected offer, so it's always
    // possible to understand WHY a listing never reached the results
    // (never logs secrets; only merchant/title/reason). Covers BOTH gates:
    // Gate 0 product-type conflicts (spec Step 17) and Gate 1 product-
    // identity conflicts (generation/model-number/variant mismatch, added
    // in the Phase 2 precision fix) — o.matchIssue distinguishes them.
    if (rejectedOffers.length > 0) {
        console.log(`[COMPARE] REJECTED (identity conflict): ${rejectedOffers.length}`);
        rejectedOffers.forEach((o) => {
            const reasonCode = (o.matchIssue || "product_type_conflict").toUpperCase();
            console.log(
                `[COMPARE] PRODUCT IDENTITY:\n` +
                `  Requested: ${canonicalProduct.name || canonicalProduct.productName || ""}\n` +
                `  Candidate: ${o.title}\n` +
                `  Merchant: ${o.store}\n` +
                `  Decision: HARD_REJECT\n` +
                `  Reason: ${reasonCode}` +
                (reasonCode === "PRODUCT_TYPE_CONFLICT" ? `\n  Requested type: ${o.requestedProductType}\n  Candidate type: ${o.candidateProductType}` : "")
            );
        });
    }

    if (debug && possibleMatches.length > 0) {
        console.log(`[COMPARE] Rejected-from-best-price reasons: ${possibleMatches.map((o) => `${o.store}(${o.matchConfidence}: ${o.matchReason})`).join(" | ")}`);
    }

    // Diagnostic logging for every offer flagged by the NEW Offer/Price
    // Quality gate (spec section 14). Distinct from the identity-conflict
    // log above: these offers are NOT hard-rejected, still fully present
    // in offers/possibleMatches — this only explains why one was excluded
    // from bestOffer/bestDirectOffer/savings eligibility. Concise, one
    // line per offer, only for offers actually flagged (never spams every
    // internal calculation).
    const flaggedOffers = offerQualityScored.filter((o) => o.offerQuality && o.offerQuality.status !== "trusted");
    flaggedOffers.forEach((o) => {
        // Phase 7: when the flag is a price-outlier reason, print which
        // side of the cluster it came from (e.g. a ₹2,47,934 offer amid a
        // ₹1,17k–₹1,25k cluster is a HIGH-side outlier, not a suspiciously
        // cheap one) — same reason string, clearer diagnostic.
        const direction = o.offerQuality.priceOutlierDirection;
        const directionSuffix = direction ? ` [${direction.toUpperCase()}-SIDE]` : "";
        console.log(
            `[COMPARE] OFFER QUALITY:\n` +
            `  Merchant: ${o.store}\n` +
            `  Candidate: ${o.title}\n` +
            `  Price: ${o.currency || "INR"} ${o.price}\n` +
            `  Decision: ${o.offerQuality.status.toUpperCase()}\n` +
            `  Usable for best offer: ${o.offerQuality.usableForBestOffer}\n` +
            `  Reasons: ${o.offerQuality.reasons.map((r) => r.toUpperCase()).join(", ")}${directionSuffix}`
        );
    });

    if (bestOffer) {
        console.log(`[COMPARE] Best offer: ${bestOffer.store} ${bestOffer.currency} ${bestOffer.price}`);
    } else {
        console.log("[COMPARE] Best offer: none (no confidently-matched, in-stock, priced offer)");
    }
    if (bestDirectOffer) {
        console.log(`[COMPARE] Best direct-URL offer: ${bestDirectOffer.store} ${bestDirectOffer.currency} ${bestDirectOffer.price}`);
    } else {
        console.log("[COMPARE] Best direct-URL offer: none (no eligible offer has a verified non-Google URL)");
    }

    return {
        canonicalProduct,
        query,
        offers,
        possibleMatches,
        rejectedOffers,
        bestOffer,
        bestDirectOffer,
        savings,
        diagnostics,
        // Phase 8 — additive, does not change any field above.
        trusted: {
            offers: trustedComparison.offers,
            possibleMatches: trustedComparison.possibleMatches,
            bestOffer: trustedComparison.bestOffer,
            bestDirectOffer: trustedComparison.bestDirectOffer,
            savings: trustedComparison.savings,
        },
    };
}

module.exports = { runComparison, queryActiveAdapters, confidenceLabel };