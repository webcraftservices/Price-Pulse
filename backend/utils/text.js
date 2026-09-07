/**
 * Text utilities
 * ------------------------------------------------------------------
 * Pure string helpers shared across the comparison engine: title
 * normalization, tokenization, brand/color detection, and retailer
 * title-chrome stripping. Extracted from productMatcher.js and
 * compareService.js (V1) with no behavior change — see those files'
 * git history for original context/comments.
 */

// Marketing/noise tokens that don't identify the product and would
// otherwise inflate or deflate the overlap score.
const NOISE_WORDS = new Set([
    "buy", "online", "best", "price", "shop", "shopping", "sale", "offer",
    "offers", "deal", "deals", "india", "official", "store", "new", "genuine",
    "with", "for", "the", "and", "in", "a", "at", "on", "of", "free", "delivery",
    // Harmless retail/network/regional descriptors — these don't identify a
    // different product variant, so they must never drag down title-overlap
    // between two listings of the same product.
    "5g", "4g", "smartphone", "mobile", "phone", "dual", "sim", "android",
    "unlocked", "international", "global", "indian", "wifi", "wi", "fi",
    "bluetooth", "edition", "storage", "ram",
    // Carrier names — informational, not part of core product identity.
    "google", "airtel", "jio", "verizon", "att",
]);

// Products whose titles contain these are almost always accessories for the
// real product, not the product itself.
const ACCESSORY_WORDS = [
    "case", "cover", "pouch", "skin", "screen guard", "screen protector",
    "tempered glass", "charger", "charging cable", "cable", "adapter",
    "strap", "band", "stand", "holder", "sticker", "decal", "mount",
];

function looksLikeAccessory(candidateNorm) {
    return ACCESSORY_WORDS.some((word) => candidateNorm.includes(word));
}

