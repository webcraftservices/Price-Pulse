/**
 * Phase 6 — Variant Suffix Chipset-Context False-Positive Fix
 * ------------------------------------------------------------------
 * Root cause: extractVariantSuffixes() (utils/numbers.js) scanned the
 * WHOLE normalized title for VARIANT_SUFFIX_WORDS with no awareness of
 * context. A chipset name like "Snapdragon 8 Elite Gen5" contains the
 * literal word "elite", which is also a phone-variant word (Galaxy S
 * Ultra vs a hypothetical "Elite" edition) — so Gate 1
 * (evaluateVariantIdentity, services/productMatcher.js) saw "elite" on
 * the candidate side only and hard-rejected an otherwise-exact listing
 * as VARIANT_MISMATCH. Same mechanism affected the separate "gen2"
 * check against "Snapdragon 8 Gen 2" / "Gen 3" chipset names.
 *
 * Fix: mask known chipset/processor name spans (Snapdragon, Dimensity,
 * Exynos, Kirin, Helio, Tensor, Apple A-series) out of the text before
 * variant-suffix scanning, so chip vocabulary can never be read as a
 * phone variant — while a genuine phone variant word appearing OUTSIDE
 * a chipset span (i.e. as part of the actual product name) is completely
 * unaffected and still hard-rejects real mismatches exactly as before.
 *
 * This suite is a PERMANENT regression guard for the exact live failure
 * reported against "Samsung Galaxy S26 Ultra 12GB 256GB" / the Danzaa
 * Store candidate, plus the general false-positive class it belongs to.
 *
 * USAGE: node tests/matching/variantSuffixContext.test.js
 */

const assert = require("assert");
const path = require("path");

const { extractVariantSuffixes, maskChipsetContext } = require(path.join(__dirname, "..", "..", "utils", "numbers"));
const { computeMatchConfidence, evaluateVariantIdentity } = require(path.join(__dirname, "..", "..", "services", "productMatcher"));

const results = [];
function test(name, fn) {
    try {
        fn();
        results.push({ name, pass: true });
        console.log(`PASS  ${name}`);
    } catch (err) {
        results.push({ name, pass: false, error: err.message });
        console.log(`FAIL  ${name}`);
        console.log(`      ${err.message}`);
    }
}

const REQUEST_S26_ULTRA = { brand: "Samsung", model: "Galaxy S26 Ultra", productName: "Galaxy S26 Ultra", storage: "256GB" };
const REQUEST_S26_PLAIN = { brand: "Samsung", model: "Galaxy S26", productName: "Galaxy S26" };

// -----------------------------------------------------------------------
// 1. The exact reported live bug (Danzaa Store candidate)
// -----------------------------------------------------------------------
console.log("=== 1. Exact reported bug: Snapdragon 8 Elite Gen5 must not trigger VARIANT_MISMATCH ===");

test("Reported bug: 'Samsung Galaxy S26 Ultra, 12GB+256GB, 5G Dual SIM Phone (Snapdragon 8 Elite Gen5)' is NOT variant_mismatch", () => {
    const r = evaluateVariantIdentity(
        REQUEST_S26_ULTRA,
        "Samsung Galaxy S26 Ultra, 12GB+256GB, 5G Dual SIM Phone (Snapdragon 8 Elite Gen5)"
    );
    assert.strictEqual(r.hardReject, false, `expected no hard reject, got: ${r.reason}`);
});

test("Reported bug (full pipeline via computeMatchConfidence): candidate is no longer HARD_REJECT", () => {
    const r = computeMatchConfidence(
        REQUEST_S26_ULTRA,
        "Samsung Galaxy S26 Ultra, 12GB+256GB, 5G Dual SIM Phone (Snapdragon 8 Elite Gen5)"
    );
    assert.notStrictEqual(r.matchDecision, "HARD_REJECT", `expected candidate to survive Gate 1, got: ${r.reason}`);
    assert.strictEqual(r.hardReject, false);
});

// -----------------------------------------------------------------------
// 2. FALSE POSITIVE CONTROLS — chipset vocabulary must never create a
//    phone variant, across all listed SoC families.
// -----------------------------------------------------------------------
console.log("\n=== 2. False-positive controls: chipset names must not be read as phone variants ===");

test("'Snapdragon 8 Elite' alone contributes no variant suffix", () => {
    const found = extractVariantSuffixes("Samsung Galaxy S26 Ultra Snapdragon 8 Elite");
    assert.ok(!found.has("elite"), `expected no 'elite', got: [${[...found].join(",")}]`);
});

test("'Snapdragon 8 Elite Gen5' contributes no variant suffix AND no gen2 suffix", () => {
    const found = extractVariantSuffixes("Samsung Galaxy S26 Ultra Snapdragon 8 Elite Gen5");
    assert.ok(!found.has("elite"));
    assert.ok(!found.has("gen2"));
});

test("'Snapdragon 8 Gen 3' does not falsely trigger the gen2 signal", () => {
    const found = extractVariantSuffixes("Samsung Galaxy S26 Ultra Snapdragon 8 Gen 3");
    assert.ok(!found.has("gen2"));
});

