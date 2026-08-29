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
        const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
        if (a === 127) return true; // loopback
        if (a === 10) return true; // private
        if (a === 172 && b >= 16 && b <= 31) return true; // private
        if (a === 192 && b === 168) return true; // private
        if (a === 169 && b === 254) return true; // link-local
        if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
        if (a === 0) return true; // "this network"
        return false;
    }
    // IPv6 loopback/link-local/unique-local literals (bracketed or bare).
    const bare = hostname.replace(/^\[|\]$/g, "");
    if (bare === "::1" || bare.startsWith("fe80:") || bare.startsWith("fc") || bare.startsWith("fd")) return true;
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
