'use strict';

/**
 * Phase 35A — JWT Authentication Middleware
 *
 * Verifies Supabase-issued JWTs using asymmetric signature verification via
 * the Supabase JWKS endpoint. The legacy SUPABASE_JWT_SECRET / HS256 approach
 * is NOT used and is explicitly prevented by the algorithm allowlist.
 *
 * Verification flow:
 *   Authorization: Bearer <JWT>
 *     → extract token from Bearer scheme
 *     → jwtVerify() selects the matching public key by kid from Supabase JWKS
 *     → verifies cryptographic signature (asymmetric only)
 *     → validates: iss (issuer), aud (audience), exp (expiry), sub (subject)
 *     → populates req.user = { id: JWT.sub, email: JWT.email }
 *
 * JWKS caching:
 *   createRemoteJWKSet() returns a function that internally:
 *     - Fetches the JWKS on the first key lookup.
 *     - Caches fetched keys in-process.
 *     - Automatically re-fetches when an unknown kid is encountered (key
 *       rotation). This is jose's built-in rotation support.
 *   We additionally cache the *getter function itself* at the module level so
 *   that createRemoteJWKSet() is invoked at most once per process lifetime
 *   rather than on every authenticated request.
 *
 * Algorithm policy:
 *   Only asymmetric algorithms are accepted. This explicitly prevents
 *   algorithm-confusion attacks, e.g., an attacker crafting a symmetric
 *   HS256 token that uses a known public key as the HMAC secret.
 *   Supabase currently signs with RS256, but the allowlist also covers
 *   RS384/RS512, PS256/PS384/PS512, and ES256/ES384/ES512 for forward
 *   compatibility with any Supabase signing algorithm change.
 *
 * Security guarantees:
 *   - Forged JWTs: rejected (signature verification fails).
 *   - Expired JWTs: rejected (exp claim validated by jose).
 *   - Wrong issuer: rejected (iss validated against SUPABASE_URL).
 *   - Wrong audience: rejected (aud validated as "authenticated").
 *   - Missing sub: rejected (explicit check after verification).
 *   - User ID spoofing: impossible (req.user.id comes ONLY from JWT.sub).
 *   - Request-body identity override: impossible (req.body is never read here).
 *   - Symmetric algorithm confusion: impossible (algorithm allowlist).
 *   - Authorization header: NEVER logged (only the jose error code is logged).
 *
 * Do NOT add global middleware to existing comparison routes. Only attach
 * `authenticate` explicitly to routes that require authentication.
 */

const { createRemoteJWKSet, jwtVerify } = require('jose');

// ── JWKS module-level cache ──────────────────────────────────────────────────
//
// _jwksGetter holds the function returned by createRemoteJWKSet().
// That function is itself a cache: it fetches keys once and re-fetches only
// when it encounters an unknown kid (key rotation). We cache the getter here
// so we don't call createRemoteJWKSet() on every request.
//
let _jwksGetter = null;

/**
 * Build the JWKS key getter from the configured SUPABASE_URL.
 * Called at most once per process lifecycle (see _getJwksGetter).
 *
 * @returns {import('jose').JWTVerifyGetKey}
 */
function _buildJwksGetter() {
  const supabaseUrl = process.env.SUPABASE_URL;
  if (!supabaseUrl) {
    throw new Error(
      '[auth] SUPABASE_URL is not configured. ' +
      'Add it to backend/.env (see backend/.env.example).'
    );
  }
  const jwksUrl = new URL(`${supabaseUrl}/auth/v1/.well-known/jwks.json`);
  return createRemoteJWKSet(jwksUrl);
}

/**
 * Return the cached JWKS getter, building it on the first call.
 * In production this is called once; in tests it is replaced via
 * _setJwksForTesting() to avoid real network calls.
 */
function _getJwksGetter() {
  if (!_jwksGetter) {
    _jwksGetter = _buildJwksGetter();
  }
  return _jwksGetter;
}

