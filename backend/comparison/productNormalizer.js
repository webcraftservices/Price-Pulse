/**
 * Product Normalizer
 * ------------------------------------------------------------------
 * Turns a canonical product identity (see productIdentity.js) into a
 * single search query string: prefers strong identifiers (product ID,
 * brand+model) over loose title text, and appends storage/RAM/color
 * only when they aren't already implied by the base text.
 *
 * Character/unit-level normalization (GB/Gb, punctuation, whitespace,
 * Unicode, etc.) lives in utils/text.js and utils/numbers.js — this
 * module is specifically about composing THE search string, not about
 * cleaning individual tokens. Extracted from compareService.js (V1)
 * with no behavior change.
 */

function buildSearchQuery(product) {
    const brand = (product.brand || "").trim();
    const model = (product.model || "").trim();
    const productName = (product.productName || "").trim();
    const name = (product.name || "").trim();
    const storage = (product.storage || "").trim();
    const ram = (product.ram || "").trim();
    const color = (product.color || "").trim();

    let base = "";

    if (product.productId) {
        base = String(product.productId).trim();
    } else if (brand && model) {
        base = `${brand} ${model}`;
    } else if (name) {
        base = name;
    } else if (brand && productName) {
        base = `${brand} ${productName}`;
    } else if (productName) {
        base = productName;
    } else if (brand) {
        base = brand;
    }

    if (!base) return "";

    const extras = [];
    if (storage && !base.toLowerCase().includes(storage.toLowerCase())) extras.push(storage);
    if (ram && !base.toLowerCase().includes(ram.toLowerCase())) extras.push(ram);
    if (color && !base.toLowerCase().includes(color.toLowerCase())) extras.push(color);

    return [base, ...extras].join(" ").replace(/\s+/g, " ").trim();
}

module.exports = { buildSearchQuery };
