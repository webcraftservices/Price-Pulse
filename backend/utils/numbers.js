/**
 * Numeric / variant-token utilities
 * ------------------------------------------------------------------
 * Storage, RAM, model-number, and variant-suffix extraction, plus
 * price-string parsing. Extracted from productMatcher.js and
 * stores/googleShopping.js (V1) with no behavior change.
 */

const { normalizeTitle } = require("./text");

// Pulls out storage-like tokens ("256gb", "1tb") so variants aren't confused.
function extractStorageTokens(text) {
    const matches = normalizeTitle(text).match(/\d+\s?(gb|tb|mb)\b/g) || [];
    return matches.map((m) => m.replace(/\s+/g, ""));
}

// Distinguishes RAM from Storage when a title mentions both — e.g. "12GB
// RAM, 256GB Storage" must never let 12GB (RAM) get treated as the storage
// figure. Strategy: prefer an explicit "...GB RAM" / "...GB Storage"/"...GB
// ROM" label when present. When neither figure is labeled but exactly two
// GB figures appear, fall back to the standard Indian-retail listing
// convention "(RAM, Storage)". A single unlabeled figure is assumed to be
// storage UNLESS its magnitude makes that implausible (see
// RAM_ONLY_MAX_PLAUSIBLE_GB below) — e.g. a bare "12GB" with nothing else
// in the text is RAM, since no real device ships with 12GB of storage.
const RAM_ONLY_MAX_PLAUSIBLE_GB = 24; // highest mainstream phone/laptop RAM size in circulation; the smallest realistic storage tier (32GB+) sits safely above this
function extractRamAndStorage(text) {
    const norm = normalizeTitle(text);
    const tokenRegex = /(\d+)\s?(gb|tb|mb)\b(\s*(ram|rom|storage))?/g;
    const tokens = [];
    let m;
    while ((m = tokenRegex.exec(norm)) !== null) {
        const value = `${m[1]}${m[2]}`;
        const label = m[4] === "ram" ? "ram" : m[4] === "rom" || m[4] === "storage" ? "storage" : null;
        tokens.push({ value, label });
    }

    if (tokens.length === 0) return { ram: null, storage: null };

    if (tokens.length === 1) {
        const token = tokens[0];
        if (token.label === "ram") return { ram: token.value, storage: null };
        if (token.label === "storage") return { ram: null, storage: token.value };
        // Unlabeled and alone — magnitude is the only signal left. A
        // "gb"-unit figure at or below the plausible-RAM ceiling (e.g.
        // "Samsung Galaxy S26 Ultra 12GB" with no other spec mentioned)
        // is RAM, not storage; "tb"/"mb" units, and any "gb" figure above
        // the ceiling, keep the original default (storage) unchanged —
        // this is exactly what every existing single-figure storage
        // mention (256GB, 512GB, 1TB, ...) already relied on.
        const numericValue = parseInt(token.value, 10);
        const unit = token.value.slice(String(numericValue).length);
        if (unit === "gb" && numericValue <= RAM_ONLY_MAX_PLAUSIBLE_GB) {
            return { ram: token.value, storage: null };
        }
        return { ram: null, storage: token.value };
    }

    let ram = tokens.find((t) => t.label === "ram")?.value || null;
    let storage = tokens.find((t) => t.label === "storage")?.value || null;
    const unlabeled = tokens.filter((t) => !t.label);
    const distinctUnlabeledValues = new Set(unlabeled.map((t) => t.value));

    // Duplicate mentions of the SAME figure (e.g. "512GB" appearing in both
    // a title and a concatenated snippet) are one storage mention, not two
    // distinguishing RAM+Storage figures.
    if (!ram && !storage && distinctUnlabeledValues.size === 1) {
        storage = unlabeled[0].value;
    } else {
        if (!ram) {
            const candidate = unlabeled.find((t) => t.value !== storage);
            if (candidate) ram = candidate.value;
        }
        if (!storage) {
            const candidate = unlabeled.find((t) => t.value !== ram);
            if (candidate) storage = candidate.value;
        }
    }

    return { ram, storage };
}

// Pulls out letter+digit model/generation tokens ("s26", "a54", "m14") so
// "Galaxy S25 Ultra" is never confused with "Galaxy S26 Ultra".
function extractModelNumberTokens(text) {
    const matches = normalizeTitle(text).match(/\b[a-z]+\d+[a-z]*\b/g) || [];
    return matches;
}

