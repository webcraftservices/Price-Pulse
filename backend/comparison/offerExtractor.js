/**
 * Offer Extractor
 * ------------------------------------------------------------------
 * Turns raw Serper Shopping API items into NormalizedOffer objects
 * (see stores/storeAdapter.js for the shape). Owns: price parsing,
 * availability parsing, merchant/platform resolution, and picking the
 * best available URL for each offer (see urlResolver.js for the
 * Google-redirect-vs-direct-merchant-URL logic specifically).
 *
 * Never invents a field: missing rating/availability/URL stays null,
 * never guessed. Extracted from stores/googleShopping.js (V1) with no
 * behavior change.
 */

const { normalizeOffer } = require("../services/stores/storeAdapter");
const { parsePrice } = require("../utils/numbers");
const { lookupMerchant, DEFAULT_TIER } = require("../providers/merchants/merchantRegistry");
const { resolveMerchantUrl } = require("./urlResolver");

function platformFromHostname(hostname) {
    const host = (hostname || "").replace(/^www\./, "");
    const key = host.split(".")[0];
    const known = lookupMerchant(key);
    if (known) return { platform: known.label, color: known.color, retailerTier: known.tier, trusted: !!known.trusted };
    // google.com is Serper's Shopping redirect domain, never a real merchant —
    // never derive a fake "Google" store label from it.
    if (key === "google") return { platform: null, color: "default", retailerTier: DEFAULT_TIER, trusted: false };
    const label = key ? key.charAt(0).toUpperCase() + key.slice(1) : host;
    return { platform: label, color: "default", retailerTier: DEFAULT_TIER, trusted: false };
}

// Serper's own "source" field (e.g. "Amazon.in") is more reliable than
// re-deriving a name from the URL, so prefer it when present.
function resolvePlatform(item, hostname) {
    const { platform: hostPlatform, color, retailerTier: hostTier, trusted: hostTrusted } = platformFromHostname(hostname);
    if (!item.source) {
        // No merchant name given and the URL is just a Google redirect — we
        // genuinely don't know which store this is. Don't guess; label it
        // honestly rather than let it silently collapse into a fake "Google"
        // bucket with every other unlabeled listing.
        return { platform: hostPlatform || "Unknown store", color, retailerTier: hostTier, trusted: hostTrusted };
    }

    // Trust classification uses Serper's own `source` merchant field (or,
    // failing that, the resolved hostname above) — never the offer's title
    // or description text (Phase 8 spec Section 16: "'Amazon' appearing
    // inside a product title must NOT classify the offer as Amazon").
    const cleanedSource = String(item.source).replace(/\.(in|com|co)$/i, "").trim();
    const known = lookupMerchant(cleanedSource);
    if (known) return { platform: known.label, color: known.color, retailerTier: known.tier, trusted: !!known.trusted };

    return { platform: cleanedSource || hostPlatform || "Unknown store", color, retailerTier: hostTier, trusted: hostTrusted };
}

// Try to read an availability signal from whatever fields the response
// actually contains. Never invent a status — unknown stays null and is
// rendered as "Check availability" rather than a fabricated "In Stock".
function parseAvailability(item) {
    const raw = (item.availability || item.stock || "").toString().toLowerCase();
    if (!raw) return null;
    if (/out of stock|unavailable|sold out/.test(raw)) return "out_of_stock";
    if (/in stock|available/.test(raw)) return "in_stock";
    return null;
}

/**
 * Converts Serper Shopping API `shopping` items into NormalizedOffer[]
 * (each with extra `_` metadata fields the comparison engine/frontend
 * adapter use — hostname, color, Google-redirect flag, retailer tier).
 * Items with no resolvable URL at all are dropped (we cannot link the
 * user anywhere, so it isn't a usable offer).
 */
function extractOffers(shoppingResults, fallbackTitle) {
    const offers = [];

    for (const item of shoppingResults) {
        const { url: rawUrl, isGoogleRedirect, merchantUrlSource } = resolveMerchantUrl(item);
        if (!rawUrl) continue;

        let hostname;
        try {
            hostname = new URL(rawUrl).hostname.replace(/^www\./, "");
        } catch {
            continue;
        }

        const { platform, color, retailerTier, trusted } = resolvePlatform(item, hostname);

        const offer = normalizeOffer({
            store: platform,
            title: item.title || fallbackTitle,
            price: parsePrice(item.price),
            currency: "INR",
            availability: parseAvailability(item),
            imageUrl: item.imageUrl || null,
            productUrl: rawUrl,
            productId: item.productId || null,
            brand: null,
            model: null,
            rating: typeof item.rating === "number" ? item.rating : null,
        });

        // Stash extra context for the frontend/matching layer without
        // polluting the shared NormalizedOffer contract other adapters use.
        offer._color = color;
        offer._hostname = hostname;
        // True whenever the only URL we have is Google's redirect rather
        // than the merchant's own page — the offer/price/store data is
        // still real, only "View Deal" won't land on the merchant directly.
        offer._isGoogleRedirectUrl = isGoogleRedirect;
        offer._merchantUrlSource = merchantUrlSource;
        offer._retailerTier = retailerTier;
        // Phase 8 — Trusted Retailer layer. Registry-based only (see
        // merchantRegistry.isTrustedMerchant's doc comment); completely
        // independent of _isGoogleRedirectUrl below (spec Section 17: a
        // Google redirect must never itself imply/deny trust).
        offer._isTrustedRetailer = !!trusted;
        // Phase 3 (Merchant URL Resolution) diagnostics — an already-direct
        // URL straight from Serper's own data is "high" confidence and
        // "already_direct" (unchanged pre-Phase-3 behavior: qualityScorer.js
        // has always treated any non-redirect URL as full confidence); a
        // redirect starts as "not_attempted" and may be upgraded to
        // "resolved"/"failed" by compareEngine.js's bounded secondary pass.
        offer._urlConfidenceLevel = isGoogleRedirect ? "low" : "high";
        offer._urlResolutionStatus = isGoogleRedirect ? "not_attempted" : "already_direct";

        offers.push(offer);
    }

    return offers;
}

module.exports = { extractOffers, resolvePlatform, platformFromHostname, parseAvailability };
