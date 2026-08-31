/**
 * Product Matcher
 * ------------------------------------------------------------------
 * Decides how confident we are that a store listing is actually the
 * product the user asked about, rather than just "the title looks
 * similar". Confidence drives whether an offer counts toward the best
 * price (priceComparator.js) or gets shown separately as a
 * "Possible match".
 *
 * V2 note: the underlying token/text helpers now live in
 * ../utils/text.js and ../utils/numbers.js (single source of truth,
 * shared with the rest of the comparison engine). This file keeps its
 * original exports for backward compatibility with existing callers
 * and tests.
 */

const { normalizeTitle, tokenize, jaccardOverlap, looksLikeAccessory, detectColor } = require("../utils/text");
const {
    extractStorageTokens,
    extractRamAndStorage,
    extractModelNumberTokens,
    extractPlainModelNumbers,
    extractVariantSuffixes,
    extractAlnumModelCodes,
    leadingDigitRun,
    leadingLetterPrefix,
} = require("../utils/numbers");
const { classifyProductType, detectProductTypeConflict } = require("../comparison/productTypeClassifier");

/**
 * evaluateProductIdentity — the NEW first gate, added to fix the
 * "motherboard scored confidence=1.0" bug. Decides whether the candidate
 * even represents the same KIND of thing as what was requested, before
 * any brand/model/variant token scoring runs at all. See
 * comparison/productTypeClassifier.js for the classification/conflict
 * rules themselves — this function just calls it with the right text.
 *
 * Returns { hardReject: boolean, reason: string|null, requestedType,
 * candidateType } — requestedType/candidateType are exposed so callers
 * (variantMatcher.js, logging) can report WHY without re-classifying.
 */
function evaluateProductIdentity(sourceProduct, candidateTitle) {
    const sourceName = sourceProduct.name || [sourceProduct.brand, sourceProduct.productName].filter(Boolean).join(" ");
    const requestedClass = classifyProductType(sourceName);
    const candidateClass = classifyProductType(candidateTitle);
    const { conflict, reason } = detectProductTypeConflict(requestedClass, candidateClass);

    return {
        hardReject: conflict,
        reason: conflict ? `PRODUCT_TYPE_CONFLICT: ${reason}` : null,
        requestedType: requestedClass.type,
        candidateType: candidateClass.type,
    };
}

/**
 * evaluateVariantIdentity — GATE 1, added in the Phase 2 precision fix.
 * Runs immediately after Gate 0 (product TYPE) and before any token-
 * overlap scoring. Gate 0 answers "is this even the same KIND of thing?"
 * (phone vs motherboard); Gate 1 answers "is this the same MODEL?" (S26
 * Ultra vs S25 Ultra, S26 Ultra vs S26+, 990 Pro vs 990 EVO).
 *
 * Root cause this fixes: previously, generation/model-number/variant
 * mismatches only capped the numeric score (score = Math.min(score, 0.2))
 * partway through computeMatchConfidence — but brand/model bonuses added
 * BEFORE the cap and storage/RAM/color bonuses added AFTER it could push
 * a "capped" score back up (e.g. 0.2 -> 0.35 once a coincidentally-
 * matching storage figure added +0.1 and RAM added +0.05). And because
 * offerEligibility.isEligibleForResults only ever checked `hardReject`,
 * ANY non-zero, non-hardReject confidence — even 0.2 UNCERTAIN — still
 * flowed into `results`/`possibleMatches`/final offers. That's exactly
 * how "Samsung Galaxy S25/S24/S21 Ultra" and "Samsung Galaxy A56" kept
 * reappearing as "possible matches" for an S26 Ultra request despite
 * being a different generation/family entirely.
 *
 * Fix: decide model identity FIRST, as a boolean gate, the same way
 * Gate 0 already does for product type. A genuine identity conflict
 * (different generation, different model number, different variant/
 * family suffix) now hard-rejects the candidate outright — it can never
 * be rescued by a later storage/RAM/color coincidence, and (via the
 * existing offerEligibility/offerRanker machinery, unchanged) can never
 * reach results, possibleMatches, bestOffer, bestDirectOffer, or savings.
 *
 * Deliberately NOT touched here: storage/RAM/color differences. Those
 * remain Gate 3 soft-demotion signals (see computeMatchConfidence below)
 * because a storage/RAM/color difference does not mean "different
 * product" — it means "same product, different SKU", which is exactly
 * the "possible match" concept possibleMatches exists for.
 *
 * Returns { hardReject, reason, primaryIssue } — primaryIssue matches the
 * existing vocabulary ("generation_mismatch" | "model_number_mismatch" |
 * "variant_mismatch") so downstream consumers/tests that already key off
 * these strings keep working unchanged.
 */
