'use strict';

/**
 * Phase 35A — User Service
 *
 * Manages local User records that mirror Supabase Auth identities.
 *
 * Identity invariant (permanent):
 *   User.id === JWT.sub === Supabase Auth UUID
 *
 * This service ONLY accepts identity from verified JWT claims passed down from
 * the auth middleware. It never reads or accepts user identity from request
 * bodies, query parameters, or any client-provided source.
 *
 * Future phases may extend this service with:
 *   - Subscription association  (via User.id)
 *   - Alert ownership           (via User.id)
 *   - Billing / usage tracking  (via User.id)
 *
 * The User.id is stable. All future relations extend from it.
 */

const prisma = require('../lib/prismaClient');

/**
 * Upsert a User row for the given verified Supabase identity.
 *
 * - New user  → creates a User row with id=sub.
 * - Existing  → updates the email field (handles email changes in Supabase).
 * - Prisma's @updatedAt handles the timestamp automatically.
 *
 * @param {string}      sub   Verified JWT.sub (Supabase Auth UUID).
 *                            Must come from middleware-validated claims ONLY.
 *                            Must NOT originate from a request body.
 * @param {string|null} email Email from the verified JWT claims.
 *                            Supabase email-auth always provides this.
 *                            Defaults to empty string when absent (e.g., OAuth
 *                            providers that withhold email).
 * @returns {Promise<{id: string, email: string, createdAt: Date, updatedAt: Date}>}
 * @throws  {Error} If sub is not a non-empty string.
 */
async function upsertUser(sub, email) {
  if (!sub || typeof sub !== 'string') {
    throw new Error(
      '[userService] sub must be a non-empty string from a verified JWT. ' +
      'Never pass client-provided identity here.'
    );
  }

  const emailValue = typeof email === 'string' && email.length > 0 ? email : '';

  return prisma.user.upsert({
    where: { id: sub },
    create: {
      id: sub,
      email: emailValue,
    },
    update: {
      email: emailValue,
    },
    select: {
      id: true,
      email: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

module.exports = { upsertUser };
