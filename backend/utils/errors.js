/**
 * Errors
 * ------------------------------------------------------------------
 * One error type for the whole comparison pipeline. Every throw site
 * supplies a human-friendly message (what the frontend actually shows)
 * and an HTTP status; `code` is optional metadata for logs/diagnostics,
 * never shown to the user directly.
 *
 * Codes in use: INVALID_INPUT, PRODUCT_NOT_IDENTIFIED, NO_MATCHING_OFFERS,
 * PROVIDER_FAILURE, CONFIGURATION_ERROR. (RATE_LIMITED, TIMEOUT, and
 * URL_RESOLUTION_FAILED are reserved for later phases — URL resolution
 * failures are currently non-fatal and degrade gracefully instead of
 * throwing, per spec Part 22/39.)
 */

class CompareError extends Error {
    constructor(message, statusCode = 500, code = null) {
        super(message);
        this.statusCode = statusCode;
        this.code = code;
    }
}

module.exports = { CompareError };
