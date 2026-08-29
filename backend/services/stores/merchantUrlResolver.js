/**
 * Merchant URL Resolver — backward-compatible shim
 * ------------------------------------------------------------------
 * The actual resolution logic now lives in comparison/urlResolver.js
 * (resolveDirectMerchantUrl) and providers/merchants/merchantRegistry.js
 * (domain allowlist). This file re-exports the same names compareService.js
 * already imports from "./stores/merchantUrlResolver", so no caller needs
 * to change. See comparison/urlResolver.js for full behavior documentation
 * (bounded, cached, allowlist-validated, disabled by default via
 * ENABLE_MERCHANT_URL_RESOLVER, never fabricates a URL).
 */

const { resolveDirectMerchantUrl, isEnabled } = require("../../comparison/urlResolver");
const { getResolvableDomain, REGISTRY } = require("../../providers/merchants/merchantRegistry");
const { belongsToDomain } = require("../../utils/url");

function getMerchantDomain(merchantName) {
    return getResolvableDomain(merchantName);
}

const MERCHANT_DOMAINS = Object.fromEntries(
    Object.entries(REGISTRY)
        .filter(([, entry]) => entry.domain)
        .map(([name, entry]) => [name, entry.domain])
);

module.exports = { resolveDirectMerchantUrl, getMerchantDomain, belongsToDomain, MERCHANT_DOMAINS, isEnabled };