// Real product-line variant words — "Pro", "Ultra", "Neo", "Gen 2" etc. mark
// a genuinely different product, not marketing fluff.
// "slim"/"ti"/"evo" added for Phase 2 (Gate 1 identity matching — PS5 Slim,
// RTX xx70 Ti, Samsung SSD EVO lines are distinct products from their
// Pro/base counterparts, not just a scoring nudge).
// Phase 14 (Wrong-Variant Root Cause Fix) — "fe" (Fan Edition: Tab S9 FE,
// Galaxy Buds3 FE) and "enterprise" (Enterprise Edition: S26 Ultra
// Enterprise Edition) added. Both are genuinely distinct product lines
// with different specs/pricing from their base counterpart, the same
// category of naming as Pro/Ultra/Plus above — previously missing here,
// which is why a live 20-product resolver test found these sub-lines
// scoring as a perfect model-match against the base product.
const VARIANT_SUFFIX_WORDS = ["pro", "plus", "ultra", "neo", "max", "elite", "lite", "se", "mini", "air", "note", "anc", "slim", "ti", "evo", "fe", "enterprise"];

// Phase 6 — chipset/processor name masking.
//
// Bug: a listing's internal SoC/chipset name can contain the exact same
// word as VARIANT_SUFFIX_WORDS ("Snapdragon 8 ELITE", "Snapdragon 8 Plus
// Gen 1", "Snapdragon 8 GEN 2") even though that word says nothing about
// which edition of the PHONE this is — it's naming the chip inside it.
// extractVariantSuffixes previously scanned the whole title blind to this,
// so a genuine exact-match listing that happened to mention its chipset
// got hard-rejected by Gate 1 for a "variant" that was never actually
// about the device.
//
// Fix: mask known chipset/processor name spans out of the text before
// scanning for variant words, so chip vocabulary can never be read as a
// phone variant. Deliberately scoped to chip FAMILIES that never double as
// a phone's own product-line name (Snapdragon/Dimensity/Exynos/Kirin/
// Helio/Tensor, plus Apple's A-series phone/tablet chips). Apple's Mac
// M-series ("M3 Pro/Max/Ultra") is intentionally EXCLUDED — for Macs that
// naming genuinely IS the product variant, not just an internal chip name,
// so masking it would create a false negative instead of fixing a false
// positive.
// Each token consumed after the chip family name is guarded by a negative
// lookahead that refuses to swallow a storage/RAM figure ("12gb", "1tb",
// ...). Without this, a title like "Snapdragon 8 Elite Gen5 12GB 256GB"
// would keep matching tokens right past the chip name into the storage
// spec, masking the very figures storage/RAM matching depends on. The
// lookahead makes the span stop the instant it would consume one.
const CHIP_TOKEN = "(?:\\s+(?!\\d+\\s?(?:gb|tb|mb)\\b)[a-z0-9]+)";
const CHIPSET_CONTEXT_PATTERNS = [
    new RegExp(`\\bsnapdragon\\b${CHIP_TOKEN}{0,4}`, "g"),
    new RegExp(`\\bdimensity\\b${CHIP_TOKEN}{0,3}`, "g"),
    new RegExp(`\\bexynos\\b${CHIP_TOKEN}{0,3}`, "g"),
    new RegExp(`\\bkirin\\b${CHIP_TOKEN}{0,3}`, "g"),
    new RegExp(`\\bhelio\\b${CHIP_TOKEN}{0,3}`, "g"),
    new RegExp(`\\btensor\\b${CHIP_TOKEN}{0,3}`, "g"),
    // Apple A-series SoC names only ("A14"-"A29" + Bionic/Pro/Fusion) — the
    // iPhone/iPad chip line, never the Mac M-series (see note above).
    /\ba(?:1[4-9]|2[0-9])\s+(?:bionic|pro|fusion)\b/g,
];

// Replaces every char of a chipset-name span with "_" (never removes the
// span outright) so word boundaries and string length are preserved —
// masking can't accidentally glue two unrelated words together or shift
// other regexes that run on the same normalized string.
function maskChipsetContext(normalizedText) {
    let masked = normalizedText;
    for (const pattern of CHIPSET_CONTEXT_PATTERNS) {
        masked = masked.replace(pattern, (span) => span.replace(/[a-z0-9]/g, "_"));
    }
    return masked;
}

function extractVariantSuffixes(text) {
    const norm = maskChipsetContext(normalizeTitle(text));
    const found = new Set();
    for (const word of VARIANT_SUFFIX_WORDS) {
        if (new RegExp(`\\b${word}\\b`).test(norm)) found.add(word);
    }
    if (/\bgen\s?2\b|\b2nd\s?gen(eration)?\b/.test(norm)) found.add("gen2");
    return found;
}

// Pulls out bare 2-4 digit model numbers with no unit attached ("141" in
// "Airdopes 141"), excluding anything that's actually a storage/RAM figure.
function extractPlainModelNumbers(text) {
    const norm = normalizeTitle(text);
    const matches = norm.match(/\b\d{2,4}\b(?!\s?(gb|tb|mb))/g) || [];
    return matches;
}

