/**
 * Normalizes external seed candidates (AI organic URLs, User pasted URLs)
 * into the engine's internal NormalizedOffer contract.
 */
const { isSafeExternalUrl } = require("../utils/url");

const NON_COMMERCE_DOMAINS = new Set([
    "youtube.com", "youtu.be",
    "instagram.com",
    "facebook.com", "fb.com",
    "twitter.com", "x.com",
    "tiktok.com", "pinterest.com",
    "reddit.com"
]);

function injectSeedCandidates(seedCandidates) {
    if (!Array.isArray(seedCandidates) || seedCandidates.length === 0) {
        return [];
    }

    const injected = [];

    for (const seed of seedCandidates) {
        // AI Find uses { link, title, snippet }
        // User pasted URL uses { link: url, title }
        const url = seed.link || seed.url;

        if (!url || typeof url !== "string") continue;
        if (!isSafeExternalUrl(url)) continue;

        try {
            const parsedUrl = new URL(url);
            const hostname = parsedUrl.hostname.replace(/^www\./, "");

            // Phase 27 Fix B: Filter out non-commerce social/content domains
            let isNonCommerce = false;
            for (const domain of NON_COMMERCE_DOMAINS) {
                if (hostname === domain || hostname.endsWith(`.${domain}`)) {
                    isNonCommerce = true;
                    break;
                }
            }
            if (isNonCommerce) continue;


            injected.push({
                productUrl: url,
                price: null, // Critical: Seed candidates are unpriced by default
                availability: "unknown",
                title: seed.title || "",
                store: hostname,
                _candidateSource: "seed_injection",
                _isGoogleRedirectUrl: false,
                _hostname: hostname
            });

            if (injected.length >= 10) break; // Limit to 10
        } catch (e) {
            // Invalid URL, skip
        }
    }

    return injected;
}

module.exports = {
    injectSeedCandidates
};
