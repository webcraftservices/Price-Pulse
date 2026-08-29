/**
 * Product Type Classifier
 * ------------------------------------------------------------------
 * Root-cause context: the matcher previously only scored TOKEN
 * OVERLAP + brand/model/variant text. "Samsung Galaxy S26 Ultra 256GB
 * 12GB RAM Motherboard PCB" shares almost every token with the
 * requested phone, so it scored confidence=1.0 despite being a spare
 * part, not the phone. Token overlap is evidence of IDENTITY only once
 * two listings are already known to be the same TYPE of product —
 * this module supplies that missing check.
 *
 * Two cooperating pieces:
 *   1. classifyProductType(text) — general, category-based, works for
 *      any product line (not Samsung-specific). Recognizes ~20 main
 *      product categories (spec Step 2) via broad keyword signals, and
 *      separately recognizes "this text is describing a PART/ACCESSORY/
 *      COMPONENT, not a whole product" (spec Step 4) via a dedicated
 *      signal set that is checked FIRST — a title can contain both a
 *      product-line pattern ("Galaxy S26 Ultra") and a part signal
 *      ("Motherboard"), and the part signal must win, exactly like the
 *      Cellspare listing.
 *   2. detectProductTypeConflict(requestedType, candidateType) — the
 *      compatibility rule. See the "asymmetric part rule" comment
 *      below for why this deliberately does NOT require the requested
 *      type to be confidently known before rejecting an obvious part.
 *
 * Deterministic, rule-based, no external/AI call — matches spec Step 2's
 * explicit instruction not to add an expensive classification call.
 */

const { normalizeTitle } = require("../utils/text");

// ---------------------------------------------------------------------
// Category signal tables
// ---------------------------------------------------------------------

// A listing matching any of these is a PART, not a whole product — checked
// BEFORE main-category signals, category-aware per spec Step 4 (these are
// only a conflict when the REQUEST wasn't also for this same kind of part —
// see detectProductTypeConflict). Phrases are matched as substrings against
// normalizeTitle() output (lowercase, punctuation stripped to spaces), so
// hyphenated/punctuated variants ("Screen-Protector", "Ear Pads (Pair)")
// still match.
const PART_TYPE_SIGNALS = {
    replacement_part: [
        "motherboard", "pcb", "mainboard", "logic board", "replacement board",
        "circuit board", "charging board", "power board",
        // screen/display/LCD: both word orders ("screen replacement" AND
        // "replacement screen") since real listing titles use either —
        // the earlier version only had one direction and would have missed
        // "Replacement Screen for Galaxy S26 Ultra"-style titles.
        "display replacement", "replacement display", "screen replacement",
        "replacement screen", "lcd replacement", "replacement lcd",
        "lcd panel", "lcd screen", "oled panel", "amoled panel",
        "digitizer", "touch screen replacement",
        "battery replacement", "replacement battery",
        "charging port replacement", "charging connector",
        "camera module", "camera replacement", "replacement camera",
        "flex cable", "connector replacement", "replacement connector",
        "speaker replacement", "earpiece replacement", "microphone replacement",
        "back glass", "back panel replacement",
        "housing replacement", "replacement housing", "frame replacement",
        "replacement frame", "shell replacement", "replacement shell",
        "body replacement", "replacement body",
        "repair part", "repair kit", "repair component", "spare part",
        "housing frame", "midframe",
    ],
    accessory: [
        "case", "cover", "pouch", "skin", "screen guard", "screen protector",
        "tempered glass", "charger", "charging cable", "usb cable", "cable",
        "adapter", "strap", "band", "stand", "holder", "sticker", "decal",
        "mount", "sleeve", "ear pads", "ear cushions", "earpads", "enclosure",
        "heatsink", "heat sink", "cooling accessory", "cooling pad", "water block",
        "cooling fan", "replacement fan", "fan replacement", "case fan",
        "controller", "dock", "docking station", "car mount", "power bank",
        "lens cap", "lens filter", "tripod", "keyboard cover", "screen film",
        "connector",
    ],
    component: ["internal component", "replacement part"],
};