test("'Snapdragon 8 Gen 2' does not falsely trigger the gen2 signal (chip generation != device generation)", () => {
    const found = extractVariantSuffixes("Samsung Galaxy S26 Ultra Snapdragon 8 Gen 2");
    assert.ok(!found.has("gen2"), "chip's own 'Gen 2' must not be read as the phone being a 2nd-gen model");
});

test("'Snapdragon 8 Plus Gen 1' (spelled-out Plus) contributes no variant suffix", () => {
    const found = extractVariantSuffixes("Samsung Galaxy S26 Ultra Snapdragon 8 Plus Gen 1");
    assert.ok(!found.has("plus"), `expected no 'plus', got: [${[...found].join(",")}]`);
});

test("Dimensity processor name contributes no variant suffix", () => {
    const found = extractVariantSuffixes("Redmi Note 14 Pro Dimensity 9400 Elite Edition Chip");
    // "elite" here is describing the chip binning, immediately after the
    // chip family name — must be masked; "pro" is the genuine device
    // variant and must survive.
    assert.ok(!found.has("elite"), `expected no 'elite' from chipset context, got: [${[...found].join(",")}]`);
    assert.ok(found.has("pro"), "genuine device variant word 'pro' must still be detected");
});

test("Exynos processor name contributes no variant suffix", () => {
    const found = extractVariantSuffixes("Samsung Galaxy S26 Ultra Exynos 2500");
    assert.strictEqual(found.size, 1);
    assert.ok(found.has("ultra"));
});

test("Kirin processor name contributes no variant suffix", () => {
    const found = extractVariantSuffixes("Huawei Mate 70 Pro Kirin 9020");
    assert.ok(found.has("pro"));
    assert.strictEqual(found.size, 1, `expected only the genuine 'pro', got: [${[...found].join(",")}]`);
});

test("Helio processor name contributes no variant suffix", () => {
    const found = extractVariantSuffixes("Realme Neo 7 Helio Elite Edition");
    // "Neo" is a genuine Realme sub-brand/variant word here; the chip's
    // "Elite" naming must not add a second, spurious variant.
    assert.ok(found.has("neo"));
    assert.ok(!found.has("elite"), `expected chipset 'elite' masked, got: [${[...found].join(",")}]`);
});

test("Tensor processor name contributes no variant suffix", () => {
    const found = extractVariantSuffixes("Google Pixel 10 Pro Tensor G5 Max Performance Core");
    assert.ok(found.has("pro"));
    // "Max" directly following the Tensor chip clause is chip vocabulary,
    // not a device edition — Google does not sell a Pixel "Max".
    assert.ok(!found.has("max"), `expected chipset-adjacent 'max' masked, got: [${[...found].join(",")}]`);
});

test("Apple A-series 'A17 Pro' chip name contributes no separate variant signal beyond the device's own naming", () => {
    const found = extractVariantSuffixes("Apple iPhone 15 Pro A17 Pro Chip 256GB");
    assert.ok(found.has("pro"), "device is genuinely Pro — must still be detected");
    // Only one masked occurrence removed; the device-name occurrence
    // remains, so 'pro' is still present via normal (non-chipset) text.
});

test("Apple A-series 'A16 Bionic' chip contributes no variant suffix at all", () => {
    const found = extractVariantSuffixes("Apple iPhone 15 A16 Bionic Chip 128GB");
    assert.strictEqual(found.size, 0, `expected no variant suffixes, got: [${[...found].join(",")}]`);
});

// -----------------------------------------------------------------------
// 3. TRUE POSITIVE CONTROLS — genuine variant words, unrelated to any
//    chipset, must still be detected exactly as before.
// -----------------------------------------------------------------------
console.log("\n=== 3. True-positive controls: genuine phone variants are unaffected ===");

test("'Galaxy S26 Ultra' still detects 'ultra'", () => {
    const found = extractVariantSuffixes("Samsung Galaxy S26 Ultra");
    assert.ok(found.has("ultra"));
});

test("'Galaxy S26+' (normalized) still detects 'plus' via the + expansion path unaffected", () => {
    // '+' is stripped by normalizeTitle upstream of this function; this
    // case is about the bare 'S26' vs 'S26 Ultra' family gate elsewhere,
    // included here only to confirm masking introduces no regression.
    const found = extractVariantSuffixes("Samsung Galaxy S26 Plus");
    assert.ok(found.has("plus"));
});

test("'Galaxy S26 Pro' still detects 'pro'", () => {
    const found = extractVariantSuffixes("Samsung Galaxy S26 Pro");
    assert.ok(found.has("pro"));
});

test("'Galaxy S26 Edge' — no suffix word list entry for 'edge', correctly yields no variant (untouched behavior)", () => {
    const found = extractVariantSuffixes("Samsung Galaxy S26 Edge");
    assert.strictEqual(found.size, 0);
});

test("[Phase 14 Fix A] 'Galaxy S26 FE' — 'fe' is now a recognized suffix word (Fan Edition is a distinct product line, e.g. Tab S9 vs Tab S9 FE)", () => {
    const found = extractVariantSuffixes("Samsung Galaxy S26 FE");
    assert.ok(found.has("fe"));
});

