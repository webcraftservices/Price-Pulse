/**
 * Normalizes external seed candidates (AI organic URLs, User pasted URLs)
 * into the engine's internal NormalizedOffer contract.
 */
const { isSafeExternalUrl } = require("../utils/url");

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
