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
// Phase 11 (Live Validation) — "xl" added. A real live 4-product resolver
// run surfaced "Google Pixel 10 Pro XL" (Flipkart ₹124,999) scoring a
// perfect suffix match against a requested "Pixel 10 Pro" and, worse, two
// unrelated "Pixel 10 Pro XL" listings (GameLoot ₹55,000, Cashify ₹78,899)
// becoming bestOffer/bestDirectOffer for a "Pixel 10 Pro" request. Web
// search confirmed Pro and Pro XL are genuinely distinct, separately
// priced/specced phones (6.3" vs 6.8" display, different battery/price
// tier) — same category of naming as Pro/Ultra/Plus above, missing here
// for exactly the reason "fe" and "enterprise" were added in Phase 14.
const VARIANT_SUFFIX_WORDS = ["pro", "plus", "ultra", "neo", "max", "elite", "lite", "se", "mini", "air", "note", "anc", "slim", "ti", "evo", "fe", "enterprise", "xl"];

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

// "Mini LED" is a backlight TECHNOLOGY descriptor (see
// detectPanelTechnology's doc comment on oled/qned/qled/nanocell), not a
// device-edition variant suffix the way "iPhone Mini"/"Galaxy S24 Ultra"
// are. "Ultra HD" is the same problem for "ultra": it's a near-universal
// generic resolution descriptor (4K = "Ultra HD"), appearing in the
// overwhelming majority of TV listings, not a device-edition name. Live
// evidence: 19 of the VARIANT_MISMATCH rejections across 3 real TV test
// runs had "Ultra HD" in the candidate title immediately before the
// rejection — including a candidate that was otherwise a genuinely
// correct, confirmed-same-size (55") QNED match. Without this mask,
// "mini"/"ultra" (pre-existing VARIANT_SUFFIX_WORDS entries, added for
// phone editions) get extracted from these generic phrases and
// symmetrically HARD_REJECT legitimate TV listings purely because they
// use standard marketing language the source query didn't happen to
// repeat. Same masking technique as maskChipsetContext just above.
const NON_VARIANT_PHRASE_PATTERNS = [/\bmini[\s-]?led\b/g, /\bultra\s?hd\b/g];

function maskNonVariantPhrases(normalizedText) {
    let masked = normalizedText;
    for (const pattern of NON_VARIANT_PHRASE_PATTERNS) {
        masked = masked.replace(pattern, (span) => span.replace(/[a-z0-9]/g, "_"));
    }
    return masked;
}

function extractVariantSuffixes(text) {
    const norm = maskNonVariantPhrases(maskChipsetContext(normalizeTitle(text)));
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
    // Phase 15 (Live Cross-Phase Validation) fix: this lookahead previously
    // only excluded gb/tb/mb, missing screen-size units entirely. A source
    // of "55 inch QNED 4K Smart TV" was treating the bare "55" as if it
    // were a required model-number code (like "15" in "iPhone 15"), then
    // HARD_REJECTing every candidate that didn't also contain the literal
    // digits "55" somewhere — including completely legitimate, size-silent
    // QNED listings. Reproduced directly against 3 live TV test runs (LG
    // OLED/QLED/QNED), not a single anecdote. "in"/"inch"/"inches" excluded
    // the same way gb/tb/mb already were; screen size gets its own explicit
    // comparison via detectScreenSize() below instead of leaking into the
    // generic model-number-conflict mechanism.
    const matches = norm.match(/\b\d{2,4}\b(?!\s?(gb|tb|mb|inch(es)?|in)\b)/g) || [];
    return matches;
}

// Phase 15 (Live Cross-Phase Validation) — explicit screen-size conflict,
// same "explicit conflict only" shape as color/network-generation/panel-
// technology above. Root cause this fixes: NO screen-size comparison
// existed anywhere before this — a live test showed "LG OLED83C24LA" (LG's
// own model-number convention encodes size right after the panel-type
// prefix: OLED + 83 + series + region code = an 83" TV) scoring a 0.78
// STRONG_MATCH and becoming bestOffer against a requested 55" TV, because
// nothing ever compared the two sizes.
//
// Detects explicit sizes from four sources, in order:
//   1. "55 inch"/"55 inches"/"55 in" (word form, post text-normalization)
//   2. `55"` (quote form — checked on the ORIGINAL text, since
//      normalizeTitle strips `"` entirely before this could see it)
//   3. "139 cm"/"140 cm" (metric form, converted to the nearest inch)
//   4. Model-code-encoded size — see the two prefix patterns below; the
//      DIRECTION differs by product line (confirmed from live data, not
//      assumed), so this is two separate patterns, not one.
// Only a CONFIRMED conflict (both source and candidate explicitly state a
// DIFFERENT size) rejects — a size-silent source or candidate is never
// penalized, exactly like every other explicit-conflict check.
// LG's OLED line encodes size AFTER the "OLED" prefix (real products:
// OLED55C3, OLED65C3, OLED77C3 — well-established, not a guess).
const SCREEN_SIZE_AFTER_PREFIX = /\boled(\d{2,3})(?!\d)/i;
// LG's LCD-based lines (QNED/NanoCell/UHD/UR/UQ/UT) and Samsung/TCL/
// Hisense QLED all encode size BEFORE the tier prefix instead — confirmed
// directly from live data: "140 cm (55 inch) | ... | 55QNED82BXA" is the
// SAME product, proving "55" (not "82") is the size and "82" is a
// separate tier/series number. Getting this backwards was an earlier,
// now-corrected version of this function that mistook "82" for size and
// produced false SCREEN_SIZE_MISMATCH rejections against genuine 55"
// QNED listings — caught before shipping, not after.
const SCREEN_SIZE_BEFORE_PREFIX = /\b(\d{2,3})(qned|qled|nanocell|uhd|ur|uq|ut)(?![a-z])/i;