test("'iPhone Pro' still detects 'pro'", () => {
    const found = extractVariantSuffixes("Apple iPhone 17 Pro");
    assert.ok(found.has("pro"));
});

test("'iPhone Pro Max' still detects both 'pro' and 'max'", () => {
    const found = extractVariantSuffixes("Apple iPhone 17 Pro Max");
    assert.ok(found.has("pro"));
    assert.ok(found.has("max"));
});

test("'Pixel Pro' still detects 'pro'", () => {
    const found = extractVariantSuffixes("Google Pixel 10 Pro");
    assert.ok(found.has("pro"));
});

test("'Pixel Pro XL' still detects 'pro' ('xl' is not in the suffix list, untouched behavior)", () => {
    const found = extractVariantSuffixes("Google Pixel 10 Pro XL");
    assert.ok(found.has("pro"));
});

test("Genuine 'gen2' phrasing ('2nd Generation') outside any chipset context still fires", () => {
    const found = extractVariantSuffixes("Apple AirPods (2nd Generation)");
    assert.ok(found.has("gen2"));
});

test("Genuine 'Gen 2' phrasing outside chipset context still fires", () => {
    const found = extractVariantSuffixes("Sony Gen 2 Earbuds");
    assert.ok(found.has("gen2"));
});

// -----------------------------------------------------------------------
// 4. COMBINED CASES — chipset noise must never mask a REAL mismatch.
// -----------------------------------------------------------------------
console.log("\n=== 4. Combined cases: chipset masking must not suppress genuine mismatches ===");

test("Exact requested product + chipset noise -> NOT a mismatch", () => {
    const r = evaluateVariantIdentity(
        REQUEST_S26_ULTRA,
        "Samsung Galaxy S26 Ultra 12GB+256GB Snapdragon 8 Elite Gen5"
    );
    assert.strictEqual(r.hardReject, false, `expected pass, got: ${r.reason}`);
});

test("Plain S26 (no Ultra) + chipset noise -> STILL a genuine variant_mismatch against an Ultra request", () => {
    const r = evaluateVariantIdentity(
        REQUEST_S26_ULTRA,
        "Samsung Galaxy S26 12GB 256GB Snapdragon 8 Elite Gen5"
    );
    assert.strictEqual(r.hardReject, true, "a plain S26 must still be rejected when Ultra was requested, chipset text notwithstanding");
    assert.strictEqual(r.primaryIssue, "variant_mismatch");
});

test("Requesting plain S26 but candidate is genuinely Ultra (chipset noise present) -> still rejected", () => {
    const r = evaluateVariantIdentity(
        REQUEST_S26_PLAIN,
        "Samsung Galaxy S26 Ultra 12GB 256GB Snapdragon 8 Elite Gen5"
    );
    assert.strictEqual(r.hardReject, true);
    assert.strictEqual(r.primaryIssue, "variant_mismatch");
});

test("Real family/variant mismatch (Pro vs Ultra) is unaffected by chipset masking", () => {
    const r = evaluateVariantIdentity(
        { brand: "Samsung", model: "Galaxy S26 Pro", productName: "Galaxy S26 Pro" },
        "Samsung Galaxy S26 Ultra Snapdragon 8 Elite Gen5"
    );
    assert.strictEqual(r.hardReject, true);
    assert.strictEqual(r.primaryIssue, "variant_mismatch");
});

// -----------------------------------------------------------------------
// 5. maskChipsetContext — direct unit checks on the masking primitive
// -----------------------------------------------------------------------
console.log("\n=== 5. maskChipsetContext direct unit checks ===");

test("Masks 'snapdragon 8 elite gen5' entirely, preserves surrounding text and length", () => {
    const input = "samsung galaxy s26 ultra snapdragon 8 elite gen5 12gb 256gb";
    const masked = maskChipsetContext(input);
    assert.strictEqual(masked.length, input.length, "masking must preserve string length (char-for-char underscore replacement)");
    assert.ok(!/elite/.test(masked));
    assert.ok(/samsung galaxy s26 ultra/.test(masked), "text before the chipset clause must be untouched");
    assert.ok(/12gb 256gb/.test(masked), "text after the chipset clause must be untouched");
});

test("Does not mask Apple Mac M-series ('m3 max') — that IS the Mac's own variant", () => {
    const input = "apple macbook pro 14 m3 max 1tb";
    const masked = maskChipsetContext(input);
    assert.strictEqual(masked, input, "M-series must be left completely untouched by chipset masking");
});

test("Text with no chipset mention is returned unchanged", () => {
    const input = "samsung galaxy s26 ultra 12gb 256gb titanium black";
    assert.strictEqual(maskChipsetContext(input), input);
});

// -----------------------------------------------------------------------
// SUMMARY
// -----------------------------------------------------------------------
console.log("\n=== SUMMARY ===");
const passed = results.filter((r) => r.pass).length;
console.log(`${passed}/${results.length} passed`);
if (passed !== results.length) process.exitCode = 1;
