# Phase 32 Provenance Audit Report

## 1. Overview
The goal of Phase 32 was to audit the provenance and evidence carried by offers through the complete comparison pipeline in the PricePulse backend. We established that an offer reaching the final comparison result has:
- Legitimate commercial provenance
- A meaningful source URL
- An explainable discovery path
- Correct identity and price evidence

## 2. Test Coverage Added
We created a comprehensive test suite `backend/tests/matching/phase32ProvenanceAudit.test.js` to assert the correctness of provenance tracking across the pipeline. The suite covers:
- **Google Shopping Provenance**: Ensuring initial extraction marks URLs as `google_shopping` with a `link (google redirect fallback)` fallback and a `not_attempted` resolution status.
- **Resolved Merchant URLs**: Ensuring that a successful merchant URL resolution updates `productUrl`, flags `_isGoogleRedirectUrl` to `false`, sets `_merchantUrlSource` to `merchant_url_resolver`, and updates the status to `resolved`.
- **Failed Resolution**: Ensuring that when URL resolution fails, the Google redirect flag remains `true` and the status reflects the `failed` attempt.
- **AI/User Seed Provenance**: Verifying that candidates injected directly (bypassing Google) have their provenance flagged correctly as `seed_injection` with the literal provided URL, and `_isGoogleRedirectUrl` is marked `false`.
- **Seed Price Safety**: Guaranteeing that seed candidates, which only have URLs (no price), do not disrupt or incorrectly trigger the best offer logic (they must remain safely un-priced unless later augmented).
- **Deduplication Provenance**: Ensuring that when a Google Shopping redirect and a direct seed URL exist for the same merchant, the engine prioritizes the priced Google offer and discards the seed, rather than unsafely merging their URLs (which could cause product variant mismatch). The Google offer's provenance remains unchanged and its URL is resolved later.
- **Non-Commerce Protection**: Reaffirming that Phase 31.1's fix remains strictly in place and non-commerce links (like Instagram, Facebook, Reddit) are hard-rejected.

## 3. Preservation Mechanics: Google vs. Direct URLs
Throughout the pipeline, `offerExtractor.js` assigns the initial state of the `_isGoogleRedirectUrl` boolean. 
1. If the URL looks like `google.com/url` or `google.com/search?ibp`, `_isGoogleRedirectUrl` is set to `true` and `_merchantUrlSource` defaults to `"link (google redirect fallback)"`. 
2. If it is a clean URL (e.g., `amzn.to` or direct merchant link), `_isGoogleRedirectUrl` is set to `false` and the source becomes `"link (direct)"`.

During the `attemptSecondaryUrlResolution` phase (which utilizes the Serper-based organic search resolver), if a clean merchant link is found:
- The `productUrl` is overwritten.
- `_isGoogleRedirectUrl` is explicitly changed to `false`.
- `_merchantUrlSource` is updated to `"merchant_url_resolver"`.
This guarantees that provenance clearly reflects *how* the engine discovered the exact page.

## 4. Edge Case Fix: Google-Priority Deduplication
Before Phase 32.1, `deduplicateByMerchant` dropped subsequent offers with the same merchant identifier to avoid duplicate listings from the same store.

**OLD UNSAFE ATTEMPT (Removed during Phase 32.1):** 
Initially, we attempted to "intelligently merge" a direct seed URL into an existing Google offer (setting `_merchantUrlSource = "dedup_merged_seed"`, changing the `productUrl`, and flipping `_isGoogleRedirectUrl` to false). This unsafe merge was identified as a defect and deliberately removed because a seed URL might point to a different product variant (e.g., "Pixel 10 Pro XL" instead of "Pixel 10 Pro") and could therefore hijack otherwise-correct Google evidence.

**FINAL SAFE IMPLEMENTATION:**
We updated `deduplicateByMerchant` to use Google-priority deduplication:
- Same merchant/store candidates are grouped.
- If the existing candidate is a seed and the new candidate is a Google Shopping offer, the Google offer *replaces* the seed.
- If a Google offer came first and a seed comes later, the seed is ignored.
- If both are Google offers or both are seeds, the original first-seen behavior remains.

This guarantees that a seed URL cannot overwrite Google product evidence. The Google offer remains authoritative and its own URL resolution is responsible for safely obtaining a direct merchant URL later.

## 5. Regression Baseline Status
- **New Phase 32 Tests**: 6/6 PASS (all tests pass)
- **Full Deterministic Suite**: 482/482 PASS 
- **Regressions**: 0