// Real-world retailer listings don't always state a TV's exact
// mathematically-converted cm figure. Evidence from live data: a genuine
// 55" TV (true diagonal 55 * 2.54 = 139.7cm) is listed as "138 cm",
// "139 cm", or "140 cm" depending on the retailer; a genuine 65" TV
// (165.1cm true) is listed as "163 cm" through "166 cm". Plain
// Math.round(cm / 2.54) turns "138 cm" into 54" and "163 cm" into 64" —
// a real TV silently drops to a *different*, non-existent nearby size and
// then false-rejects against its own correct request.
//
// Fix scope: correct ONLY this rounding-noise problem, without ever
// letting two genuinely different, closely-spaced commercial sizes
// (e.g. 42"/43", 49"/50", both real, only 2.54cm apart in true
// diagonal) become indistinguishable. KNOWN_TV_SIZES_CM below lists each
// standard size's exact true-diagonal cm value. A listed cm figure is
// snapped to a known size ONLY when it falls within CM_SNAP_TOLERANCE of
// EXACTLY ONE entry; if it falls within tolerance of more than one (which
// happens automatically for every pair of sizes closer together than
// 2 * CM_SNAP_TOLERANCE, e.g. the 42/43 and 49/50 pairs), or of none,
// this deliberately does nothing and the caller falls back to the
// original plain rounding — i.e. every ambiguous case behaves exactly as
// it did before this fix. This guarantees the fix can only ever resolve
// an already-unambiguous rounding-noise case; it can never merge two
// different real sizes together.
const KNOWN_TV_SIZES_CM = [24, 28, 32, 40, 42, 43, 48, 49, 50, 55, 58, 60, 65, 70, 75, 77, 83, 85, 86, 98, 100]
    .map((inches) => ({ inches, cm: inches * 2.54 }));
const CM_SNAP_TOLERANCE = 2.2; // cm; covers the largest observed real deviation (163cm vs 65" true 165.1cm = 2.1cm) with margin, while every known adjacent-size gap of >=5.08cm stays strictly unambiguous (2 * 2.2 = 4.4 < 5.08).

function snapCmToKnownTvSize(rawCm) {
    const withinTolerance = KNOWN_TV_SIZES_CM.filter((s) => Math.abs(rawCm - s.cm) <= CM_SNAP_TOLERANCE);
    if (withinTolerance.length === 1) return withinTolerance[0].inches;
    return null; // 0 or 2+ matches: ambiguous or no evidence — defer to plain rounding, unchanged.
}

function detectScreenSize(rawText) {
    if (!rawText) return null;
    const quoteMatch = rawText.match(/\b(\d{2,3})\s?"/);
    if (quoteMatch) {
        const n = parseInt(quoteMatch[1], 10);
        if (n >= 20 && n <= 120) return n;
    }
    const norm = normalizeTitle(rawText);
    const wordMatch = norm.match(/\b(\d{2,3})\s?(?:inch(?:es)?|in)\b/);
    if (wordMatch) {
        const n = parseInt(wordMatch[1], 10);
        if (n >= 20 && n <= 120) return n;
    }
    const cmMatch = norm.match(/\b(\d{2,3})\s?cm\b/);
    if (cmMatch) {
        const rawCm = parseInt(cmMatch[1], 10);
        const n = snapCmToKnownTvSize(rawCm) ?? Math.round(rawCm / 2.54);
        if (n >= 20 && n <= 120) return n;
    }
    const beforeMatch = norm.match(SCREEN_SIZE_BEFORE_PREFIX);
    if (beforeMatch) {
        const n = parseInt(beforeMatch[1], 10);
        if (n >= 32 && n <= 98) return n;
    }
    const afterMatch = norm.match(SCREEN_SIZE_AFTER_PREFIX);
    if (afterMatch) {
        const n = parseInt(afterMatch[1], 10);
        if (n >= 32 && n <= 98) return n;
    }
    return null;
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
    detectScreenSize,
    extractAlnumModelCodes,
    leadingDigitRun,
    leadingLetterPrefix,
    parsePrice,
    roundCurrency,
};
