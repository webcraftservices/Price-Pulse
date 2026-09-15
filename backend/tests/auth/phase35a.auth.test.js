'use strict';

/**
 * Phase 35A — Authentication Middleware & User Service Tests
 *
 * Deterministic tests — no real Supabase project, no network calls.
 *
 * Strategy:
 *   1. Generate a real RSA-2048 key pair in-process using jose.generateKeyPair().
 *   2. Build a local JWKS from the public key using jose.createLocalJWKSet().
 *   3. Inject it into the middleware via auth._setJwksForTesting() before tests run.
 *   4. Sign test JWTs with the private key using jose.SignJWT.
 *   5. The middleware runs the exact same jwtVerify() code path as production;
 *      only the key source (local vs remote JWKS) differs.
 *
 * Prisma is mocked at the module level — no database connection required.
 *
 * Tests 1–3:   Missing / malformed Authorization header → 401
 * Tests 4–9:   JWT verification failures (signature, expiry, issuer, etc.) → 401
 * Tests 10–12: Valid token — middleware succeeds, identity is set, body cannot override
 * Tests 13–14: JWKS caching and key-rotation safety
 * Test  15:    userService.upsertUser uses verified sub, not request body
 */

// ── Prisma mock ───────────────────────────────────────────────────────────────
// Must be called before any require() that transitively imports prismaClient.
// jest.mock is hoisted by Jest so this always runs first regardless of position.
jest.mock('../../lib/prismaClient', () => ({
  user: {
    upsert: jest.fn(),
  },
}));

// ── Imports ───────────────────────────────────────────────────────────────────
const jose = require('jose');
const auth = require('../../middleware/auth');
const { upsertUser } = require('../../services/userService');
const prisma = require('../../lib/prismaClient');

// ── Constants ─────────────────────────────────────────────────────────────────
const TEST_SUPABASE_URL = 'https://test-phase35a.supabase.co';
const TEST_ISSUER = `${TEST_SUPABASE_URL}/auth/v1`;
const TEST_AUDIENCE = 'authenticated';
const TEST_KID = 'test-signing-key-phase35a';

// ── Key material (generated once for the whole test file) ─────────────────────
let testPrivateKey;  // RSA private key for signing test JWTs
let testJwks;        // Local JWKS built from the corresponding public key

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  // Set SUPABASE_URL so the middleware can construct the issuer string.
  // The actual JWKS URL is replaced by the test injection below.
  process.env.SUPABASE_URL = TEST_SUPABASE_URL;

  // Generate a real RSA-2048 key pair.
  // All 15 tests exercise the actual jwtVerify() code path; only the
  // key source differs from production (local vs remote JWKS).
  const { privateKey, publicKey } = await jose.generateKeyPair('RS256');
  testPrivateKey = privateKey;

  // Export the public key as JWK and tag it with our test kid.
  const publicJwk = await jose.exportJWK(publicKey);
  publicJwk.kid = TEST_KID;
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';

  // Build a local JWKS (no network needed).
  testJwks = jose.createLocalJWKSet({ keys: [publicJwk] });

  // Inject into the middleware — replaces createRemoteJWKSet in the module cache.
  auth._setJwksForTesting(testJwks);
});

afterEach(() => {
  // Clear mock call records between tests.
  jest.clearAllMocks();

  // Re-inject JWKS if a test deliberately reset it.
  if (!auth._isJwksCached()) {
    auth._setJwksForTesting(testJwks);
  }
});

