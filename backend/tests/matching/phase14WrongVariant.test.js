/**
 * Phase 14 — Wrong-Variant Root Cause Fix
 * ------------------------------------------------------------------
 * Root cause (read-only investigation): four confirmed gaps in
 * services/productMatcher.js / utils/numbers.js let a wrong PRODUCT
 * VARIANT (not a wrong product) score as an EXACT/STRONG match:
 *
 *   Fix A — a substring-containment bug in the model-match scoring bonus
 *           (`candidateNorm.includes(sourceModel)`) treats a longer,
 *           distinct sub-line name as if it "contained" the shorter
 *           requested model. Additionally, VARIANT_SUFFIX_WORDS (Gate 1)
 *           was missing "fe" and "enterprise", so Tab S9 vs Tab S9 FE and
 *           S26 Ultra vs S26 Ultra Enterprise Edition were never even
 *           gated as a different product line.
 *   Fix B — extractModelNumberTokens/extractPlainModelNumbers are both
 *           \b-boundary regexes, which never match a digit run
 *           immediately followed by letters with no separator ("17e",
 *           "15AMN8") — a digit->letter transition is not a \b boundary.
 *           These sub-model codes were entirely invisible to Gate 1.
 *   Fix C — color had no conflict penalty at all, only ever a positive
 *           bonus on a match — an explicit, different candidate color
 *           was never treated as a conflict.
 *   Fix D — the existing letter-first token check only required "some"
 *           overlap, so a genuine conflict on one identifier (SM-R530 vs
 *           SM-R420) could be masked by an unrelated shared token
 *           ("Buds3") on the same candidate.
 *
 * Deliberately unit-level (no axios/serper mocking needed) — this suite
 * calls computeMatchConfidence/evaluateVariantIdentity directly, the same
 * way productIdentityConflict.test.js's assertHardReject/assertValidMatch
 * helpers do.
 *
 * USAGE: node tests/matching/phase14WrongVariant.test.js
 */

const assert = require("assert");
const { canonicalizeProduct } = require("../../comparison/productIdentity");
const { computeMatchConfidence } = require("../../services/productMatcher");

const results = [];
async function test(name, fn) {
    try {
        await fn();
        results.push({ name, pass: true });
        console.log(`PASS  ${name}`);
    } catch (err) {
        results.push({ name, pass: false, error: err.message });
        console.log(`FAIL  ${name}`);
        console.log(`      ${err.message}`);
    }
}

function sourceFrom(title, overrides = {}) {
    return { ...canonicalizeProduct({ name: title }), ...overrides };
}

function assertReject(sourceTitle, candidateTitle, label) {
    const source = sourceFrom(sourceTitle);
    const r = computeMatchConfidence(source, candidateTitle);
    assert.strictEqual(
        r.hardReject,
        true,
        `${label}: expected hardReject=true, got confidence=${r.confidence} decision=${r.matchDecision} reason="${r.reason}"`
    );
}

function assertAccept(sourceTitle, candidateTitle, label, { minConfidence = 0.75 } = {}) {
    const source = sourceFrom(sourceTitle);
    const r = computeMatchConfidence(source, candidateTitle);
    assert.strictEqual(r.hardReject, false, `${label}: expected hardReject=false, got reason="${r.reason}"`);
    assert.ok(
        r.confidence >= minConfidence,
        `${label}: expected confidence >= ${minConfidence}, got ${r.confidence} ("${r.reason}")`
    );
}

