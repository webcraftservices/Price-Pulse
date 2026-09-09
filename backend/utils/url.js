/**
 * URL utilities
 * ------------------------------------------------------------------
 * Hostname/domain helpers shared by the offer extractor, URL resolver,
 * and merchant registry. Extracted from stores/googleShopping.js and
 * stores/merchantUrlResolver.js (V1) with no behavior change.
 */

// Covers google.com, google.co.in, google.co.uk, and every other Google
// country-TLD variant, plus the googleusercontent.com CDN domain sometimes
// used for Google-hosted redirect/image URLs.
function isGoogleHost(url) {
    try {
        const host = new URL(url).hostname.replace(/^www\./, "");
        return /(^|\.)google\.[a-z.]+$/.test(host) || /(^|\.)googleusercontent\.com$/.test(host);
    } catch {
        return true; // unparsable — never treat as a usable merchant URL
    }
}

// Only http/https are ever considered valid — never file://, javascript:,
// data:, etc.
function hasSafeProtocol(url) {
    try {
        const protocol = new URL(url).protocol;
        return protocol === "http:" || protocol === "https:";
    } catch {
        return false;
    }
}

function getHostname(url) {
    try {
        return new URL(url).hostname.replace(/^www\./, "");
    } catch {
        return null;
    }
}

function belongsToDomain(url, domain) {
    try {
        const hostname = new URL(url).hostname.replace(/^www\./, "");
        return hostname === domain || hostname.endsWith(`.${domain}`);
    } catch {
        return false;
    }
}

// Blocks SSRF-risk destinations: loopback, private/link-local/CGNAT IP
// ranges, and the well-known cloud-metadata endpoint. Phase 3 URL
// resolution never actually fetches a candidate URL itself (only Serper's
// own /search endpoint is called — see providers/serper/webSearch.js), so
// there is no live SSRF vector today, but every resolved URL is still
// checked against this before ever being handed to the frontend as a
// "verified direct merchant URL" — defense in depth against a
// future/alternate resolution path that does fetch directly, and against
// a search provider ever echoing back an internal-looking address.
// Shared by the plain-IPv4 branch below AND the IPv4-mapped-IPv6 branch
// (an IPv4 destination reached through an IPv6 literal must be judged by
// the exact same rules as reaching it directly — one rule set, not two
// independently-maintained copies that could drift apart).
function isPrivateIpv4Octets(a, b) {
    if (a === 127) return true; // loopback
    if (a === 10) return true; // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 169 && b === 254) return true; // link-local (covers the cloud metadata endpoint, 169.254.169.254)
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 0) return true; // "this network"
    return false;
}

// An IPv4-mapped IPv6 address (::ffff:a.b.c.d) is routed by the OS network
// stack to the literal IPv4 address it embeds — a request to
// http://[::ffff:169.254.169.254]/ genuinely reaches the same cloud
// metadata endpoint as http://169.254.169.254/ would. Node's WHATWG URL
// parser normalizes every input form (dotted, fully-expanded, compressed)
// to the compressed hex form (e.g. "::ffff:7f00:1" for 127.0.0.1) before
// this function ever sees it — confirmed directly: new URL('http://[::ffff:
// 127.0.0.1]/').hostname === '[::ffff:7f00:1]'. This extracts the embedded
// IPv4 address from that normalized hex form (and, defensively, from a
// dotted-decimal form too, in case a hostname ever reaches this function
// without going through new URL() first) and returns it as [a, b] octets,
// or null if `bare` isn't an IPv4-mapped address at all.
function extractIpv4MappedOctets(bare) {
    const hexForm = bare.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (hexForm) {
        const hi = hexForm[1].padStart(4, "0");
        const a = parseInt(hi.slice(0, 2), 16);
        const b = parseInt(hi.slice(2, 4), 16);
        return [a, b];
    }
    const dottedForm = bare.match(/^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i);
    if (dottedForm) {
        return [Number(dottedForm[1]), Number(dottedForm[2])];
    }
    return null;
}

function isPrivateOrLocalHost(url) {
    let hostname;
    try {
        hostname = new URL(url).hostname.toLowerCase();
    } catch {
        return true; // unparsable — treat as unsafe, same stance as isGoogleHost
    }
    if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
    if (hostname === "169.254.169.254") return true; // cloud metadata endpoint (AWS/GCP/Azure)
    // IPv4 literal — check private/loopback/link-local/CGNAT ranges.
    const ipv4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4) {
        return isPrivateIpv4Octets(Number(ipv4[1]), Number(ipv4[2]));
    }
    // IPv6 loopback/link-local/unique-local literals (bracketed or bare).
    const bare = hostname.replace(/^\[|\]$/g, "");
    if (bare === "::1" || bare.startsWith("fe80:") || bare.startsWith("fc") || bare.startsWith("fd")) return true;
    // IPv4-mapped IPv6 (::ffff:a.b.c.d) — judge the embedded IPv4 address
    // by the identical rules as a plain IPv4 literal (see comment above).
    const mapped = extractIpv4MappedOctets(bare);
    if (mapped) return isPrivateIpv4Octets(mapped[0], mapped[1]);
    return false;
}

// A resolved URL is only trustworthy enough to hand to the user as a
// "verified direct merchant URL" if it clears every basic safety check —
// real http(s) protocol, not Google's own redirect host, and not an
// internal/private/loopback address. Combines the checks above into the
// single gate comparison/urlResolver.js applies to every candidate before
// ever accepting it (Phase 11).
function isSafeExternalUrl(url) {
    return hasSafeProtocol(url) && !isGoogleHost(url) && !isPrivateOrLocalHost(url);
}

module.exports = { isGoogleHost, hasSafeProtocol, getHostname, belongsToDomain, isPrivateOrLocalHost, isSafeExternalUrl };