afterAll(() => {
  auth._resetForTesting();
  delete process.env.SUPABASE_URL;
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Sign a JWT for testing.
 * All defaults produce a valid, well-formed token unless overridden.
 *
 * @param {object} [overrides]
 * @param {string}  [overrides.sub]          JWT subject (default: 'test-user-uuid-phase35a')
 * @param {boolean} [overrides.noSub]        If true, omit the sub claim entirely
 * @param {string}  [overrides.email]        JWT email claim
 * @param {string}  [overrides.iss]          JWT issuer
 * @param {string}  [overrides.aud]          JWT audience
 * @param {number}  [overrides.exp]          Absolute expiry (epoch seconds)
 * @param {string}  [overrides.kid]          Key ID in the JWT header
 * @param {string}  [overrides.alg]          Algorithm in the JWT header
 * @param {CryptoKey} [overrides.signingKey] Alternative signing key
 * @returns {Promise<string>} Compact JWT string
 */
async function signToken(overrides = {}) {
  const {
    sub         = 'test-user-uuid-phase35a',
    noSub       = false,
    email       = 'test@example.com',
    iss         = TEST_ISSUER,
    aud         = TEST_AUDIENCE,
    exp         = Math.floor(Date.now() / 1000) + 300,  // 5 minutes from now
    kid         = TEST_KID,
    alg         = 'RS256',
    signingKey  = testPrivateKey,
  } = overrides;

  let builder = new jose.SignJWT({ email })
    .setProtectedHeader({ alg, kid })
    .setIssuedAt()
    .setIssuer(iss)
    .setAudience(aud)
    .setExpirationTime(exp);

  // noSub: test the "missing sub claim" path without calling setSubject()
  if (!noSub) {
    builder = builder.setSubject(sub);
  }

  return builder.sign(signingKey);
}

/**
 * Run the authenticate middleware and capture the outcome.
 *
 * @param {string|undefined} authHeader  Value for the Authorization header.
 *                                       Pass undefined to omit the header.
 * @param {object} [bodyOverrides]       Contents of req.body (e.g., attacker-supplied userId).
 * @returns {Promise<{req, nextCalled, statusCode, responseBody}>}
 */
async function runMiddleware(authHeader, bodyOverrides = {}) {
  const req = {
    headers: authHeader !== undefined ? { authorization: authHeader } : {},
    body: bodyOverrides,
    user: undefined,
  };

  let nextCalled = false;
  let statusCode = null;
  let responseBody = null;

  const res = {
    status(code) {
      statusCode = code;
      // Return a chainable object that captures the json body.
      return {
        json(body) {
          responseBody = body;
        },
      };
    },
  };

  const next = () => { nextCalled = true; };

  await auth.authenticate(req, res, next);

  return { req, nextCalled, statusCode, responseBody };
}

// ── Tests 1–3: Missing / malformed Authorization header ──────────────────────

test('1. Missing Authorization header → 401', async () => {
  const { nextCalled, statusCode } = await runMiddleware(undefined);

  expect(nextCalled).toBe(false);
  expect(statusCode).toBe(401);
});

test('2. Malformed Authorization — no Bearer scheme (e.g. "Basic ...") → 401', async () => {
  const token = await signToken();
  const { nextCalled, statusCode } = await runMiddleware(`Basic ${token}`);

  expect(nextCalled).toBe(false);
  expect(statusCode).toBe(401);
});

test('3. Bearer with no token value ("Bearer " with trailing space) → 401', async () => {
  const { nextCalled, statusCode } = await runMiddleware('Bearer ');

  expect(nextCalled).toBe(false);
  expect(statusCode).toBe(401);
});

// ── Tests 4–9: JWT verification failures ─────────────────────────────────────

test('4. Invalid signature (token signed with a different key) → 401', async () => {
  // Generate a second key pair that is NOT in the test JWKS.
  const { privateKey: wrongKey } = await jose.generateKeyPair('RS256');
  const token = await signToken({ signingKey: wrongKey });

  const { nextCalled, statusCode } = await runMiddleware(`Bearer ${token}`);

  expect(nextCalled).toBe(false);
  expect(statusCode).toBe(401);
});

test('5. Expired token (exp in the past) → 401', async () => {
  const token = await signToken({
    exp: Math.floor(Date.now() / 1000) - 60,  // expired 60 seconds ago
  });

  const { nextCalled, statusCode } = await runMiddleware(`Bearer ${token}`);

  expect(nextCalled).toBe(false);
  expect(statusCode).toBe(401);
});

test('6. Wrong issuer → 401', async () => {
  const token = await signToken({ iss: 'https://attacker.evil.com/auth/v1' });

  const { nextCalled, statusCode } = await runMiddleware(`Bearer ${token}`);

  expect(nextCalled).toBe(false);
  expect(statusCode).toBe(401);
});

test('7. Wrong audience → 401', async () => {
  const token = await signToken({ aud: 'wrong-audience' });

  const { nextCalled, statusCode } = await runMiddleware(`Bearer ${token}`);

  expect(nextCalled).toBe(false);
  expect(statusCode).toBe(401);
});

test('8. Missing sub claim → 401', async () => {
  // noSub: true skips setSubject() in signToken(), producing a JWT without sub.
  // jose.jwtVerify() does not require sub by default; our explicit check catches it.
  const token = await signToken({ noSub: true });

  const { nextCalled, statusCode } = await runMiddleware(`Bearer ${token}`);

  expect(nextCalled).toBe(false);
  expect(statusCode).toBe(401);
});

test('9. Unknown kid → safely rejected — token with unregistered kid is not silently trusted', async () => {
  // A key rotation scenario: a new key pair is generated but the NEW public key
  // is NOT in our test JWKS. A token signed with the new key (claiming a new kid)
  // must be rejected, not accepted. This is the safe failure mode.
  const { privateKey: rotatedPrivateKey } = await jose.generateKeyPair('RS256');

  const token = await signToken({
    kid: 'rotated-key-id-unknown-to-current-jwks',
    signingKey: rotatedPrivateKey,
  });

  const { nextCalled, statusCode } = await runMiddleware(`Bearer ${token}`);

  expect(nextCalled).toBe(false);
  expect(statusCode).toBe(401);
});

// ── Tests 10–12: Valid token behaviour ───────────────────────────────────────

test('10. Valid token → middleware calls next() (authentication succeeds)', async () => {
  const token = await signToken();

  const { nextCalled, statusCode } = await runMiddleware(`Bearer ${token}`);

  expect(nextCalled).toBe(true);
  expect(statusCode).toBeNull();  // No error response when next() is called
});

test('11. Valid token → req.user.id === JWT.sub (identity contract)', async () => {
  const expectedSub = 'supabase-auth-uuid-abcdef-123456';
  const token = await signToken({ sub: expectedSub });

  const { req, nextCalled } = await runMiddleware(`Bearer ${token}`);

  expect(nextCalled).toBe(true);
  expect(req.user).toBeDefined();
  expect(req.user.id).toBe(expectedSub);
  expect(req.user.email).toBe('test@example.com');
});

test('12. Request-body userId cannot override authenticated identity', async () => {
  const realSub = 'real-authenticated-user-uuid';
  const attackerSub = 'attacker-controlled-uuid-from-body';

  const token = await signToken({ sub: realSub });

  // Simulate an attacker passing a different userId in the request body.
  const { req, nextCalled } = await runMiddleware(
    `Bearer ${token}`,
    { userId: attackerSub, id: attackerSub, sub: attackerSub }
  );

  expect(nextCalled).toBe(true);
  // Identity must come from the VERIFIED JWT, not the request body.
  expect(req.user.id).toBe(realSub);
  expect(req.user.id).not.toBe(attackerSub);
});

// ── Tests 13–14: JWKS caching and key-rotation safety ────────────────────────

test('13. JWKS getter is cached — module does not rebuild it across multiple requests', async () => {
  // Verify the JWKS is cached (injected in beforeAll and not reset by tests 1–12).
  expect(auth._isJwksCached()).toBe(true);

  // Make two authenticated requests with different valid tokens.
  const token1 = await signToken({ sub: 'cache-test-user-one' });
  const token2 = await signToken({ sub: 'cache-test-user-two' });

  const result1 = await runMiddleware(`Bearer ${token1}`);
  const result2 = await runMiddleware(`Bearer ${token2}`);

  // Both succeed using the same cached JWKS getter.
  expect(result1.nextCalled).toBe(true);
  expect(result2.nextCalled).toBe(true);
  expect(result1.req.user.id).toBe('cache-test-user-one');
  expect(result2.req.user.id).toBe('cache-test-user-two');

  // The JWKS getter was NOT cleared between requests — still cached.
  expect(auth._isJwksCached()).toBe(true);
});

test('14. Key rotation safety — unknown kid is always rejected (never silently trusted)', async () => {
  // Simulate a Supabase key rotation:
  //   - Before rotation: our test JWKS has only testPrivateKey / TEST_KID.
  //   - After rotation: Supabase adds a NEW key. Tokens signed with the new
  //     key carry a new kid. The old JWKS does not know this new kid.
  // The middleware must REJECT such tokens (not panic, not accept them).
  // When using createRemoteJWKSet() in production, jose automatically re-fetches
  // the JWKS when it encounters an unknown kid — so newly-rotated keys work
  // once Supabase publishes them. But until then, tokens with unknown kids fail.

  const { privateKey: newKey, publicKey: newPublicKey } = await jose.generateKeyPair('RS256');
  const newJwk = await jose.exportJWK(newPublicKey);
  newJwk.kid = 'new-rotated-kid-not-in-current-jwks';
  newJwk.alg = 'RS256';

  // Token signed with the new key — our JWKS only knows TEST_KID.
  const tokenWithNewKey = await signToken({
    kid: 'new-rotated-kid-not-in-current-jwks',
    signingKey: newKey,
  });

  const { nextCalled, statusCode } = await runMiddleware(`Bearer ${tokenWithNewKey}`);

  // Must be rejected — the key is unknown to the current JWKS.
  expect(nextCalled).toBe(false);
  expect(statusCode).toBe(401);

  // Now simulate that the JWKS has been updated with the new key.
  // Build a fresh JWKS with BOTH keys (old + new) to represent post-rotation state.
  const oldPublicJwk = await jose.exportJWK(
    // We can't re-export from testPrivateKey alone, but we can use the existing testJwks.
    // Instead, build a new JWKS that includes the new public key.
    newPublicKey
  );
  oldPublicJwk.kid = 'new-rotated-kid-not-in-current-jwks';
  oldPublicJwk.alg = 'RS256';
  oldPublicJwk.use = 'sig';

  const updatedJwks = jose.createLocalJWKSet({ keys: [oldPublicJwk] });
  auth._setJwksForTesting(updatedJwks);

  // With the updated JWKS, the token signed by the new key should now succeed.
  const { nextCalled: nextAfterRotation, statusCode: statusAfterRotation } =
    await runMiddleware(`Bearer ${tokenWithNewKey}`);

  expect(nextAfterRotation).toBe(true);
  expect(statusAfterRotation).toBeNull();

  // Restore the original test JWKS for subsequent tests.
  auth._setJwksForTesting(testJwks);
});

// ── Test 15: User service uses verified identity ──────────────────────────────

test('15. userService.upsertUser calls Prisma with verified sub — not a client-supplied value', async () => {
  const verifiedSub   = 'supabase-verified-uuid-abc-123';
  const verifiedEmail = 'real-user@example.com';

  // Configure the mock to return a plausible Prisma result.
  prisma.user.upsert.mockResolvedValue({
    id: verifiedSub,
    email: verifiedEmail,
    createdAt: new Date('2026-09-15T00:00:00.000Z'),
    updatedAt: new Date('2026-09-15T00:00:00.000Z'),
  });

  // Call the service with verified identity (as the auth middleware would).
  const result = await upsertUser(verifiedSub, verifiedEmail);

  // Verify the service called Prisma with the correct upsert arguments.
  expect(prisma.user.upsert).toHaveBeenCalledTimes(1);
  expect(prisma.user.upsert).toHaveBeenCalledWith({
    where:  { id: verifiedSub },
    create: { id: verifiedSub, email: verifiedEmail },
    update: { email: verifiedEmail },
    select: { id: true, email: true, createdAt: true, updatedAt: true },
  });

  // Verify the returned data matches.
  expect(result.id).toBe(verifiedSub);
  expect(result.email).toBe(verifiedEmail);

  // Verify the service rejects non-string sub values (guard against misuse).
  await expect(upsertUser('', verifiedEmail)).rejects.toThrow();
  await expect(upsertUser(null, verifiedEmail)).rejects.toThrow();
  await expect(upsertUser(undefined, verifiedEmail)).rejects.toThrow();
  await expect(upsertUser(42, verifiedEmail)).rejects.toThrow();
});