// Phase 14 (Wrong-Variant Root Cause Fix) — Fix D helper: groups
// letter-first model tokens ("r530", "buds3") by their leading letter
// prefix ("r" -> {530}, "buds" -> {3}) so a genuine conflict on one
// identifier family (SM-R530 vs SM-R420) can be detected even when a
// DIFFERENT shared token on the same candidate ("buds3") would otherwise
// satisfy the old "some overlap" check and mask it.
function buildLetterPrefixMap(tokens) {
    const map = new Map();
    for (const tok of tokens) {
        const prefix = leadingLetterPrefix(tok);
        if (!prefix) continue;
        const numMatch = tok.match(/\d+/);
        if (!numMatch) continue;
        if (!map.has(prefix)) map.set(prefix, new Set());
        map.get(prefix).add(numMatch[0]);
    }
    return map;
}

// Phase 14 — Fix B helper: groups bare numbers and digit-first alnum codes
// by their leading digit run ("17" -> {"17"}, "17e" -> {"17e"}) so "17"
// (bare) vs "17e" (suffixed) are compared as the same numeric family even
// though the full token strings differ, and "15amn8" vs "15iru8" are
// compared as whole codes within the same "15" family.
function buildDigitGroupMap(tokens) {
    const map = new Map();
    for (const tok of tokens) {
        const digitRun = leadingDigitRun(tok);
        if (!digitRun) continue;
        if (!map.has(digitRun)) map.set(digitRun, new Set());
        map.get(digitRun).add(tok);
    }
    return map;
}

