/**
 * Phase 15 — Live Cross-Phase Validation (8-Test TV Root-Cause Fixes)
 * ------------------------------------------------------------------
 * Four real, reproducible defects found by analyzing the user-supplied
 * 8_test_results.txt (real Serper live output), not from hypothetical
 * examples. All four are TV-specific; all four use titles/values copied
 * directly from that file.
 *
 * BUG A — extractPlainModelNumbers treated the bare "55" from "55 inch"
 *   as a required model-number code (like "15" in "iPhone 15"), causing
 *   false MODEL_NUMBER_MISMATCH rejections against size-silent TVs.
 *   Fix: exclude "inch"/"inches"/"in" the same way "gb"/"tb"/"mb" already
 *   were excluded.
 *
 * BUG B — no screen-size comparison existed anywhere. "LG OLED83C24LA"
 *   (83", real LG model-number convention) scored STRONG_MATCH and became
 *   bestOffer against a requested 55" TV. Fix: new detectScreenSize(),
 *   wired into evaluateVariantIdentity as an explicit-conflict-only check
 *   (same shape as color/network-generation/panel-technology).
 *   IMPORTANT sub-detail, also verified here: LG's OLED line encodes size
 *   AFTER the "OLED" prefix (OLED83...), but its QNED/LCD lines encode
 *   size BEFORE the tier code instead (55QNED82... = 55", NOT 82) —
 *   confirmed directly from a live title stating both "55 inch" and
 *   "55QNED82BXA" for the same product. Getting this backwards was an
 *   intermediate, self-caught mistake during this same fix.
 *
 * BUG C — "Mini LED" (backlight technology) and "Ultra HD" (a
 *   near-universal 4K-resolution descriptor) were being masked by the
 *   pre-existing "mini"/"ultra" VARIANT_SUFFIX_WORDS entries (added for
 *   phone editions like "iPhone Mini"/"Galaxy S24 Ultra"), causing
 *   widespread false VARIANT_MISMATCH rejections — 19 of the live
 *   rejections across 3 TV tests had "Ultra HD" in the candidate title.
 *   Fix: mask both phrases before the suffix-word scan, same technique
 *   as the pre-existing maskChipsetContext.
 *
 * USAGE: node tests/matching/phase15TvRootCauseFixes.test.js
 */

const assert = require("assert");
const { canonicalizeProduct } = require("../../comparison/productIdentity");
const { computeMatchConfidence } = require("../../services/productMatcher");
const { detectScreenSize, extractPlainModelNumbers, extractVariantSuffixes } = require("../../utils/numbers");

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

const oled55 = lg("55 inch OLED 4K Smart TV");
const qned55 = lg("55 inch QNED 4K Smart TV");

// -----------------------------------------------------------------
// BUG A — "55 inch" no longer produces a phantom bare model number
// -----------------------------------------------------------------
test("Bug A: extractPlainModelNumbers no longer extracts size units (55 inch)", () => {
    assert.deepStrictEqual(extractPlainModelNumbers("55 inch QNED 4K Smart TV"), []);
});

test("Bug A: unrelated bare model numbers are still extracted normally (regression)", () => {
    assert.deepStrictEqual(extractPlainModelNumbers("Airdopes 141"), ["141"]);
});

test("Bug A live repro: 'LG QNED72 4K Smart TV' (no size stated) no longer false-rejects a size-silent-by-design source", () => {
    const r = computeMatchConfidence(qned55, "LG 4K Ultra HD Smart QNED AI TV");
    assert.notStrictEqual(r.primaryIssue, "model_number_mismatch", "the bare '55' from the source must never itself demand a matching literal digit in the candidate");
});

// -----------------------------------------------------------------
// BUG B — screen-size explicit-conflict check + correct per-line direction
// -----------------------------------------------------------------
test("Bug B live repro: 'LG OLED83C24LA' (83in, real live bestOffer bug) now HARD_REJECTs against a 55in request", () => {
    const r = computeMatchConfidence(oled55, "LG OLED83C24LA 4K OLED Smart TV");
    assert.strictEqual(r.hardReject, true);
    assert.strictEqual(r.primaryIssue, "screen_size_mismatch");
});

test("Bug B direction check: OLED encodes size AFTER the prefix", () => {
    assert.strictEqual(detectScreenSize("LG OLED83C24LA 4K OLED Smart TV"), 83);
    assert.strictEqual(detectScreenSize("oled55b56la"), 55);
});