function normalizeTitle(text) {
    if (!text) return "";
    return text
        .toLowerCase()
        .replace(/[|,()/]/g, " ")
        .replace(/[^a-z0-9.\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function tokenize(text) {
    return normalizeTitle(text)
        .split(" ")
        .filter((t) => t && !NOISE_WORDS.has(t));
}

function jaccardOverlap(tokensA, tokensB) {
    if (!tokensA.length || !tokensB.length) return 0;
    const setA = new Set(tokensA);
    const setB = new Set(tokensB);
    let intersection = 0;
    for (const t of setA) if (setB.has(t)) intersection++;
    const union = new Set([...setA, ...setB]).size;
    return union === 0 ? 0 : intersection / union;
}

// Not exhaustive — just enough to recognize a brand token at the start of a
// title. Unknown brands simply fall back to whole-title matching.
const KNOWN_BRANDS = [
    "Samsung", "Apple", "OnePlus", "Xiaomi", "Redmi", "Realme", "Vivo", "Oppo",
    "Nothing", "Google", "Sony", "LG", "Motorola", "Nokia", "Honor", "iQOO", "Poco",
    "boAt", "Noise", "Fire-Boltt", "Titan", "Fastrack", "Fossil", "Casio", "Garmin",
    "HP", "Dell", "Lenovo", "Asus", "Acer", "MSI", "Microsoft", "Toshiba",
    "JBL", "Bose", "Sennheiser", "Skullcandy", "Sony",
    "Nike", "Adidas", "Puma", "Reebok", "Levis", "Levi's",
    "Whirlpool", "Bosch", "IFB", "Haier", "Panasonic", "Philips", "Voltas",
];

function detectBrand(text) {
    for (const brand of KNOWN_BRANDS) {
        const escaped = brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (new RegExp(`\\b${escaped}\\b`, "i").test(text)) return brand;
    }
    return null;
}

// Not exhaustive — common retail color names/finishes. Absence just means
// color plays no role in matching for that product.
const COLOR_WORDS = [
    "titanium black", "titanium gray", "titanium grey", "titanium silver", "titanium violet",
    "phantom black", "phantom silver", "phantom violet", "space gray", "space grey",
    "sierra blue", "rose gold", "jet black", "midnight", "starlight", "graphite",
    "black", "white", "blue", "green", "red", "purple", "pink", "silver", "gold",
    "gray", "grey", "yellow", "orange", "beige", "cream", "bronze",
].sort((a, b) => b.length - a.length); // longest/most-specific first

function detectColor(text) {
    const norm = text.toLowerCase();
    for (const color of COLOR_WORDS) {
        if (norm.includes(color)) return color.replace(/\b\w/g, (c) => c.toUpperCase());
    }
    return null;
}

// Phase 12 (Wrong-Variant Suffix Coverage Audit) — explicit network-
// generation conflict (4G vs 5G). Mirrors detectColor/the Phase 14 color-
// conflict pattern exactly, on purpose: only a CONFIRMED conflict (both
// sides explicitly state a DIFFERENT generation) is meaningful; absence
// on either side is never treated as a mismatch.
//
// Why NOT a global VARIANT_SUFFIX_WORDS entry: "5G" is added as a generic
// marketing descriptor on the overwhelming majority of current flagship
// listings even when the person's own request never mentions it (see
// DESCRIPTOR_PHRASES above, and every Phase 9-11 live-confirmed match —
// Galaxy S26 Ultra, iPhone 17 Pro, Pixel 10 Pro — has a candidate title
// ending "... 5G"). A symmetric suffix-set rule would hard-reject every
// one of those already-verified-correct matches. But for some budget
// product lines the distinction is a genuinely different phone: Samsung
// Galaxy M14 4G (Snapdragon 680, model SM-M145F) and Galaxy M14 5G
// (Exynos 1330, SM-M146B) differ in chipset, storage, battery, and
// release date — confirmed via web search, not assumed. This detector
// only feeds a conflict check gated on the SOURCE explicitly stating a
// generation (see evaluateVariantIdentity) — it never fires just because
// a candidate happens to say "5G" and the source is silent.
function detectNetworkGeneration(text) {
    const norm = normalizeTitle(text);
    const match = norm.match(/\b([45])g\b/);
    return match ? match[1] + "g" : null;
}

// Phase 14 (TV Panel-Technology Identity Audit) — explicit panel-
// technology conflict (OLED vs QLED vs QNED vs Nano Cell), mirroring
// detectNetworkGeneration/the color-conflict pattern exactly: only a
// CONFIRMED conflict (both sides explicitly name a DIFFERENT specific
// technology) is meaningful; absence on either side is never a conflict.
//
// Deliberately checks specific, proprietary/technical terms ONLY —
// "oled", "qled" (also matches "neo qled"), "qned", "nanocell"/"nano
// cell". Deliberately does NOT include bare "led" as a detected
// technology: reproduced with the actual matcher, "Samsung QLED" vs
// "Samsung LED" is genuinely ambiguous — "LED" is commonly used as a
// generic umbrella descriptor (a QLED set's own listing sometimes still
// says "LED TV" loosely) rather than a specific competing technology
// name the way "OLED"/"QLED"/"QNED" are. Treating a source's silence on
// technology (or a generic "LED" mention) as a conflict would risk false
// rejections; left as a documented remaining risk rather than guessed at.
// Order matters: check "qled" before bare "led" would ever be considered
// so a longer specific term is never mistaken for the generic one (moot
// here since "led" isn't detected at all, but kept for clarity if a
// future phase adds it back narrowly).
function detectPanelTechnology(text) {
    const norm = normalizeTitle(text);
    if (/\bqned\b/.test(norm)) return "qned";
    if (/\bqled\b/.test(norm)) return "qled"; // also matches "neo qled" (contains "qled")
    if (/\boled\b/.test(norm)) return "oled";
    if (/\bnano\s?cell\b/.test(norm)) return "nanocell";
    return null;
}

// Harmless retail/network/carrier descriptors that must not remain part of
// the canonical model identity — "5G", "Smartphone", "Dual SIM", "Storage"
// etc. are not different products, just spec/marketing chrome. Deliberately
// does NOT include variant words like Ultra/Plus/Pro/Max/Edge — those ARE
// meaningful product identity and must never be stripped here.
const DESCRIPTOR_PHRASES = [
    "google fi", "airtel", "jio", "verizon", "at&t", "att", // carriers first (multi-word)
    "dual sim", "5g", "4g", "smartphone", "mobile", "phone", "sim", "android",
    "unlocked", "international", "global", "indian", "wi-fi", "wifi", "bluetooth",
    "edition", "storage", "ram",
];

function stripDescriptors(text) {
    let result = text;
    for (const phrase of DESCRIPTOR_PHRASES) {
        const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        result = result.replace(new RegExp(`\\b${escaped}\\b`, "gi"), " ");
    }
    return result.replace(/\s+/g, " ").trim();
}

// Real e-commerce titles usually have a trailing " | Site name" / " - Buy Online"
// tail (and sometimes a leading "Buy "). Strip the common ones so the title we
// search with is just the product, not page chrome.
function cleanScrapedTitle(rawTitle) {
    if (!rawTitle) return "";

    let title = rawTitle.trim();

    title = title.replace(/^buy\s+/i, "").trim();

    const cutPatterns = [
        /\s*[:|]\s*Amazon.*$/i,
        /\s*-\s*Amazon\.\w+.*$/i,
        /\s*-\s*Buy\s.*$/i,
        /\s*[-–]\s*Flipkart.*$/i,
        /\s*\|\s*Flipkart.*$/i,
        /\s+Price in India.*$/i,
        /\s+Price,?\s*Specifications.*$/i,
        /\s+Specifications,?\s*Reviews.*$/i,
        /\s+Reviews?,?\s*Ratings?.*$/i,
        /\s*\|\s*.*$/, // generic " | Site Name" tail
        /\s+Online at Best Price.*$/i,
        /\s+at [Bb]est [Pp]rice.*$/i,
        /\s*[-–]\s*Buy Online.*$/i,
    ];

    for (const pattern of cutPatterns) {
        const next = title.replace(pattern, "").trim();
        // Only accept the cut if it didn't strip away almost everything.
        if (next.length >= 6) title = next;
    }

    // Generic fallback for store chrome that doesn't match any pattern above
    // (Croma, Reliance Digital, any future store): a short, digit-free trailing
    // segment after " - " or " | " is almost always a site name, not part of
    // the product ("... - Croma", "... - Reliance Digital"), so drop it.
    const segments = title.split(/\s+[-|]\s+/);
    if (segments.length > 1) {
        const last = segments[segments.length - 1].trim();
        const wordCount = last.split(/\s+/).filter(Boolean).length;
        if (wordCount > 0 && wordCount <= 3 && !/\d/.test(last)) {
            const trimmed = segments.slice(0, -1).join(" - ").trim();
            if (trimmed.length >= 6) title = trimmed;
        }
    }

    return title.trim();
}

// Last-resort fallback when the product page can't be scraped: pull the most
// descriptive path segment instead of the whole slug (skips IDs/ASINs/short codes).
function guessTitleFromUrl(url) {
    try {
        const u = new URL(url);
        const segments = u.pathname.split("/").filter(Boolean);

        let best = "";
        for (const seg of segments) {
            const decoded = decodeURIComponent(seg).replace(/[-_]+/g, " ").trim();

            const looksLikeId =
                /^\d+$/.test(decoded) || // pure numbers
                /^[A-Z0-9]{8,12}$/.test(seg) || // Amazon-style ASIN
                /^itm[a-z0-9]+$/i.test(seg) || // Flipkart item id
                /^(p|dp|gp|product|products|item|itm)$/i.test(decoded);

            if (looksLikeId) continue;
            if (decoded.length > best.length) best = decoded;
        }

        return best;
    } catch {
        return "";
    }
}

module.exports = {
    NOISE_WORDS,
    ACCESSORY_WORDS,
    looksLikeAccessory,
    normalizeTitle,
    tokenize,
    jaccardOverlap,
    KNOWN_BRANDS,
    detectBrand,
    COLOR_WORDS,
    detectColor,
    detectNetworkGeneration,
    detectPanelTechnology,
    DESCRIPTOR_PHRASES,
    stripDescriptors,
    cleanScrapedTitle,
    guessTitleFromUrl,
};