function evaluateVariantIdentity(sourceProduct, candidateTitle) {
    const sourceName = sourceProduct.name || [sourceProduct.brand, sourceProduct.productName].filter(Boolean).join(" ");
    const sourceIdentityText = [sourceProduct.model, sourceProduct.productName, sourceName].filter(Boolean).join(" ");

    // 1) Generation / letter+digit model tokens ("s26" vs "s25", "m4" vs
    //    "m3", "ps5" vs "ps4"). Only fires when BOTH sides actually have a
    //    token to compare — absence of signal is never treated as conflict
    //    (spec Step 3), only a genuine mismatch is.
    const sourceVersionTokens = extractModelNumberTokens(sourceIdentityText);
    const candidateVersionTokens = extractModelNumberTokens(candidateTitle);
    if (
        sourceVersionTokens.length > 0 &&
        candidateVersionTokens.length > 0 &&
        !sourceVersionTokens.some((t) => candidateVersionTokens.includes(t))
    ) {
        return {
            hardReject: true,
            primaryIssue: "generation_mismatch",
            reason: `GENERATION_MISMATCH: requested [${sourceVersionTokens.join(",")}], candidate [${candidateVersionTokens.join(",")}]`,
        };
    }

    // 1b) Phase 14 Fix D — even when SOME letter-first token overlaps (both
    //     mention "buds3"), a DIFFERENT explicit identifier sharing the same
    //     family prefix (e.g. "r530" vs "r420" in "SM-R530"/"SM-R420") is a
    //     genuine SKU conflict that the "some" check in (1) never catches,
    //     because it only requires ONE shared token anywhere in the list —
    //     it never checks whether an aligned pair with the same prefix
    //     actually agrees. Deliberately keyed on "at least one common
    //     prefix disagrees", not "any token differs" — a prefix with no
    //     candidate-side counterpart is not evidence of anything (absence
    //     of signal is never a conflict, same principle as (1)/(2) above).
    const sourceLetterPrefixMap = buildLetterPrefixMap(sourceVersionTokens);
    const candidateLetterPrefixMap = buildLetterPrefixMap(candidateVersionTokens);
    for (const [prefix, sourceNums] of sourceLetterPrefixMap) {
        const candidateNums = candidateLetterPrefixMap.get(prefix);
        if (!candidateNums) continue;
        const agrees = [...sourceNums].some((n) => candidateNums.has(n));
        if (!agrees) {
            return {
                hardReject: true,
                primaryIssue: "model_number_mismatch",
                reason: `MODEL_NUMBER_MISMATCH: requested ${prefix}[${[...sourceNums].join(",")}], candidate ${prefix}[${[...candidateNums].join(",")}]`,
            };
        }
    }

    // 2) Bare model numbers with no unit attached ("15" in "iPhone 15",
    //    "990" in "990 Pro", "5070" in "RTX 5070") — the same idea as (1)
    //    but for model numbers that aren't glued to a letter prefix.
    const sourceModelNumbers = extractPlainModelNumbers([sourceProduct.model, sourceProduct.productName].filter(Boolean).join(" "));
    const candidateModelNumbers = extractPlainModelNumbers(candidateTitle);
    if (
        sourceModelNumbers.length > 0 &&
        candidateModelNumbers.length > 0 &&
        !sourceModelNumbers.some((n) => candidateModelNumbers.includes(n))
    ) {
        return {
            hardReject: true,
            primaryIssue: "model_number_mismatch",
            reason: `MODEL_NUMBER_MISMATCH: requested [${sourceModelNumbers.join(",")}], candidate [${candidateModelNumbers.join(",")}]`,
        };
    }

    // 2b) Phase 14 Fix B — digit-first alphanumeric sub-model codes that
    //     (1) and (2) can never see, because \b never falls between a digit
    //     and an immediately-following letter ("17e", "15amn8"). Grouping
    //     by leading digit run lets a bare "17" (source) and a suffixed
    //     "17e" (candidate) be compared as the same numeric family — they
    //     share the family but are NOT the same code, which is exactly a
    //     conflict — and lets "15amn8" vs "15iru8" be compared as whole
    //     codes within the shared "15" family.
    const sourceAlnumCodes = extractAlnumModelCodes(sourceIdentityText);
    const candidateAlnumCodes = extractAlnumModelCodes(candidateTitle);
    const sourceDigitGroups = buildDigitGroupMap([...sourceModelNumbers, ...sourceAlnumCodes]);
    const candidateDigitGroups = buildDigitGroupMap([...candidateModelNumbers, ...candidateAlnumCodes]);
    for (const [digitRun, sourceCodes] of sourceDigitGroups) {
        const candidateCodes = candidateDigitGroups.get(digitRun);
        if (!candidateCodes) continue;
        const agrees = [...sourceCodes].some((c) => candidateCodes.has(c));
        if (!agrees) {
            return {
                hardReject: true,
                primaryIssue: "model_number_mismatch",
                reason: `MODEL_NUMBER_MISMATCH: requested [${[...sourceCodes].join(",")}], candidate [${[...candidateCodes].join(",")}] (family "${digitRun}")`,
            };
        }
    }

    // 3) Variant/family suffix words (Ultra/Plus/Pro/Max/Air/Slim/Ti/Evo/FE/Enterprise/...).
    //    Symmetric on purpose: requesting "S26 Ultra" and getting plain
    //    "S26" is just as wrong as requesting plain "S26" and getting
    //    "S26 Ultra" — both are a different, specific product.
    const sourceVariants = extractVariantSuffixes(sourceIdentityText);
    const candidateVariants = extractVariantSuffixes(candidateTitle);
    const variantMismatch =
        [...sourceVariants].some((v) => !candidateVariants.has(v)) ||
        [...candidateVariants].some((v) => !sourceVariants.has(v));
    if (variantMismatch) {
        return {
            hardReject: true,
            primaryIssue: "variant_mismatch",
            reason: `VARIANT_MISMATCH: requested [${[...sourceVariants].join(",")}], candidate [${[...candidateVariants].join(",")}]`,
        };
    }

    // 4) Phase 14 Fix C — explicit color conflict. Previously color only
    //    ever added a positive bonus on a match in the scoring section
    //    below; a candidate stating a DIFFERENT explicit color than the one
    //    the user explicitly asked for was never treated as a conflict at
    //    all (a live resolver test found an offer stated as "Black"
    //    resolving to a page for the "Sage" colorway). Mirrors the existing
    //    storage/RAM philosophy — only a CONFIRMED conflict rejects;
    //    absence of a source color (no explicit request) is never a
    //    conflict, and a candidate that doesn't mention any recognizable
    //    color at all is never penalized (detectColor returning null is
    //    "unknown", not "different").
    if (sourceProduct.color) {
        const candidateColor = detectColor(candidateTitle);
        if (candidateColor && normalizeTitle(candidateColor) !== normalizeTitle(sourceProduct.color)) {
            return {
                hardReject: true,
                primaryIssue: "color_mismatch",
                reason: `COLOR_MISMATCH: requested ${sourceProduct.color}, candidate ${candidateColor}`,
            };
        }
    }

    return { hardReject: false, primaryIssue: null, reason: null };
}