test("Bug B direction check: QNED/LCD lines encode size BEFORE the tier code, not after (self-corrected mistake)", () => {
    // Live evidence: "140 cm (55 inch) | ... | 55QNED82BXA" is ONE product.
    // The tier code "82" must NOT be read as size 82.
    assert.strictEqual(detectScreenSize("55QNED82BXA"), 55);
    assert.notStrictEqual(detectScreenSize("LG QNED AI Mini LED QNED72 4K Smart TV 2026"), 72);
});

test("Bug B: genuinely different real size (43in) still correctly rejected", () => {
    const r = computeMatchConfidence(qned55, 'LG 43" 4K Smart QNED TV');
    assert.strictEqual(r.hardReject, true);
    assert.strictEqual(r.primaryIssue, "screen_size_mismatch");
});

test("Bug B: same size via quote-mark form (55\") still matches", () => {
    const r = computeMatchConfidence(qned55, 'LG 55" 4K Smart QNED TV');
    assert.strictEqual(r.hardReject, false);
});

test("Bug B: same size via cm form (139/140 cm, both real live values) still matches", () => {
    assert.strictEqual(detectScreenSize("139 cm (55 inches)"), 55);
    assert.strictEqual(detectScreenSize("140 cm (55 inch)"), 55);
});

test("Bug B: size-silent source/candidate never penalized (no invented conflict)", () => {
    const silentSource = lg("QNED TV");
    const r = computeMatchConfidence(silentSource, "LG 4K Ultra HD Smart QNED AI TV");
    assert.notStrictEqual(r.primaryIssue, "screen_size_mismatch");
});

// -----------------------------------------------------------------
// BUG C — "Mini LED" and "Ultra HD" no longer masquerade as variant
// suffixes ("mini"/"ultra")
// -----------------------------------------------------------------
test("Bug C: 'Mini LED' does not register 'mini' as a variant suffix", () => {
    const suffixes = extractVariantSuffixes("LG QNED Mini LED 4K Smart TV");
    assert.ok(!suffixes.has("mini"), "Mini LED is a backlight technology, not a device edition");
});

test("Bug C: 'Ultra HD' does not register 'ultra' as a variant suffix", () => {
    const suffixes = extractVariantSuffixes("LG 4K Ultra HD Smart QNED TV");
    assert.ok(!suffixes.has("ultra"), "Ultra HD is a generic 4K descriptor, not a device edition");
});

test("Bug C live repro: a genuinely correct 55in QNED82 listing (previously false-rejected on 'Ultra HD') now matches", () => {
    const r = computeMatchConfidence(
        qned55,
        "LG QNED Mini LED 4K Ultra HD Smart webOS TV | 140 cm (55 inch) | Black | 2026 model | 55QNED82BXA"
    );
    assert.strictEqual(r.hardReject, false, "must not be rejected for a variant conflict that was never real");
});

test("Bug C regression: 'iPhone 13 Mini' still correctly distinguished from 'iPhone 13'", () => {
    const r = computeMatchConfidence(canonicalizeProduct({ brand: "Apple", model: "iPhone 13" }), "Apple iPhone 13 Mini");
    assert.strictEqual(r.hardReject, true);
    assert.strictEqual(r.primaryIssue, "variant_mismatch");
});

test("Bug C regression: 'Galaxy S24 Ultra' still correctly distinguished from base 'Galaxy S24'", () => {
    const r = computeMatchConfidence(canonicalizeProduct({ brand: "Samsung", model: "Galaxy S24" }), "Samsung Galaxy S24 Ultra 5G");
    assert.strictEqual(r.hardReject, true);
    assert.strictEqual(r.primaryIssue, "variant_mismatch");
});

// -----------------------------------------------------------------
// Non-TV / cross-phase regression spotcheck
// -----------------------------------------------------------------
test("Non-TV regression: Phase 9-14 phone baseline (Galaxy S26 Ultra 5G) unaffected", () => {
    const r = computeMatchConfidence(canonicalizeProduct({ brand: "Samsung", model: "Galaxy S26 Ultra", storage: "256GB" }), "Samsung Galaxy S26 Ultra 5G");
    assert.strictEqual(r.hardReject, false);
    assert.strictEqual(r.matchDecision, "STRONG_MATCH");
    assert.strictEqual(r.primaryIssue, "storage_unconfirmed");
});

console.log("\n=== SUMMARY ===");
const passed = results.filter((r) => r.pass).length;
console.log(`${passed}/${results.length} passed`);
if (passed !== results.length) process.exitCode = 1;
