/**
 * Phase 16 — cm→inch rounding defect fix (detectScreenSize only)
 * ---------------------------------------------------------------
 * CONFIRMED DEFECT: Math.round(cm / 2.54) turns a genuine 55" TV listed
 * as "138 cm" (true diagonal 55*2.54=139.7cm; real retailers round down)
 * into size 54 — a size that doesn't exist as a real listing here — which
 * then false-rejects against the very same 55" TV a user asked for. Same
 * problem confirmed for a genuine 65" TV listed as "163 cm" (true
 * 165.1cm) rounding to 64.
 *
 * FIX: a guarded snap in detectScreenSize's cm branch only. A raw cm
 * value is snapped to a known TV size ONLY when it's within tolerance of
 * EXACTLY ONE known size. If it's ambiguous (within tolerance of two
 * closely-spaced real sizes, e.g. 42"/43" or 49"/50", only 2.54cm apart
 * in true diagonal) or matches none, the function falls back to the
 * original plain rounding, completely unchanged. This means the fix can
 * only resolve already-unambiguous rounding noise — it can never cause
 * two different real sizes to be treated as the same size.
 *
 * Nothing outside utils/numbers.js was touched. No architecture,
 * matching pipeline, ranking, URL resolution, or trusted-retailer logic
 * was modified.
 *
 * USAGE: node tests/matching/phase16CmRoundingFix.test.js
 */

const assert = require("assert");
const { canonicalizeProduct } = require("../../comparison/productIdentity");
const { computeMatchConfidence } = require("../../services/productMatcher");
const { detectScreenSize } = require("../../utils/numbers");

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

function lg(model) {
    return canonicalizeProduct({ brand: "LG", model });
}

// -----------------------------------------------------------------
// Core defect: 55" genuinely listed as under-rounded cm
// -----------------------------------------------------------------
test("Fix: '138 cm' (real 55in TV, under-rounded by retailer) now resolves to 55, not 54", () => {
    assert.strictEqual(detectScreenSize("138 cm Smart TV"), 55);
});

test("Fix: '139 cm' still resolves to 55 (unchanged, already correct before this fix)", () => {
    assert.strictEqual(detectScreenSize("139 cm Smart TV"), 55);
});

test("Fix: '140 cm' still resolves to 55 (unchanged, already correct before this fix)", () => {
    assert.strictEqual(detectScreenSize("140 cm Smart TV"), 55);
});

test("Fix live-shape repro: a genuine 55in TV listed as '138 cm' no longer HARD_REJECTs against a stated 55in request", () => {
    const source = lg("55 inch QNED 4K Smart TV");
    const r = computeMatchConfidence(source, "LG 4K Smart QNED TV | 138 cm | 2026 model");
    assert.notStrictEqual(r.primaryIssue, "screen_size_mismatch");
});

// -----------------------------------------------------------------
// Same defect class: 65" genuinely listed as under-rounded cm
// -----------------------------------------------------------------
test("Fix: '163 cm' (real 65in TV, under-rounded by retailer) now resolves to 65, not 64", () => {
    assert.strictEqual(detectScreenSize("163 cm Smart TV"), 65);
});

test("Fix: '164 cm' also resolves to 65", () => {
    assert.strictEqual(detectScreenSize("164 cm Smart TV"), 65);
});

test("Fix: '166 cm' also resolves to 65", () => {
    assert.strictEqual(detectScreenSize("166 cm Smart TV"), 65);
});

test("Fix live-shape repro: a genuine 65in TV listed as '163 cm' no longer HARD_REJECTs against a stated 65in request", () => {
    const source = lg("65 inch QNED 4K Smart TV");
    const r = computeMatchConfidence(source, "LG 4K Smart QNED TV | 163 cm | 2026 model");
    assert.notStrictEqual(r.primaryIssue, "screen_size_mismatch");
});

// -----------------------------------------------------------------
// Safety: closely-spaced real sizes must never be merged by the fix
// -----------------------------------------------------------------
test("Safety: explicit 42in request still HARD_REJECTs a genuinely different, unambiguous 43in cm-listed TV", () => {
    const source = lg("42 inch QNED 4K Smart TV");
    const r = computeMatchConfidence(source, "LG 4K Smart QNED TV | 109 cm | 2026 model");
    assert.strictEqual(r.hardReject, true);
    assert.strictEqual(r.primaryIssue, "screen_size_mismatch");
});

test("Safety: a cm value ambiguous between 42in and 43in (108cm) falls back to plain rounding, unchanged from before this fix", () => {
    // 108/2.54 = 42.52 -> Math.round = 43 (identical to pre-fix behavior).
    assert.strictEqual(detectScreenSize("108 cm Smart TV"), 43);
});

test("Safety: a cm value ambiguous between 49in and 50in (125cm) falls back to plain rounding, unchanged from before this fix", () => {
    // 125/2.54 = 49.21 -> Math.round = 49 (identical to pre-fix behavior).
    assert.strictEqual(detectScreenSize("125 cm Smart TV"), 49);
});

test("Safety: a cm value with no nearby known size (145cm) is not force-snapped to the nearest known size (58in)", () => {
    // 145/2.54 = 57.09 -> Math.round = 57. Nearest known size (58, true
    // 147.32cm) is 2.32cm away, outside the 2.2cm tolerance -> no snap.
    assert.strictEqual(detectScreenSize("145 cm Smart TV"), 57);
});

// -----------------------------------------------------------------
// Unaffected: exact inch/quote/model-code forms were never touched
// -----------------------------------------------------------------
test("Regression: exact word form ('55 inch') is completely unaffected by this fix", () => {
    assert.strictEqual(detectScreenSize("55 inch QNED 4K Smart TV"), 55);
});

test("Regression: exact quote form (55\") is completely unaffected by this fix", () => {
    assert.strictEqual(detectScreenSize('55" 4K Smart QNED TV'), 55);
});

test("Regression: model-code forms (OLED83.../55QNED82...) are completely unaffected by this fix", () => {
    assert.strictEqual(detectScreenSize("LG OLED83C24LA 4K OLED Smart TV"), 83);
    assert.strictEqual(detectScreenSize("55QNED82BXA"), 55);
});

test("Regression: Phase 15's own core repro (83in OLED HARD_REJECTs a 55in request) still holds", () => {
    const source = lg("55 inch OLED 4K Smart TV");
    const r = computeMatchConfidence(source, "LG OLED83C24LA 4K OLED Smart TV");
    assert.strictEqual(r.hardReject, true);
    assert.strictEqual(r.primaryIssue, "screen_size_mismatch");
});

console.log("\n=== SUMMARY ===");
const passed = results.filter((r) => r.pass).length;
console.log(`${passed}/${results.length} passed`);
if (passed !== results.length) process.exitCode = 1;
