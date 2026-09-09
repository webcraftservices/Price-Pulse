/**
 * Phase 18, Fix 1 — IPv4-mapped IPv6 SSRF bypass
 * ------------------------------------------------------------------
 * CONFIRMED DEFECT: isPrivateOrLocalHost()'s IPv6 branch only checked for
 * exact "::1" or a "fe80:"/"fc"/"fd" prefix. An IPv4-mapped IPv6 literal
 * (::ffff:a.b.c.d) is routed by the OS network stack to the literal IPv4
 * address it embeds, so http://[::ffff:169.254.169.254]/ genuinely reaches
 * the same cloud metadata endpoint as http://169.254.169.254/ would — but
 * matched none of the existing IPv6 checks and was classified as safe.
 * This is a live SSRF vector: services/compareService.js's
 * scrapeProductDetails() performs a real server-side axios.get() against
 * whatever URL a user pastes into "Compare by URL", gated only by
 * isPrivateOrLocalHost.
 *
 * FIX SCOPE: utils/url.js only. Extracts the embedded IPv4 address from an
 * IPv4-mapped IPv6 literal and judges it with the SAME isPrivateIpv4Octets
 * rules already used for plain IPv4 literals — no second blocklist, no
 * change to any existing IPv4/IPv6 rule.
 *
 * USAGE: node tests/security/ipv6MappedSsrf.test.js
 */

const assert = require("assert");
const { isPrivateOrLocalHost, isSafeExternalUrl } = require("../../utils/url");

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

// -----------------------------------------------------------------
// Confirmed bypasses — must now be rejected
// -----------------------------------------------------------------
test("Bug: IPv4-mapped loopback (::ffff:127.0.0.1) is now blocked", () => {
    assert.strictEqual(isPrivateOrLocalHost("http://[::ffff:127.0.0.1]/"), true);
});

test("Bug: IPv4-mapped cloud metadata endpoint (::ffff:169.254.169.254) is now blocked", () => {
    assert.strictEqual(isPrivateOrLocalHost("http://[::ffff:169.254.169.254]/latest/meta-data/"), true);
});

test("Bug: IPv4-mapped RFC1918 10.x (::ffff:10.0.0.1) is now blocked", () => {
    assert.strictEqual(isPrivateOrLocalHost("http://[::ffff:10.0.0.1]/"), true);
});

test("Bug: IPv4-mapped RFC1918 192.168.x (::ffff:192.168.1.1) is now blocked", () => {
    assert.strictEqual(isPrivateOrLocalHost("http://[::ffff:192.168.1.1]/"), true);
});

test("Bug: IPv4-mapped RFC1918 172.16-31.x (::ffff:172.20.0.5) is now blocked", () => {
    assert.strictEqual(isPrivateOrLocalHost("http://[::ffff:172.20.0.5]/"), true);
});

test("Bug: fully-expanded IPv4-mapped form (0:0:0:0:0:ffff:127.0.0.1) is also blocked (normalizes to the same compressed form)", () => {
    assert.strictEqual(isPrivateOrLocalHost("http://[0:0:0:0:0:ffff:127.0.0.1]/"), true);
});

test("Bug: isSafeExternalUrl (the combined gate urlResolver.js uses) also rejects the mapped metadata address", () => {
    assert.strictEqual(isSafeExternalUrl("http://[::ffff:169.254.169.254]/"), false);
});

// -----------------------------------------------------------------
// Safety: genuine public addresses must remain allowed
// -----------------------------------------------------------------
test("Safety: a public IPv4-mapped address (::ffff:8.8.8.8) is NOT blocked", () => {
    assert.strictEqual(isPrivateOrLocalHost("http://[::ffff:8.8.8.8]/"), false);
});

test("Safety: a genuine public IPv6 address (Google DNS, 2001:4860:4860::8888) is NOT blocked", () => {
    assert.strictEqual(isPrivateOrLocalHost("http://[2001:4860:4860::8888]/"), false);
});

test("Safety: a real merchant domain is unaffected by this fix", () => {
    assert.strictEqual(isPrivateOrLocalHost("http://amazon.in/dp/B0EXAMPLE"), false);
});

// -----------------------------------------------------------------
// Regression: pre-existing IPv4/IPv6 checks still behave identically
// -----------------------------------------------------------------
test("Regression: plain IPv4 loopback (127.0.0.1) still blocked", () => {
    assert.strictEqual(isPrivateOrLocalHost("http://127.0.0.1/"), true);
});

test("Regression: plain IPv4 metadata endpoint (169.254.169.254) still blocked", () => {
    assert.strictEqual(isPrivateOrLocalHost("http://169.254.169.254/"), true);
});

test("Regression: decimal-obfuscated loopback (2130706433) still blocked (Node's URL parser normalizes this before we ever see it)", () => {
    assert.strictEqual(isPrivateOrLocalHost("http://2130706433/"), true);
});

test("Regression: ::1 (plain IPv6 loopback) still blocked", () => {
    assert.strictEqual(isPrivateOrLocalHost("http://[::1]/"), true);
});

test("Regression: fe80:: (IPv6 link-local) still blocked", () => {
    assert.strictEqual(isPrivateOrLocalHost("http://[fe80::1]/"), true);
});

test("Regression: a public IPv4 address (8.8.8.8) still allowed", () => {
    assert.strictEqual(isPrivateOrLocalHost("http://8.8.8.8/"), false);
});

console.log("\n=== SUMMARY ===");
const passed = results.filter((r) => r.pass).length;
console.log(`${passed}/${results.length} passed`);
if (passed !== results.length) process.exitCode = 1;
