/**
 * Merchant Registry
 * ------------------------------------------------------------------
 * Single source of truth for known merchants: display label, retailer
 * tier (for ranking), and — for the allowlisted subset the URL
 * resolver is permitted to target — the merchant's own domain.
 *
 * Extracted from stores/googleShopping.js (PREFERRED_RETAILERS) and
 * stores/merchantUrlResolver.js (MERCHANT_DOMAINS), which previously
 * kept overlapping merchant data in two places. Behavior is unchanged;
 * this just gives both call sites one table instead of two.
 *
 * IMPORTANT: `key` classifies the SELLER (Serper's `source` field / the
 * offer's own hostname), never the product's brand. A reseller selling a
 * Samsung phone has source="Croma" or similar — it is not "Samsung" as a
 * retailer. Only a listing whose actual seller IS Samsung/Apple/etc. (their
 * own storefront) qualifies as that manufacturer's Tier 1 entry.
 */

// tier: "major_retailer" | "known_retailer" | "other_seller" (implicit
// default for anything not listed here — see DEFAULT_TIER below).
//
// domain: the merchant's own domain, only set for merchants the URL
// resolver is allowed to target via a scoped site: search. Absence means
// "not eligible for direct-URL resolution" — the honest Google Shopping
// fallback is kept instead, never a guessed domain.
//
// trusted (Phase 8): a SEPARATE, narrower flag from `tier`. `tier` has
// always driven ranking/display order only; it was never a gate on
// participation, which is exactly why a Tier-3 ("other_seller") listing
// like Mygsm.me could still win bestOffer (see Phase 8 live observation —
// PHASE8 audit). `trusted: true` marks the deliberately small, explicitly
// maintained set of retailers eligible for the DEFAULT "trusted retailers"
// comparison pool. Being `tier: "major_retailer"` does NOT imply
// `trusted: true` — e.g. individual phone-brand storefronts (OnePlus,
// Xiaomi, Motorola) and Tata Cliq are ranked as major_retailer for display
// purposes but are intentionally left out of the initial trusted set below
// pending product-owner review; flipping them to trusted:true later is a
// one-line registry change, never a pipeline change. Absence of `trusted`
// (or any entry not in REGISTRY at all) means untrusted — never guessed.
const REGISTRY = {
    // Tier 1 — major, high-trust general retailers
    amazon: { label: "Amazon", color: "amazon", tier: "major_retailer", domain: "amazon.in", trusted: true },
    flipkart: { label: "Flipkart", color: "flipkart", tier: "major_retailer", domain: "flipkart.com", trusted: true },
    croma: { label: "Croma", color: "croma", tier: "major_retailer", domain: "croma.com", trusted: true },
    "reliance digital": { label: "Reliance Digital", color: "default", tier: "major_retailer", domain: "reliancedigital.in", trusted: true },
    reliancedigital: { label: "Reliance Digital", color: "default", tier: "major_retailer", domain: "reliancedigital.in", trusted: true },
    "vijay sales": { label: "Vijay Sales", color: "default", tier: "major_retailer", domain: "vijaysales.com", trusted: true },
    vijaysales: { label: "Vijay Sales", color: "default", tier: "major_retailer", domain: "vijaysales.com", trusted: true },
    // Tata Cliq is ranked major_retailer but NOT in the Phase 8 initial
    // trusted set (see Phase 8 master prompt Section 6's explicit list) —
    // left available to enable later without any code change.
    "tata cliq": { label: "Tata Cliq", color: "default", tier: "major_retailer" },
    tatacliq: { label: "Tata Cliq", color: "default", tier: "major_retailer" },
    snapdeal: { label: "Snapdeal", color: "default", tier: "major_retailer", domain: "snapdeal.com", trusted: true },

    // Tier 1 — official manufacturer storefronts (only matches when the
    // SELLER itself is the manufacturer, e.g. source="Samsung.com").
    // Only Samsung is in the Phase 8 initial trusted set; the others are
    // ranked major_retailer but not yet trusted — same one-line-flip note
    // as Tata Cliq above.
    samsung: { label: "Samsung", color: "default", tier: "major_retailer", trusted: true },
    apple: { label: "Apple", color: "default", tier: "major_retailer" },
    oneplus: { label: "OnePlus", color: "default", tier: "major_retailer" },
    xiaomi: { label: "Xiaomi", color: "default", tier: "major_retailer" },
    mi: { label: "Mi", color: "default", tier: "major_retailer" },
    motorola: { label: "Motorola", color: "default", tier: "major_retailer" },

    // Tier 2 — recognizable, reputable, but not Tier 1. Myntra and Ajio
    // are in the Phase 8 initial trusted set (fashion category) even
    // though their general tier is "known_retailer" — trusted/tier are
    // independent axes on purpose.
    myntra: { label: "Myntra", color: "myntra", tier: "known_retailer", domain: "myntra.com", trusted: true },
    ajio: { label: "Ajio", color: "ajio", tier: "known_retailer", trusted: true },
    nykaa: { label: "Nykaa", color: "nykaa", tier: "known_retailer" },
    jiomart: { label: "JioMart", color: "default", tier: "known_retailer" },
    "jiomart grocery": { label: "JioMart Grocery", color: "default", tier: "known_retailer" },
    poorvika: { label: "Poorvika", color: "default", tier: "known_retailer" },
    "sangeetha mobiles": { label: "Sangeetha Mobiles", color: "default", tier: "known_retailer" },
};

// Everything not in REGISTRY is "other_seller" — kept, never deleted, just
// deprioritized in sort order.
const DEFAULT_TIER = "other_seller";

function normalizeKey(name) {
    return String(name || "").toLowerCase().replace(/\.(in|com|co)$/i, "").trim();
}

/** Looks up a merchant by name (Serper `source` field or a URL's first
 * hostname label). Returns null if unknown — callers must not guess. */
function lookupMerchant(name) {
    if (!name) return null;
    return REGISTRY[normalizeKey(name)] || null;
}

/** Returns the merchant's own domain if it's in the allowlisted subset
 * eligible for direct-URL resolution, else null. Substring match against
 * the registry key mirrors the resolver's original matching behavior
 * (e.g. "Amazon.in (via Cloudtail)" still matches "amazon"). */
function getResolvableDomain(merchantName) {
    const key = normalizeKey(merchantName);
    for (const [name, entry] of Object.entries(REGISTRY)) {
        if (entry.domain && key.includes(name)) return entry.domain;
    }
    return null;
}

/** Phase 8 — Trusted Retailer classification. Registry-based ONLY: a
 * merchant is trusted if and only if its REGISTRY entry has
 * `trusted: true`. Never derived from title text, rating, review count,
 * or URL directness (Phase 8 spec Sections 16/17/22) — an unknown
 * merchant, or a known-but-not-yet-trusted one (e.g. Tata Cliq today),
 * always returns false here, no matter how the offer's title reads. */
function isTrustedMerchant(merchantName) {
    const entry = lookupMerchant(merchantName);
    return !!(entry && entry.trusted === true);
}

module.exports = { REGISTRY, DEFAULT_TIER, lookupMerchant, getResolvableDomain, isTrustedMerchant };