// Main whole-product categories a listing can belong to (spec Step 2). Not
// exhaustive — absence of a signal just means "unknown", which is never by
// itself a reason to reject (spec Step 3). Checked in this order so a more
// specific sub-line (e.g. "galaxy tab") is recognized before the broader
// "galaxy s"-style smartphone pattern could otherwise be reached.
const PRODUCT_CATEGORY_SIGNALS = [
    ["tablet", ["tablet", "ipad", "galaxy tab", " tab s", " tab a", "surface pro", "surface go"]],
    ["smartwatch", ["smartwatch", "smart watch", "galaxy watch", "apple watch", "watch series", "fitness band", "fitness tracker"]],
    ["earbuds", ["earbuds", "earphones", "true wireless", " tws ", "airpods", "galaxy buds", "in-ear", "in ear"]],
    ["headphones", ["headphones", "headphone", "over-ear", "over ear", "on-ear", "on ear", "wh 1000x", "noise cancelling headphone"]],
    ["laptop", ["laptop", "notebook", "macbook", "thinkpad", "zenbook", "ideapad", "vivobook", "chromebook", "ultrabook", "gaming laptop"]],
    ["desktop", ["desktop pc", "desktop computer", "all-in-one pc", "all in one pc", "imac", "tower pc", "gaming pc", "mini pc"]],
    ["monitor", ["gaming monitor", "curved monitor", "led monitor", "computer monitor", " monitor "]],
    ["television", ["television", "smart tv", "led tv", "oled tv", "qled tv", " inch tv", " tv "]],
    ["camera", ["dslr", "mirrorless camera", "camera body", "point and shoot", "action camera", "gopro", "digital camera"]],
    ["gaming_console", ["playstation", "ps5", "ps4", "xbox series", "xbox one", "nintendo switch", "gaming console"]],
    ["graphics_card", ["graphics card", " gpu ", " rtx ", " gtx ", "radeon rx", "geforce"]],
    ["cpu", ["processor", " cpu ", " ryzen ", "core i9", "core i7", "core i5", "core i3", "threadripper"]],
    ["ssd", [" ssd", "nvme", "solid state drive", "m.2 ssd"]],
    ["hdd", [" hdd", "hard disk drive", "hard drive"]],
    ["ram", ["ram module", "desktop ram", "laptop ram", "ddr4 ram", "ddr5 ram", "memory module", "memory kit"]],
    ["printer", ["printer", "inkjet printer", "laser printer"]],
    ["appliance", ["refrigerator", "washing machine", "microwave oven", "air conditioner", " ac unit", "dishwasher", "water purifier"]],
    // Smartphone last — its signals are the broadest (bare "galaxy s"/"galaxy
    // a" product-line prefixes) and would otherwise shadow the more specific
    // categories above (e.g. "galaxy tab", "galaxy watch", "galaxy buds").
    ["smartphone", [
        "smartphone", "mobile phone", "android phone", "5g phone", "dual sim",
        "handset", "iphone", "galaxy s", "galaxy z fold", "galaxy z flip",
        "galaxy note", "galaxy a", "galaxy m", "galaxy f", "pixel ", "oneplus ",
        "redmi note", "redmi ", "poco ", "realme ", "moto g", "moto edge",
        "xperia", "nothing phone",
    ]],
];

function matchesAnySignal(normalizedText, signals) {
    for (const phrase of signals) {
        const needle = normalizeTitle(phrase);
        if (needle && normalizedText.includes(needle)) return phrase.trim();
    }
    return null;
}

/**
 * Classifies one piece of text (a canonical product's combined identity
 * text, or a candidate listing's title) into a product type.
 *
 * Returns:
 *   { type: string, isPart: boolean, partType: "accessory"|"replacement_part"|"component"|null, matchedSignal: string|null }
 *
 * `type` is always populated: the part type when isPart is true, the main
 * category when a main-category signal was found, or "unknown" when
 * neither matched — "unknown" is deliberately not a rejection signal by
 * itself (spec Step 3/7).
 */
function classifyProductType(text) {
    const normalized = normalizeTitle(text || "");
    if (!normalized) return { type: "unknown", isPart: false, partType: null, matchedSignal: null };

    // Part signals are checked FIRST and win even when a main-category
    // pattern also matches — this is exactly what makes the Cellspare
    // listing ("...Galaxy S26 Ultra... Motherboard PCB") classify as a
    // replacement part despite also containing a smartphone-line pattern.
    for (const partType of ["replacement_part", "accessory", "component"]) {
        const hit = matchesAnySignal(normalized, PART_TYPE_SIGNALS[partType]);
        if (hit) return { type: partType, isPart: true, partType, matchedSignal: hit };
    }

    for (const [category, signals] of PRODUCT_CATEGORY_SIGNALS) {
        const hit = matchesAnySignal(normalized, signals);
        if (hit) return { type: category, isPart: false, partType: null, matchedSignal: hit };
    }

    return { type: "unknown", isPart: false, partType: null, matchedSignal: null };
}

/**
 * Decides whether a candidate's product type conflicts with the
 * requested one. requestedClass/candidateClass are classifyProductType()
 * results.
 *
 * ASYMMETRIC PART RULE (this is the actual fix for the Cellspare bug):
 * if the CANDIDATE is a part/accessory/component, it conflicts with the
 * request UNLESS the request was explicitly for that same kind of part
 * ("motherboard" search -> "motherboard" is a positive signal, spec Step
 * 4). Critically, this does NOT require the requested type's MAIN
 * category to be confidently known — "Samsung 990 Pro 2TB" has no
 * literal "ssd" keyword in the bare query, so requestedType would
 * otherwise classify as "unknown", but a candidate "Samsung 990 Pro
 * Heatsink" must still be rejected. Requiring a known main-category match
 * before rejecting parts would silently defeat the whole feature for any
 * product line not in the (necessarily incomplete) category keyword
 * tables. Only symmetry with the SAME part type grants an exception.
 *
 * A secondary, weaker check also flags a conflict when BOTH sides
 * classified into known, DIFFERENT main categories (e.g. requested
 * smartphone, candidate tablet) — useful, but not what the reported bug
 * needed, so it only fires when both types are confidently known.
 *
 * Returns { conflict: boolean, reason: string|null }.
 */
function detectProductTypeConflict(requestedClass, candidateClass) {
    if (candidateClass.isPart) {
        const requestedSamePart = requestedClass.isPart && requestedClass.partType === candidateClass.partType;
        if (!requestedSamePart) {
            return {
                conflict: true,
                reason: `candidate is a ${candidateClass.partType.replace(/_/g, " ")} ("${candidateClass.matchedSignal}"), not the requested product`,
            };
        }
        return { conflict: false, reason: null };
    }

    if (
        !requestedClass.isPart &&
        requestedClass.type !== "unknown" &&
        candidateClass.type !== "unknown" &&
        requestedClass.type !== candidateClass.type
    ) {
        return {
            conflict: true,
            reason: `candidate product type "${candidateClass.type}" does not match requested type "${requestedClass.type}"`,
        };
    }

    return { conflict: false, reason: null };
}

module.exports = {
    classifyProductType,
    detectProductTypeConflict,
    PART_TYPE_SIGNALS,
    PRODUCT_CATEGORY_SIGNALS,
};
