/**
 * Phase 14 — TV Panel-Technology Identity Audit
 * ------------------------------------------------------------------
 * VERDICT: B — reproducible defect found, minimally fixed.
 *
 * Root cause: no mechanism anywhere in the codebase distinguished TV
 * panel technologies. "LG 55 inch OLED TV" scored a 0.82 STRONG_MATCH
 * against "LG 55 inch QLED TV" before this fix — OLED (self-emissive)
 * and QLED (quantum-dot-enhanced backlit LCD) are fundamentally
 * different, well-established display technologies, not aliases.
 *
 * Fix: detectPanelTechnology() (utils/text.js) + a new conflict check in
 * evaluateVariantIdentity (services/productMatcher.js), mirroring the
 * existing color/network-generation "explicit conflict only" pattern
 * exactly. Detects only specific, proprietary terms: oled, qled (also
 * matches "neo qled"), qned, nanocell. Deliberately excludes bare "led"
 * — reproduced as genuinely ambiguous (a generic umbrella term, not a
 * specific competing technology name) — see the "remaining risk" test
 * below, which documents rather than "fixes" that ambiguity.
 *
 * USAGE: node tests/matching/phase14PanelTechnology.test.js
 */

const assert = require("assert");
const { canonicalizeProduct } = require("../../comparison/productIdentity");
const { computeMatchConfidence } = require("../../services/productMatcher");

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

function structured(brand, model) {
    return canonicalizeProduct({ brand, model });
}

// -----------------------------------------------------------------
// Case A/B — OLED <-> QLED, both directions (the actual live repro)
// -----------------------------------------------------------------
test("Case A: 'LG OLED TV' request rejects a 'LG QLED TV' candidate", () => {
    const r = computeMatchConfidence(structured("LG", "55 inch OLED TV"), "LG 55 inch QLED TV");
    assert.strictEqual(r.hardReject, true);
    assert.strictEqual(r.primaryIssue, "panel_technology_mismatch");
});

test("Case B: 'LG QLED TV' request rejects a 'LG OLED TV' candidate (reverse)", () => {
    const r = computeMatchConfidence(structured("LG", "55 inch QLED TV"), "LG 55 inch OLED TV");
    assert.strictEqual(r.hardReject, true);
    assert.strictEqual(r.primaryIssue, "panel_technology_mismatch");
});

// -----------------------------------------------------------------
// Case C — QLED vs generic "LED": deliberately NOT rejected (documented
// scope decision, not a bug — "LED" is too generic/ambiguous a term)
// -----------------------------------------------------------------
test("Case C (documented remaining risk): 'QLED' request does NOT reject generic 'LED' candidate", () => {
    const r = computeMatchConfidence(structured("Samsung", "55 inch QLED TV"), "Samsung 55 inch LED TV");
    assert.strictEqual(r.hardReject, false, "bare 'LED' is deliberately excluded from detectPanelTechnology — too generic to safely treat as a specific competing technology");
});

// -----------------------------------------------------------------
// Case D — source silent on technology: must never invent a conflict
// -----------------------------------------------------------------
test("Case D: silent source ('4K Smart TV') still matches a 'QLED' candidate", () => {
    const r = computeMatchConfidence(structured("Samsung", "55 inch 4K Smart TV"), "Samsung 55 inch QLED 4K Smart TV");
    assert.strictEqual(r.hardReject, false);
    assert.notStrictEqual(r.primaryIssue, "panel_technology_mismatch");
});

// -----------------------------------------------------------------
// Case E — same technology, extra descriptive words: must stay matchable
// -----------------------------------------------------------------
test("Case E: same technology ('OLED') with extra words on the candidate still matches", () => {
    const r = computeMatchConfidence(structured("LG", "55 inch OLED TV"), "LG 55 inch OLED 4K Smart TV");
    assert.strictEqual(r.hardReject, false);
    assert.strictEqual(r.matchDecision, "EXACT_MATCH");
});

// -----------------------------------------------------------------
// Case F — QLED vs QNED: different manufacturers' proprietary terms
// -----------------------------------------------------------------
test("Case F: 'QLED' request rejects a 'QNED' candidate", () => {
    const r = computeMatchConfidence(structured("LG", "55 inch QLED TV"), "LG 55 inch QNED TV");
    assert.strictEqual(r.hardReject, true);
    assert.strictEqual(r.primaryIssue, "panel_technology_mismatch");
});

// -----------------------------------------------------------------
// Model-name technology distinction: pre-existing "neo" suffix already
// catches Neo QLED vs QLED via a DIFFERENT, older mechanism — proving
// this phase didn't need to duplicate that logic.
// -----------------------------------------------------------------
test("Neo QLED vs QLED already rejected by the pre-existing 'neo' variant suffix (not this phase's new check)", () => {
    const r = computeMatchConfidence(structured("Samsung", "55 inch QLED TV"), "Samsung 55 inch Neo QLED TV");
    assert.strictEqual(r.hardReject, true);
    assert.strictEqual(r.primaryIssue, "variant_mismatch", "caught by the existing suffix mechanism ('neo'), confirming no duplicate logic was needed");
});

// -----------------------------------------------------------------
// Non-TV regression: unrelated phone matching completely unaffected
// -----------------------------------------------------------------
test("Non-TV regression: phone matching (Phase 9-13 baseline) is unaffected", () => {
    const r = computeMatchConfidence(structured("Samsung", "Galaxy S26 Ultra"), "Samsung Galaxy S26 Ultra 5G");
    assert.strictEqual(r.hardReject, false);
    assert.strictEqual(r.matchDecision, "EXACT_MATCH");
});

console.log("\n=== SUMMARY ===");
const passed = results.filter((r) => r.pass).length;
console.log(`${passed}/${results.length} passed`);
if (passed !== results.length) process.exitCode = 1;
