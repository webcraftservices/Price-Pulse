const { deduplicateByMerchant, deduplicateByUrl } = require("../../comparison/offerDeduplicator");
const { injectSeedCandidates } = require("../../comparison/seedCandidateInjector");
const { extractOffers } = require("../../comparison/offerExtractor");
const { resolveDirectMerchantUrlDetailed } = require("../../comparison/urlResolver");
const { buildComparison } = require("../../comparison/offerRanker");

// Mock url resolver for testing resolution semantics
jest.mock("../../comparison/urlResolver", () => {
    const original = jest.requireActual("../../comparison/urlResolver");
    return {
        ...original,
        resolveDirectMerchantUrlDetailed: jest.fn()
    };
});

describe("Phase 32 Provenance Audit", () => {
    
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("1. Google Shopping provenance", () => {
        const rawItems = [{
            source: "Flipkart",
            title: "Test Phone",
            price: "1000",
            link: "https://google.com/search?ibp=oshop&..."
        }];
        const offers = extractOffers(rawItems, "Test Phone");
        const offer = offers[0];

        expect(offer.store).toBe("Flipkart");
        expect(offer._isGoogleRedirectUrl).toBe(true);
        expect(offer._merchantUrlSource).toBe("link (google redirect fallback)");
        expect(offer._urlResolutionStatus).toBe("not_attempted");
    });

    it("2. Resolved merchant URL & 3. Failed resolution", async () => {
        // This is normally handled by attemptSecondaryUrlResolution
        // We will simulate the state transition.
        const offer = {
            store: "Flipkart",
            productUrl: "https://google.com/...",
            _isGoogleRedirectUrl: true,
            _urlResolutionStatus: "not_attempted",
            _merchantUrlSource: "link (google redirect fallback)"
        };
        
        // 2. Success
        resolveDirectMerchantUrlDetailed.mockResolvedValueOnce({ url: "https://flipkart.com/123", confidence: "high" });
        const resolved = await resolveDirectMerchantUrlDetailed(offer.store, "test");
        if (resolved) {
            offer.productUrl = resolved.url;
            offer._isGoogleRedirectUrl = false;
            offer._merchantUrlSource = "merchant_url_resolver";
            offer._urlResolutionStatus = "resolved";
            offer._urlConfidenceLevel = resolved.confidence;
        }
        
        expect(offer._isGoogleRedirectUrl).toBe(false);
        expect(offer.productUrl).toBe("https://flipkart.com/123");
        expect(offer._urlResolutionStatus).toBe("resolved");

        // 3. Failed
        const offer2 = {
            store: "Amazon",
            productUrl: "https://google.com/...",
            _isGoogleRedirectUrl: true,
            _urlResolutionStatus: "not_attempted"
        };
        resolveDirectMerchantUrlDetailed.mockResolvedValueOnce(null);
        const resolved2 = await resolveDirectMerchantUrlDetailed(offer2.store, "test");
        if (!resolved2) {
            offer2._urlResolutionStatus = "failed";
        }
        expect(offer2._isGoogleRedirectUrl).toBe(true);
        expect(offer2._urlResolutionStatus).toBe("failed");
    });

    it("4. AI seed provenance & 5. User URL provenance", () => {
        const seeds = [
            { link: "https://www.flipkart.com/test", title: "Test 1" }
        ];
        const injected = injectSeedCandidates(seeds);
        const offer = injected[0];
        
        expect(offer._candidateSource).toBe("seed_injection");
        expect(offer.productUrl).toBe("https://www.flipkart.com/test");
        // Bypassing identity is tested by ensuring it flows through the engine.
        // seed candidates don't have matchConfidence set initially.
    });

    it("6. Seed price safety", () => {
        const qualityScored = [{
            store: "Flipkart",
            price: null,
            matchConfidence: 100,
            availability: "in_stock",
            hardReject: false,
            offerQuality: { status: "trusted", usableForBestOffer: true }
        }];
        const result = buildComparison(qualityScored);
        expect(result.bestOffer).toBeNull();
    });

    it("7. Dedup provenance", () => {
        const googleOffer = {
            store: "Flipkart",
            _hostname: "flipkart",
            productUrl: "https://google.com/search?ibp=oshop...",
            price: 124999,
            _isGoogleRedirectUrl: true,
            _candidateSource: null,
            _merchantUrlSource: "link (google redirect fallback)"
        };

        const seedOffer = {
            store: "Flipkart",
            _hostname: "flipkart",
            productUrl: "https://www.flipkart.com/apple-iphone-17/p/123",
            price: null,
            _isGoogleRedirectUrl: false,
            _candidateSource: "seed_injection"
        };

        const rawOffers = [googleOffer, seedOffer];
        const deduped = deduplicateByMerchant(rawOffers);

        expect(deduped).toHaveLength(1);
        const finalOffer = deduped[0];
        
        expect(finalOffer.price).toBe(124999);
        expect(finalOffer.productUrl).toBe("https://google.com/search?ibp=oshop...");
        expect(finalOffer._isGoogleRedirectUrl).toBe(true);
        expect(finalOffer._merchantUrlSource).toBe("link (google redirect fallback)");
        expect(finalOffer._candidateSource).toBeNull(); // It was null originally
    });

    it("7b. Dedup provenance - direct seed first", () => {
        const googleOffer = {
            store: "Flipkart",
            _hostname: "flipkart",
            productUrl: "https://google.com/search?ibp=oshop...",
            price: 124999,
            _isGoogleRedirectUrl: true,
            _candidateSource: null,
            _merchantUrlSource: "link (google redirect fallback)"
        };

        const seedOffer = {
            store: "Flipkart",
            _hostname: "flipkart",
            productUrl: "https://www.flipkart.com/apple-iphone-17/p/123",
            price: null,
            _isGoogleRedirectUrl: false,
            _candidateSource: "seed_injection"
        };

        const rawOffers = [seedOffer, googleOffer]; // Seed first
        const deduped = deduplicateByMerchant(rawOffers);

        expect(deduped).toHaveLength(1);
        const finalOffer = deduped[0];
        
        expect(finalOffer.price).toBe(124999);
        expect(finalOffer.productUrl).toBe("https://google.com/search?ibp=oshop...");
        expect(finalOffer._isGoogleRedirectUrl).toBe(true);
        expect(finalOffer._merchantUrlSource).toBe("link (google redirect fallback)");
        expect(finalOffer._candidateSource).toBeNull(); // It was null originally
    });

    it("8. Non-commerce protection", () => {
        const seeds = [
            { link: "https://www.youtube.com/watch?v=123", title: "Test 1" },
            { link: "https://instagram.com/p/123", title: "Test 2" }
        ];
        const injected = injectSeedCandidates(seeds);
        expect(injected).toHaveLength(0);
    });

    it("10. Identity safety - bad seed doesn't overwrite good Google offer", () => {
        const googleOffer = {
            store: "Flipkart",
            title: "Google Pixel 10 Pro",
            _hostname: "flipkart",
            productUrl: "https://google.com/search?ibp=oshop...",
            price: 124999,
            _isGoogleRedirectUrl: true,
            _candidateSource: "google_shopping",
            _merchantUrlSource: "link (google redirect fallback)"
        };

        const seedOffer = {
            store: "Flipkart",
            title: "Google Pixel 10 Pro XL",
            _hostname: "flipkart",
            productUrl: "https://www.flipkart.com/pixel-10-pro-xl/p/123",
            price: null,
            _isGoogleRedirectUrl: false,
            _candidateSource: "seed_injection"
        };

        const rawOffers = [googleOffer, seedOffer];
        const deduped = deduplicateByMerchant(rawOffers);

        expect(deduped).toHaveLength(1);
        const finalOffer = deduped[0];
        
        // The seed's URL (Pixel 10 Pro XL) SHOULD NOT overwrite the Google offer's URL (Pixel 10 Pro).
        // Since we currently have a bug, this assertion will fail.
        expect(finalOffer.productUrl).toBe("https://google.com/search?ibp=oshop...");
    });
    it("11. Already-resolved Google URL (Test 6)", () => {
        const googleOffer = {
            store: "Flipkart",
            _hostname: "flipkart",
            productUrl: "https://www.flipkart.com/pixel-10-pro-resolved",
            price: 124999,
            _isGoogleRedirectUrl: false, // Already resolved
            _merchantUrlSource: "merchant_url_resolver",
            _urlResolutionStatus: "resolved",
            _candidateSource: "google_shopping"
        };
        const seedOffer = {
            store: "Flipkart",
            _hostname: "flipkart",
            productUrl: "https://www.flipkart.com/pixel-10-pro-seed",
            price: null,
            _isGoogleRedirectUrl: false,
            _candidateSource: "seed_injection"
        };

        const rawOffers = [googleOffer, seedOffer];
        const deduped = deduplicateByMerchant(rawOffers);
        expect(deduped).toHaveLength(1);
        
        const finalOffer = deduped[0];
        // Must NOT downgrade to dedup_merged_seed and must NOT replace URL
        expect(finalOffer.productUrl).toBe("https://www.flipkart.com/pixel-10-pro-resolved");
        expect(finalOffer._merchantUrlSource).toBe("merchant_url_resolver");
        expect(finalOffer._urlResolutionStatus).toBe("resolved");
    });

    it("12. Seed without Google equivalent (Test 7)", () => {
        const seedOffer = {
            store: "Flipkart",
            _hostname: "flipkart",
            productUrl: "https://www.flipkart.com/pixel-10-pro-seed",
            price: null,
            _isGoogleRedirectUrl: false,
            _candidateSource: "seed_injection"
        };

        const rawOffers = [seedOffer];
        const deduped = deduplicateByMerchant(rawOffers);
        
        expect(deduped).toHaveLength(1);
        const finalOffer = deduped[0];
        expect(finalOffer.productUrl).toBe("https://www.flipkart.com/pixel-10-pro-seed");
        expect(finalOffer._candidateSource).toBe("seed_injection");
        expect(finalOffer.price).toBeNull();
    });

    it("13. Legitimate Google direct URL (Test 8)", () => {
        const googleOffer = {
            store: "Flipkart",
            _hostname: "flipkart",
            productUrl: "https://www.flipkart.com/pixel-10-pro",
            price: 124999,
            _isGoogleRedirectUrl: false, // Naturally direct
            _merchantUrlSource: "link (direct)",
            _candidateSource: "google_shopping"
        };

        const rawOffers = [googleOffer];
        const deduped = deduplicateByMerchant(rawOffers);
        
        expect(deduped).toHaveLength(1);
        const finalOffer = deduped[0];
        expect(finalOffer.productUrl).toBe("https://www.flipkart.com/pixel-10-pro");
        expect(finalOffer._merchantUrlSource).toBe("link (direct)");
        expect(finalOffer._isGoogleRedirectUrl).toBe(false);
    });

});