async function run() {
    console.log("=== MUST REJECT (confirmed Phase 13 wrong-variant failures) ===");

    await test("Fix A/B: iPhone 17 vs iPhone 17e", () =>
        assertReject("Apple iPhone 17 128GB Black", "Apple iPhone 17e 128GB Black", "iPhone 17 vs 17e")
    );

    await test("Fix A: Samsung Galaxy Tab S9 vs Tab S9 FE", () =>
        assertReject("Samsung Galaxy Tab S9 128GB WiFi Gray", "Samsung Galaxy Tab S9 FE 128GB WiFi Gray", "Tab S9 vs Tab S9 FE")
    );

    await test("Fix A: Galaxy S26 Ultra vs S26 Ultra Enterprise Edition", () =>
        assertReject(
            "Samsung Galaxy S26 Ultra 256GB Titanium Black",
            "Samsung Galaxy S26 Ultra Enterprise Edition 256GB Titanium Black",
            "S26 Ultra vs Enterprise Edition"
        )
    );

    await test("Fix B: Lenovo IdeaPad Slim 3 15AMN8 vs 15IRU8", () =>
        assertReject(
            "Lenovo IdeaPad Slim 3 15AMN8 8GB 512GB",
            "Lenovo IdeaPad Slim 3 15IRU8 8GB 512GB",
            "15AMN8 vs 15IRU8"
        )
    );

    await test("Fix D: Galaxy Buds3 SM-R530 vs SM-R420 (shared 'Buds3' token must not mask it)", () =>
        assertReject("Samsung Galaxy Buds3 SM-R530", "Samsung Galaxy Buds3 SM-R420", "SM-R530 vs SM-R420")
    );

    await test("Fix C: explicit color conflict rejects (Titanium Black vs Graphite)", () =>
        assertReject(
            "Samsung Galaxy S25 Ultra 256GB Titanium Black",
            "Samsung Galaxy S25 Ultra 256GB Graphite",
            "Titanium Black vs Graphite"
        )
    );

    console.log("\n=== MUST STILL ACCEPT (legitimate matches / variants) ===");

    await test("Control: exact same product, different retailer title chrome", () =>
        assertAccept("Apple iPhone 17 128GB Black", "Apple iPhone 17 (128GB) - Black | Amazon.in", "exact same product")
    );

    await test("Control: legitimate storage variant is demoted, NOT hard-rejected", () => {
        const source = sourceFrom("Samsung Galaxy S25 Ultra 256GB");
        const r = computeMatchConfidence(source, "Samsung Galaxy S25 Ultra 512GB");
        assert.strictEqual(r.hardReject, false, `expected hardReject=false for a storage-only difference, got reason="${r.reason}"`);
        assert.ok(r.confidence < 0.5, `expected a storage mismatch to score low (possible match, not confident), got ${r.confidence}`);
    });

    await test("Control: source has no explicit color -> candidate with a color is still accepted", () =>
        assertAccept("Apple iPhone 17 128GB", "Apple iPhone 17 128GB Sage", "no source color -> candidate color")
    );

    await test("Control: explicit same-color match is accepted", () =>
        assertAccept("Apple iPhone 17 128GB Black", "Apple iPhone 17 128GB Black", "same color")
    );

    await test("Control: legitimate identical alphanumeric model code is accepted", () =>
        assertAccept(
            "Lenovo IdeaPad Slim 3 15AMN8 8GB 512GB",
            "Lenovo IdeaPad Slim 3 15AMN8 8GB 512GB - Flipkart",
            "same alnum model code"
        )
    );

    await test("Control: legitimate identical SM- model code is accepted", () =>
        assertAccept("Samsung Galaxy Buds3 SM-R530", "Samsung Galaxy Buds3 SM-R530 - Croma", "same SM- code")
    );

    await test("Control: previously-valid PS5 Pro exact match still valid (no regression)", () =>
        assertAccept("Sony PS5 Pro", "Sony PS5 Pro Console", "PS5 Pro control", { minConfidence: 0.5 })
    );

    await test("Control: previously-valid Sony WH-1000XM6 exact match still valid (no regression)", () =>
        assertAccept(
            "Sony WH-1000XM6",
            "Sony WH-1000XM6 Wireless Noise Cancelling Headphones",
            "WH-1000XM6 control",
            { minConfidence: 0.5 }
        )
    );

    console.log("\n=== OUT OF SCOPE / KNOWN GAP (documented, not fixed by this phase) ===");

    await test("KNOWN GAP: 'Sage' is not in utils/text.js COLOR_WORDS (out of Phase 14's approved file scope)", () => {
        // Fix C's mechanism (source has an explicit color, candidate has a
        // DIFFERENT explicit color -> hard reject) is proven above against
        // colors already in COLOR_WORDS ("Titanium Black" vs "Graphite").
        // The literal Phase 13 example used "Sage", which detectColor()
        // cannot recognize at all — COLOR_WORDS lives in utils/text.js,
        // which is outside the two files this phase was approved to touch
        // (services/productMatcher.js, utils/numbers.js). Documenting this
        // rather than silently modifying an unapproved file or hiding the
        // gap.
        const source = sourceFrom("Apple iPhone 17 128GB Black");
        const r = computeMatchConfidence(source, "Apple iPhone 17 128GB Sage");
        console.log(`      [INFO] Black vs Sage -> hardReject=${r.hardReject}, confidence=${r.confidence} (detectColor can't see "Sage" — see comment)`);
        // No assertion — see comment above. Adding "sage" to
        // utils/text.js's COLOR_WORDS list is a one-line, near-zero-risk
        // data addition, but it is outside this phase's approved scope
        // without separate sign-off.
    });

    await test("CPU mismatch (AMD vs Intel) — documenting current (pre/post-fix) behavior, not asserting a fix", () => {
        const source = sourceFrom("Lenovo IdeaPad Slim 3 AMD Ryzen 3 8GB 512GB");
        const r = computeMatchConfidence(source, "Lenovo IdeaPad Slim 3 Intel Core i5 8GB 512GB");
        console.log(`      [INFO] AMD vs Intel -> hardReject=${r.hardReject}, confidence=${r.confidence}, decision=${r.matchDecision}`);
        // No assertion of hardReject here — CPU-family detection is explicitly
        // out of scope for Phase 14 per the approved implementation plan.
    });

    console.log("\n=== SUMMARY ===");
    const passed = results.filter((r) => r.pass).length;
    console.log(`${passed}/${results.length} passed`);
    if (passed !== results.length) process.exitCode = 1;
}

run();