/**
 * evaluateVariantMatch — everything below product-identity (storage, RAM,
 * color). Generation/model-number/variant conflicts are now decided
 * upstream by Gate 1 (evaluateVariantIdentity) and can no longer reach
 * this stage — a candidate that gets here is already confirmed to be the
 * same model, so only spec-level (SKU) differences remain to be scored.
 */

/**
 * sourceProduct: { name, brand, model, productName, storage, color, category }
 * candidateTitle: raw listing title from a store adapter
 *
 * Returns { confidence: 0-1, reason: string, primaryIssue, hardReject,
 * matchDecision, requestedType, candidateType }
 */
function computeMatchConfidence(sourceProduct, candidateTitle) {
    const candidateNorm = normalizeTitle(candidateTitle);
    if (!candidateNorm) {
        return { confidence: 0, reason: "empty listing title", primaryIssue: null, hardReject: false, matchDecision: "UNCERTAIN" };
    }

    // GATE 0 — product type / identity conflict. This runs BEFORE token
    // overlap or any other scoring: a candidate that fails this can never
    // recover via brand/model/storage token matches, no matter how many of
    // them it happens to share with the request (this is precisely what let
    // the Cellspare motherboard reach confidence=1.0 previously).
    const identity = evaluateProductIdentity(sourceProduct, candidateTitle);
    if (identity.hardReject) {
        return {
            confidence: 0,
            reason: identity.reason,
            primaryIssue: "product_type_conflict",
            hardReject: true,
            matchDecision: "HARD_REJECT",
            requestedType: identity.requestedType,
            candidateType: identity.candidateType,
        };
    }

    // GATE 1 — product identity / model-generation-variant. Runs right
    // after Gate 0, before any token-overlap scoring — see
    // evaluateVariantIdentity's doc comment for the full rationale. A
    // candidate that fails here (wrong generation, wrong model number,
    // wrong variant/family) is rejected outright and can never recover
    // via a coincidentally-matching storage/RAM/color figure later.
    const variantIdentity = evaluateVariantIdentity(sourceProduct, candidateTitle);
    if (variantIdentity.hardReject) {
        return {
            confidence: 0,
            reason: variantIdentity.reason,
            primaryIssue: variantIdentity.primaryIssue,
            hardReject: true,
            matchDecision: "HARD_REJECT",
            requestedType: identity.requestedType,
            candidateType: identity.candidateType,
        };
    }

    const sourceName = sourceProduct.name || [sourceProduct.brand, sourceProduct.productName].filter(Boolean).join(" ");
    const sourceTokens = tokenize(sourceName);
    const candidateTokens = tokenize(candidateTitle);

    let score = jaccardOverlap(sourceTokens, candidateTokens);
    const notes = [`title overlap ${score.toFixed(2)}`];
    let primaryIssue = null;

    // Legacy soft accessory penalty — kept alongside the new hard-reject gate
    // above for defense in depth (a title with an accessory word the
    // classifier doesn't recognize still gets nudged down, never hard
    // rejected on this signal alone).
    if (looksLikeAccessory(candidateNorm)) {
        score -= 0.6;
        primaryIssue = primaryIssue || "accessory";
        notes.push("looks like an accessory, not the product itself");
    }

    if (sourceProduct.brand) {
        const brandHit = candidateNorm.includes(normalizeTitle(sourceProduct.brand));
        if (brandHit) {
            score += 0.15;
            notes.push("brand match");
        } else {
            score -= 0.35;
            primaryIssue = primaryIssue || "brand_mismatch";
            notes.push("brand missing");
        }
    }

    if (sourceProduct.model) {
        // Phase 14 Fix A — bounded phrase match instead of raw substring
        // containment. `candidateNorm.includes(modelNorm)` previously
        // treated a longer, distinct sub-model name as if it "contained"
        // the shorter requested one purely because the shorter string is a
        // textual substring (e.g. "iphone 17" is a substring of "iphone
        // 17e"). A `\b...\b` match still allows the model phrase to appear
        // anywhere in a longer title (retailer chrome, extra words after
        // it) — it only refuses to match when the model text is glued
        // directly onto more letters/digits with no boundary, which is
        // exactly the false-positive case this fixes. (Most of the
        // confirmed real-world cases are already caught earlier by Gate 1
        // above — this is defense-in-depth for the scoring bonus itself.)
        const modelNorm = normalizeTitle(sourceProduct.model);
        const modelHit = modelNorm && new RegExp(`\\b${modelNorm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(candidateNorm);
        if (modelHit) {
            score += 0.25;
            notes.push("model match");
        }
    }

    if (sourceProduct.storage) {
        const sourceStorage = extractRamAndStorage(sourceProduct.storage).storage
            || extractStorageTokens(sourceProduct.storage)[0]
            || normalizeTitle(sourceProduct.storage).replace(/\s+/g, "");
        const candidateStorage = extractRamAndStorage(candidateTitle).storage;

        if (candidateStorage) {
            if (candidateStorage === sourceStorage) {
                score += 0.1;
                notes.push("storage match");
            } else {
                score = Math.min(score, 0.15);
                primaryIssue = primaryIssue || "storage_mismatch";
                notes.push(`storage mismatch (wanted ${sourceStorage}, found ${candidateStorage})`);
            }
        } else {
            score -= 0.05;
            primaryIssue = primaryIssue || "storage_unconfirmed";
            notes.push("storage not mentioned in listing");
        }
    }

    if (sourceProduct.ram) {
        const sourceRam = extractRamAndStorage(sourceProduct.ram).ram || normalizeTitle(sourceProduct.ram).replace(/\s+/g, "");
        const candidateRam = extractRamAndStorage(candidateTitle).ram;
        if (candidateRam) {
            if (candidateRam === sourceRam) {
                score += 0.05;
                notes.push("RAM match");
            } else {
                score = Math.min(score, 0.85);
                primaryIssue = primaryIssue || "ram_mismatch";
                notes.push(`RAM mismatch (wanted ${sourceRam}, found ${candidateRam})`);
            }
        } else {
            // Phase 5 fix: this branch didn't exist before — a candidate
            // that never mentions RAM at all was silently treated as if
            // RAM had been confirmed (no penalty, no primaryIssue), unlike
            // the parallel, already-existing storage_unconfirmed handling
            // above. Mirrors that exact pattern for symmetry.
            score -= 0.05;
            primaryIssue = primaryIssue || "ram_unconfirmed";
            notes.push("RAM not mentioned in listing");
        }
    }

    if (sourceProduct.color) {
        const colorHit = candidateNorm.includes(normalizeTitle(sourceProduct.color));
        if (colorHit) {
            score += 0.05;
            notes.push("color match");
        }
    }

    const confidence = Math.max(0, Math.min(1, score));
    let matchDecision = getMatchDecision(confidence, false);
    // Phase 4 correctness fix: "EXACT_MATCH" is the strongest label this
    // engine can show a person — it should mean every REQUESTED variant
    // attribute was actually confirmed, not just that brand/model tokens
    // overlapped enough to push the raw score above 0.85. A candidate
    // whose title never mentions storage at all (primaryIssue
    // "storage_unconfirmed") still reached EXACT_MATCH before this fix,
    // because the -0.05 unconfirmed-storage penalty wasn't enough to pull
    // the score below the 0.85 cutoff on its own — a real live run showed
    // "Samsung Galaxy S26 Ultra 5G" (no storage mentioned anywhere in the
    // title) labeled EXACT_MATCH for a 256GB request, which overstates
    // what was actually verified.
    //
    // Phase 5 fix: extended the exact same reasoning to RAM, for the same
    // reason — and additionally to "ram_mismatch". A RAM mismatch caps at
    // exactly 0.85 (`score = Math.min(score, 0.85)` above), which lands
    // precisely ON the EXACT_MATCH boundary, so an offer with the WRONG
    // RAM could still be labeled EXACT_MATCH — not just unconfirmed, an
    // actual confirmed conflict, which must never claim to be exact.
    //
    // Deliberately a LABEL-only change in every case here: the underlying
    // numeric confidence, hardReject, and (via offerEligibility.js, which
    // only ever reads the numeric confidence) bestOffer/bestDirectOffer/
    // savings eligibility are completely untouched — an offer is exactly
    // as eligible for bestOffer as it was before. Only the string shown to
    // a person changes, from an overclaiming "EXACT_MATCH" to
    // "STRONG_MATCH" — still the strongest *identity* signal, just no
    // longer implying every requested attribute was itself confirmed.
    if (matchDecision === "EXACT_MATCH" && (primaryIssue === "storage_unconfirmed" || primaryIssue === "ram_unconfirmed" || primaryIssue === "ram_mismatch")) {
        matchDecision = "STRONG_MATCH";
    }
    return {
        confidence,
        reason: notes.join("; "),
        primaryIssue,
        hardReject: false,
        matchDecision,
        requestedType: identity.requestedType,
        candidateType: identity.candidateType,
    };
}

// Spec Step 8's decision model, layered on top of the existing numeric
// confidence + hardReject flag rather than replacing them — matchLabel
// (exact/high/medium/low, below) and the ranker's existing
// MATCH_CONFIDENCE_THRESHOLD/BEST_OFFER_MATCH_THRESHOLD stay exactly as
// they were, so this is purely an additive, more descriptive label.
function getMatchDecision(confidence, hardReject) {
    if (hardReject) return "HARD_REJECT";
    if (confidence >= 0.85) return "EXACT_MATCH";
    if (confidence >= 0.75) return "STRONG_MATCH"; // == BEST_OFFER_MATCH_THRESHOLD
    if (confidence >= 0.5) return "POSSIBLE_MATCH"; // == MATCH_CONFIDENCE_THRESHOLD ("confident"/shown bucket)
    return "UNCERTAIN"; // shown separately as a possible match, per existing behavior
}

function confidenceLabel(confidence) {
    if (confidence >= 0.85) return "exact";
    if (confidence >= 0.6) return "high";
    if (confidence >= 0.4) return "medium";
    return "low";
}

module.exports = {
    normalizeTitle,
    tokenize,
    extractStorageTokens,
    extractRamAndStorage,
    extractModelNumberTokens,
    extractPlainModelNumbers,
    extractVariantSuffixes,
    computeMatchConfidence,
    confidenceLabel,
    evaluateProductIdentity,
    evaluateVariantIdentity,
    getMatchDecision,
};