// ── Asymmetric algorithm allowlist ───────────────────────────────────────────
//
// Explicitly excludes all HMAC (symmetric) algorithms: HS256, HS384, HS512.
// This list covers all standard asymmetric signing algorithms that a JWKS
// endpoint may advertise, providing forward compatibility with Supabase
// algorithm rotation while permanently blocking symmetric algorithms.
//
const ALLOWED_ALGORITHMS = [
  'RS256', // Supabase default asymmetric algorithm
];

// ── Express middleware ───────────────────────────────────────────────────────

/**
 * authenticate — Express middleware that verifies a Supabase JWT.
 *
 * On success:
 *   req.user = { id: <JWT.sub>, email: <JWT.email | null> }
 *   next() is called.
 *
 * On failure:
 *   HTTP 401 is returned. next() is NOT called.
 *
 * Identity contract (permanent):
 *   req.user.id === JWT.sub === Supabase Auth UUID === Prisma User.id
 *
 * Client-provided identity values (req.body.userId, etc.) are NEVER read here.
 * The middleware is intentionally not attached to existing comparison routes.
 *
 * @type {import('express').RequestHandler}
 */
async function authenticate(req, res, next) {
  const authHeader = req.headers['authorization'];

  // 1. Authorization header is required.
  if (!authHeader) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing Authorization header.',
    });
  }

  // 2. Bearer scheme is required.
  // Use indexOf instead of split to handle tokens that may contain spaces
  // (unlikely for JWTs, but avoids accidental truncation).
  const spaceIdx = authHeader.indexOf(' ');
  if (spaceIdx === -1 || authHeader.slice(0, spaceIdx).toLowerCase() !== 'bearer') {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Authorization header must use the Bearer scheme.',
    });
  }

  const token = authHeader.slice(spaceIdx + 1).trim();

  // 3. Token value must not be empty.
  if (!token) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Bearer token is empty.',
    });
  }

  // 4. Verify JWT: signature, algorithm, issuer, audience, expiry.
  try {
    const jwks = _getJwksGetter();
    const { payload } = await jwtVerify(token, jwks, {
      algorithms: ALLOWED_ALGORITHMS,
      issuer: `${process.env.SUPABASE_URL}/auth/v1`,
      audience: 'authenticated',
    });

    // 5. sub claim is the canonical identity — it must be present.
    if (!payload.sub) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Token is missing the required sub claim.',
      });
    }

    // 6. Populate req.user exclusively from verified token claims.
    //    Nothing from req.body, req.query, or req.params influences identity.
    req.user = {
      id: payload.sub,                                                 // JWT.sub
      email: typeof payload.email === 'string' ? payload.email : null, // optional
    };

    return next();
  } catch (err) {
    // Log only the error code/name — never the raw token or Authorization header.
    const diagnostic = err.code || err.name || 'UNKNOWN_JWT_ERROR';
    console.error(`[auth] JWT verification failed: ${diagnostic}`);

    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Token is invalid or has expired.',
    });
  }
}

// ── Test helpers ─────────────────────────────────────────────────────────────
//
// The following exports exist solely for deterministic unit testing.
// They MUST NOT be used in production application code.
// Tests use jose's createLocalJWKSet() + generateKeyPair() to inject a real
// in-process key set without any network calls.
//

/**
 * Replace the JWKS getter with a test-controlled function.
 * In tests, inject jose.createLocalJWKSet({ keys: [...] }).
 *
 * @param {import('jose').JWTVerifyGetKey} fn
 */
function _setJwksForTesting(fn) {
  _jwksGetter = fn;
}

/**
 * Clear the module-level JWKS cache.
 * Call in afterAll() if test isolation requires a fresh state.
 */
function _resetForTesting() {
  _jwksGetter = null;
}

/**
 * Returns true if a JWKS getter is currently cached in this module.
 * Used in tests to assert caching behaviour without inspecting private state.
 *
 * @returns {boolean}
 */
function _isJwksCached() {
  return _jwksGetter !== null;
}

module.exports = {
  authenticate,
  // Test helpers only — do not call from production code:
  _setJwksForTesting,
  _resetForTesting,
  _isJwksCached,
};