// Phase 14 (Wrong-Variant Root Cause Fix) — Fix B: digit-first alphanumeric
// model/sub-model codes such as "17e" (iPhone 17 vs 17e) and "15AMN8" /
// "15IRU8" (Lenovo IdeaPad Slim 3 sub-models).
//
// Root cause: both extractModelNumberTokens (letter-first, "s9"/"r530") and
// extractPlainModelNumbers (bare digits) rely on \b word-boundary regexes.
// A \b never falls between two word characters — so a digit run immediately
// followed by letters with NO separator ("17e", "15amn8") is invisible to
// both: extractModelNumberTokens requires a LETTER first, and
// extractPlainModelNumbers' \b\d{2,4}\b fails because there's no boundary
// between the last digit and the first following letter. A live resolver
// test found this exact gap letting "iPhone 17e" and "Lenovo ...15IRU8"
// score as an EXACT_MATCH against "iPhone 17" / "...15AMN8" requests.
//
// Excludes known unit/descriptor suffixes (gb/tb/mb/g/k/hz/...) so a
// storage figure ("128gb") or network/resolution descriptor ("5g", "4k")
// is never mistaken for a model code — those are already handled by
// extractRamAndStorage / the noise-word list and must not be double-counted
// here.
const ALNUM_MODEL_CODE_EXCLUDED_SUFFIXES = new Set([
    "gb", "tb", "mb", "kb", "g", "k", "hz", "mp", "mah", "kg", "ml", "cm", "mm", "hr", "hrs", "w", "v",
]);

function extractAlnumModelCodes(text) {
    const norm = normalizeTitle(text);
    const matches = norm.match(/\b\d+[a-z]+\d*\b/g) || [];
    return matches.filter((tok) => {
        const letterPart = (tok.match(/[a-z]+/) || [""])[0];
        return !ALNUM_MODEL_CODE_EXCLUDED_SUFFIXES.has(letterPart);
    });
}

// Splits the leading digit run off a bare number or a digit-first alnum
// code ("17" -> "17", "17e" -> "17", "15amn8" -> "15") so two codes that
// share the same numeric "family" but differ in what follows can be
// grouped for comparison even though their full strings differ (Fix B,
// used by evaluateVariantIdentity in productMatcher.js).
function leadingDigitRun(tok) {
    const m = String(tok || "").match(/^(\d+)/);
    return m ? m[1] : null;
}

// Splits the leading letter-prefix off a letter-first model token
// ("r530" -> "r", "buds3" -> "buds") so two tokens sharing the same
// family prefix but a different numeric suffix (e.g. SM-R530 vs SM-R420)
// can be compared as a pair even when OTHER shared tokens on the same
// candidate ("buds3") would otherwise mask the conflict (Fix D, used by
// evaluateVariantIdentity in productMatcher.js).
function leadingLetterPrefix(tok) {
    const m = String(tok || "").match(/^([a-z]+)\d+[a-z]*$/);
    return m ? m[1] : null;
}

// Parses a raw price value (number, "₹1,299", "Rs. 1,299", "INR 1299", ...)
// into a plain numeric value, or null if it can't be parsed. Never guesses.
function parsePrice(raw) {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
    const cleaned = String(raw).replace(/[^0-9.]/g, "");
    if (!cleaned) return null;
    const value = parseFloat(cleaned);
    return Number.isFinite(value) ? value : null;
}

// Rounds a currency value to 2 decimal places, safely (i.e. without the
// classic IEEE-754 float artifact — `165561.80 - 117999` in raw JS is
// `47562.79999999999`, not `47562.8`). Any arithmetic on money values
// (savings = max - min, a converted/scraped price with a fractional
// remainder, ...) should pass its result through this before it reaches
// the API boundary. Returns null/non-finite input unchanged (never turns
// a missing price into 0).
function roundCurrency(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) return value;
    // The classic "round to 2dp" fix: nudge by a tiny epsilon before
    // rounding so e.g. 1.005 (which is actually 1.00499999... in float)
    // rounds the way a human expects, then divide back down.
    return Math.round((value + Number.EPSILON) * 100) / 100;
}

module.exports = {
    extractStorageTokens,
    extractRamAndStorage,
    extractModelNumberTokens,
    VARIANT_SUFFIX_WORDS,
    CHIPSET_CONTEXT_PATTERNS,
    maskChipsetContext,
    extractVariantSuffixes,
    extractPlainModelNumbers,
    extractAlnumModelCodes,
    leadingDigitRun,
    leadingLetterPrefix,
    parsePrice,
    roundCurrency,
};
