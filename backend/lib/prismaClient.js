'use strict';

/**
 * Prisma Client singleton — Phase 35A
 *
 * A single PrismaClient instance is shared for the lifetime of the process.
 * Creating multiple instances would exhaust the connection pool.
 *
 * Singleton strategy:
 *   - In production: module-level variable (Node's module cache ensures one
 *     instance per process).
 *   - In development/test: stored on `global` to survive Jest module isolation
 *     and any framework hot-reload. This prevents "too many connections" errors
 *     during `jest --watch` or similar workflows.
 *
 * For unit tests: mock this module via:
 *   jest.mock('../lib/prismaClient', () => ({ user: { upsert: jest.fn() } }));
 *   (or the appropriate relative path from your test file)
 *
 * For integration tests with a real database: ensure DATABASE_URL is set in
 * the test environment (e.g., a separate test schema on Supabase).
 *
 * No database connection is made at module load time — PrismaClient connects
 * lazily on the first query.
 */

const { PrismaClient } = require('@prisma/client');

function getPrismaClient() {
  // Reuse across hot-reloads in development / Jest test isolation
  if (!global._pricePulsePrisma) {
    global._pricePulsePrisma = new PrismaClient({
      log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
    });
  }
  return global._pricePulsePrisma;
}

module.exports = getPrismaClient();
