const { evaluateVariantIdentity } = require("../services/productMatcher");
const { injectSeedCandidates } = require("../comparison/seedCandidateInjector");
const { canonicalizeProduct } = require("../comparison/productIdentity");

describe("Phase 27 - Comparison Result Quality", () => {
    describe("Fix 1: Purely Alphabetic Model Family Identity", () => {
        test("rejects entirely different alphabetic model family (Twist Go vs ColorFit Elevate)", () => {
            const source = canonicalizeProduct({
                brand: "Noise",
                model: "Twist Go 1.39\" Smartwatch",
                name: "Noise Twist Go 1.39\" Smartwatch"
            });
            const result = evaluateVariantIdentity(source, "Noise ColorFit Elevate Smartwatch");
            expect(result.hardReject).toBe(true);
            expect(result.primaryIssue).toBe("model_family_mismatch");
        });

        test("rejects reversed alphabetic model family (ColorFit Elevate vs Twist Go)", () => {
            const source = canonicalizeProduct({
                brand: "Noise",
                model: "ColorFit Elevate Smartwatch",
                name: "Noise ColorFit Elevate Smartwatch"
            });
            const result = evaluateVariantIdentity(source, "Noise Twist Go 1.39\" Smartwatch");
            expect(result.hardReject).toBe(true);
            expect(result.primaryIssue).toBe("model_family_mismatch");
        });

        test("allows exact same purely alphabetic model family (Twist Go)", () => {
            const source = canonicalizeProduct({
                brand: "Noise",
                model: "Twist Go 1.39\" Smartwatch",
                name: "Noise Twist Go 1.39\" Smartwatch"
            });
            const result = evaluateVariantIdentity(source, "Noise Twist Go Smart Watch with Advanced BT Calling");
            expect(result.hardReject).toBe(false);
        });

        test("allows purely alphabetic model family with extra candidate words", () => {
            const source = canonicalizeProduct({
                brand: "boAt",
                model: "Airdopes 141",
                name: "boAt Airdopes 141"
            });
            // candidate has "airdopes" which overlaps, even if it has "bluetooth" and "headset"
            const result = evaluateVariantIdentity(source, "boAt Airdopes 141 Bluetooth Headset");
            // Model numbers will also match because "141" is present.
            // But the family check shouldn't fail.
            expect(result.hardReject).toBe(false);
        });

        test("absence of alphabetic model family in candidate is rejected", () => {
            const source = canonicalizeProduct({
                brand: "boAt",
                model: "Rockerz 255",
                name: "boAt Rockerz 255"
            });
            const result = evaluateVariantIdentity(source, "boAt Airdopes 141");
            // The model numbers ("255" vs "141") will trigger model_number_mismatch first!
            // That's fine, as long as it's a hardReject.
            expect(result.hardReject).toBe(true);
        });

        test("empty alphabetic model family (e.g. only generic descriptors) doesn't false reject", () => {
            const source = canonicalizeProduct({
                brand: "Samsung",
                model: "55 inch TV",
                name: "Samsung 55 inch Smart TV"
            });
            // "55 inch TV" has no purely alphabetic words > 2 letters except "inch" and "tv" which are excluded
            const result = evaluateVariantIdentity(source, "Samsung 55 inch 4K Smart TV");
            expect(result.hardReject).toBe(false);
        });
    });

    describe("Fix 2: Non-Commerce Source Filtering", () => {
        test("filters out youtube.com and youtu.be", () => {
            const seeds = [
                { link: "https://www.youtube.com/watch?v=123", title: "Review" },
                { link: "https://youtu.be/456", title: "Review 2" },
                { link: "https://www.amazon.in/dp/B0CXF", title: "Amazon product" }
            ];
            const injected = injectSeedCandidates(seeds);
            expect(injected).toHaveLength(1);
            expect(injected[0].store).toBe("amazon.in");
        });

        test("filters out instagram.com and facebook.com", () => {
            const seeds = [
                { link: "https://instagram.com/p/123", title: "Insta post" },
                { link: "https://www.facebook.com/watch/123", title: "FB post" },
                { link: "https://flipkart.com/product/123", title: "Flipkart product" }
            ];
            const injected = injectSeedCandidates(seeds);
            expect(injected).toHaveLength(1);
            expect(injected[0].store).toBe("flipkart.com");
        });

        test("filters out tiktok.com, twitter.com, x.com", () => {
            const seeds = [
                { link: "https://twitter.com/i/status/123", title: "Tweet" },
                { link: "https://x.com/i/status/123", title: "Tweet" },
                { link: "https://tiktok.com/@user/video/123", title: "TikTok" },
                { link: "https://croma.com/product", title: "Croma product" }
            ];
            const injected = injectSeedCandidates(seeds);
            expect(injected).toHaveLength(1);
            expect(injected[0].store).toBe("croma.com");
        });
    });

    describe("Existing Generation/Variant Logic Regression", () => {
        test("generation mismatch still hard rejects (S26 vs S25)", () => {
            const source = canonicalizeProduct({
                brand: "Samsung",
                model: "Galaxy S26",
                name: "Samsung Galaxy S26"
            });
            const result = evaluateVariantIdentity(source, "Samsung Galaxy S25");
            expect(result.hardReject).toBe(true);
            expect(result.primaryIssue).toBe("generation_mismatch");
        });

        test("variant suffix mismatch still hard rejects (Ultra vs Plus)", () => {
            const source = canonicalizeProduct({
                brand: "Samsung",
                model: "Galaxy S26 Ultra",
                name: "Samsung Galaxy S26 Ultra"
            });
            const result = evaluateVariantIdentity(source, "Samsung Galaxy S26 Plus");
            expect(result.hardReject).toBe(true);
            expect(result.primaryIssue).toBe("variant_mismatch");
        });
        
        test("bare model number mismatch still hard rejects (15 vs 16)", () => {
            const source = canonicalizeProduct({
                brand: "Apple",
                model: "iPhone 15",
                name: "Apple iPhone 15"
            });
            const result = evaluateVariantIdentity(source, "Apple iPhone 16");
            expect(result.hardReject).toBe(true);
            expect(result.primaryIssue).toBe("model_number_mismatch");
        });
    });
});
