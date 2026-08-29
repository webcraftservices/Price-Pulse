/**
 * Product Identity
 * ------------------------------------------------------------------
 * Every entry point (pasted URL, typed text, AI Find) must reduce to
 * the same canonical {name, brand, productName, model, storage, ram,
 * color} shape before searching — this is what lets one matching/
 * search pipeline serve all three, instead of the search query
 * depending on which store's page text happened to be scraped.
 *
 * DOES NOT rely on title text alone where structured data is already
 * available (canonicalizeProduct trusts an already-brand'd input and
 * only fills gaps). Extracted from compareService.js (V1) with no
 * behavior change.
 */

const { cleanScrapedTitle, detectBrand, detectColor, stripDescriptors } = require("../utils/text");
const { extractRamAndStorage } = require("../utils/numbers");

/** Parses a raw title string into canonical product identity fields. */
function extractCanonicalProduct(rawTitle) {
    const cleaned = cleanScrapedTitle(rawTitle) || (rawTitle || "").trim();

    const brand = detectBrand(cleaned);
    const color = detectColor(cleaned);
    // RAM-aware: a naive "first GB number in the text" extractor would grab
    // RAM (e.g. "12GB RAM") instead of storage whenever RAM is mentioned
    // first — a very common phrasing ("12GB RAM, 256GB Storage").
    const { ram, storage } = extractRamAndStorage(cleaned);

    let core = cleaned;
    if (brand) core = core.replace(new RegExp(`\\b${brand}\\b`, "i"), " ");
    core = core.replace(/\([^)]*\)/g, " "); // drop parenthetical spec blocks e.g. "(12 GB RAM)"
    core = core.replace(/\d+\s?(gb|tb|mb)\b/gi, " ");
    core = core.replace(/\bram\b|\brom\b/gi, " ");
    if (color) core = core.replace(new RegExp(color.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), " ");
    core = stripDescriptors(core);
    core = core.replace(/,/g, " ").replace(/\s+/g, " ").trim();

    return {
        name: cleaned,
        brand,
        productName: core || cleaned,
        model: core || null,
        storage,
        ram,
        color,
    };
}

/**
 * Applied once per comparison request, regardless of entry point. If the
 * caller already supplied a structured product (AI Find), trust it and
 * just fill gaps — don't let a cruder text-based parse override good data.
 */
function canonicalizeProduct(sourceProduct) {
    if (sourceProduct.brand) {
        const product = { ...sourceProduct };
        const inferredText = product.name || product.productName || "";
        if (!product.storage || !product.ram) {
            const inferred = extractRamAndStorage(inferredText);
            if (!product.storage && inferred.storage) product.storage = inferred.storage;
            if (!product.ram && inferred.ram) product.ram = inferred.ram;
        }
        return product;
    }

    const parsed = extractCanonicalProduct(sourceProduct.name || "");
    return {
        ...sourceProduct,
        ...parsed,
        name: parsed.name, // use the cleaned title, not the raw scraped/typed one
        image: sourceProduct.image,
    };
}

module.exports = { extractCanonicalProduct, canonicalizeProduct };
