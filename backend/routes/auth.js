'use strict';

/**
 * Phase 35A — Auth Routes
 *
 * Mounted at /api/auth in server.js.
 *
 * Routes:
 *   POST /api/auth/me
 *     Verifies the caller's Supabase JWT, upserts a local User record,
 *     and returns the persisted user.
 *
 * Identity source: exclusively from the verified JWT (req.user, populated by
 *   the authenticate middleware). Request body values are NEVER used as
 *   identity — any req.body.userId is silently ignored.
 *
 * Out of scope for this route (future phases):
 *   - Registration / password reset (handled by Supabase Auth)
 *   - Email verification            (handled by Supabase Auth)
 *   - Subscription management       (Phase 35B+)
 *   - Billing / plan enforcement    (Phase 35B+)
 */

const express = require('express');
const { authenticate } = require('../middleware/auth');
const { upsertUser } = require('../services/userService');

const router = express.Router();

/**
 * POST /api/auth/me
 *
 * Requires: Authorization: Bearer <Supabase JWT>
 *
 * Success — 200:
 *   { "id": "<UUID>", "email": "<email>", "createdAt": "<ISO8601>" }
 *
 * Errors:
 *   401 — missing, malformed, or cryptographically invalid JWT
 *   500 — unexpected server error (database unavailable, etc.)
 *
 * Security contract:
 *   - req.body.userId (or any body field) has ZERO effect on identity.
 *   - Identity is derived solely from req.user.id (JWT.sub after verification).
 *   - This endpoint does NOT bypass the authenticate middleware.
 */
router.post('/me', authenticate, async (req, res, next) => {
  try {
    // req.user is populated exclusively by the authenticate middleware from
    // the verified JWT payload. No client-supplied identity reaches here.
    const user = await upsertUser(req.user.id, req.user.email);

    return res.status(200).json({
      id: user.id,
      email: user.email,
      createdAt: user.createdAt,
    });
  } catch (err) {
    // Let Express's error handler deal with unexpected failures
    // (e.g., DB connection errors). Do not leak internals to the client.
    console.error('[auth/me] Unexpected error:', err.message);
    return next(err);
  }
});

module.exports = router;
