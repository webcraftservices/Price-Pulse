'use strict';

/**
 * Phase 35B — Alert CRUD Persistence Tests
 * 
 * Tests the real database using the dedicated test environment.
 * Reuses the Phase 35A JWKS injection for deterministic authentication testing.
 */

const request = require('supertest');
const express = require('express');
const jose = require('jose');

const alertsRoute = require('../../routes/alerts');
const auth = require('../../middleware/auth');
const prisma = require('../../lib/prismaClient');

jest.setTimeout(30000); // Prevent hook timeout

// ── Setup Express App ────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
// Mount exactly as server.js does
app.use('/api/alerts', alertsRoute);
// Add error handler so Express doesn't dump stack traces to console in tests
app.use((err, req, res, next) => {
  res.status(500).json({ error: err.message });
});

// ── Constants & Keys ──────────────────────────────────────────────────────────
const TEST_SUPABASE_URL = 'https://test-phase35b.supabase.co';
const TEST_ISSUER = `${TEST_SUPABASE_URL}/auth/v1`;
const TEST_AUDIENCE = 'authenticated';
const TEST_KID = 'test-signing-key-phase35b';

let testPrivateKey;
let testJwks;

const USER_1_ID = '00000000-0000-0000-0000-000000000001';
const USER_2_ID = '00000000-0000-0000-0000-000000000002';

let token1;
let token2;

const MOCK_PRODUCT = {
  brand: 'Apple',
  model: 'iPhone 15',
  storage: '128GB'
};

// ── Setup / Teardown ──────────────────────────────────────────────────────────
beforeAll(async () => {
  process.env.SUPABASE_URL = TEST_SUPABASE_URL;

  // 1. Setup Auth
  const { privateKey, publicKey } = await jose.generateKeyPair('RS256');
  testPrivateKey = privateKey;
  const publicJwk = await jose.exportJWK(publicKey);
  publicJwk.kid = TEST_KID;
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  testJwks = jose.createLocalJWKSet({ keys: [publicJwk] });
  auth._setJwksForTesting(testJwks);

  // 2. Generate Tokens
  token1 = await signToken(USER_1_ID);
  token2 = await signToken(USER_2_ID);

  // 3. Ensure test users exist in DB
  await prisma.user.upsert({
    where: { id: USER_1_ID },
    update: {},
    create: { id: USER_1_ID, email: 'user1@test.com' }
  });
  await prisma.user.upsert({
    where: { id: USER_2_ID },
    update: {},
    create: { id: USER_2_ID, email: 'user2@test.com' }
  });

  // Clean up any old alerts from these users
  await prisma.priceAlert.deleteMany({
    where: { userId: { in: [USER_1_ID, USER_2_ID] } }
  });
});

afterAll(async () => {
  // Cleanup test alerts
  await prisma.priceAlert.deleteMany({
    where: { userId: { in: [USER_1_ID, USER_2_ID] } }
  });
  
  auth._resetForTesting();
  delete process.env.SUPABASE_URL;
  
  // Close Prisma connection to allow jest to exit cleanly
  await prisma.$disconnect();
});

// ── Helpers ───────────────────────────────────────────────────────────────────
async function signToken(sub) {
  return new jose.SignJWT({ email: 'test@example.com' })
    .setProtectedHeader({ alg: 'RS256', kid: TEST_KID })
    .setIssuedAt()
    .setIssuer(TEST_ISSUER)
    .setAudience(TEST_AUDIENCE)
    .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
    .setSubject(sub)
    .sign(testPrivateKey);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Authentication', () => {
  it('rejects unauthenticated POST', async () => {
    const res = await request(app).post('/api/alerts').send({});
    expect(res.status).toBe(401);
  });
  
  it('rejects unauthenticated GET', async () => {
    const res = await request(app).get('/api/alerts');
    expect(res.status).toBe(401);
  });
  
  it('rejects unauthenticated GET by ID', async () => {
    const res = await request(app).get('/api/alerts/some-id');
    expect(res.status).toBe(401);
  });
  
  it('rejects unauthenticated PATCH', async () => {
    const res = await request(app).patch('/api/alerts/some-id').send({});
    expect(res.status).toBe(401);
  });
  
  it('rejects unauthenticated DELETE', async () => {
    const res = await request(app).delete('/api/alerts/some-id');
    expect(res.status).toBe(401);
  });
});

describe('Validation', () => {
  it('rejects missing canonicalProduct', async () => {
    const res = await request(app)
      .post('/api/alerts')
      .set('Authorization', `Bearer ${token1}`)
      .send({
        targetPrice: 1000,
        priceContext: 'FULL_INTERNET'
      });
    expect(res.status).toBe(400);
  });

  it('rejects invalid canonicalProduct', async () => {
    const res = await request(app)
      .post('/api/alerts')
      .set('Authorization', `Bearer ${token1}`)
      .send({
        canonicalProduct: "not an object",
        targetPrice: 1000,
        priceContext: 'FULL_INTERNET'
      });
    expect(res.status).toBe(400);
  });

  it('rejects missing targetPrice', async () => {
    const res = await request(app)
      .post('/api/alerts')
      .set('Authorization', `Bearer ${token1}`)
      .send({
        canonicalProduct: MOCK_PRODUCT,
        priceContext: 'FULL_INTERNET'
      });
    expect(res.status).toBe(400);
  });

  it('rejects zero or negative targetPrice', async () => {
    for (const val of [0, -10]) {
      const res = await request(app)
        .post('/api/alerts')
        .set('Authorization', `Bearer ${token1}`)
        .send({
          canonicalProduct: MOCK_PRODUCT,
          targetPrice: val,
          priceContext: 'FULL_INTERNET'
        });
      expect(res.status).toBe(400);
    }
  });

  it('rejects invalid targetPrice (NaN, null, string)', async () => {
    for (const val of [null, '1000', NaN]) {
      const res = await request(app)
        .post('/api/alerts')
        .set('Authorization', `Bearer ${token1}`)
        .send({
          canonicalProduct: MOCK_PRODUCT,
          targetPrice: val,
          priceContext: 'FULL_INTERNET'
        });
      expect(res.status).toBe(400);
    }
  });

  it('rejects invalid priceContext', async () => {
    const res = await request(app)
      .post('/api/alerts')
      .set('Authorization', `Bearer ${token1}`)
      .send({
        canonicalProduct: MOCK_PRODUCT,
        targetPrice: 1000,
        priceContext: 'INVALID_CONTEXT'
      });
    expect(res.status).toBe(400);
  });
});

describe('CRUD & Ownership', () => {
  let user1AlertId;
  let user2AlertId;

  it('creates a valid alert for User 1', async () => {
    const res = await request(app)
      .post('/api/alerts')
      .set('Authorization', `Bearer ${token1}`)
      .send({
        canonicalProduct: MOCK_PRODUCT,
        targetPrice: 1000,
        priceContext: 'FULL_INTERNET'
      });
    
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
    expect(res.body.userId).toBe(USER_1_ID);
    expect(res.body.status).toBe('ACTIVE');
    expect(res.body.lastCheckedAt).toBeNull();
    expect(res.body.lastNotifiedPrice).toBeNull();
    // Prisma returns Decimal as string usually, check numeric equivalent
    expect(Number(res.body.targetPrice)).toBe(1000);
    
    user1AlertId = res.body.id;
  });

  it('creates an alert for User 2', async () => {
    const res = await request(app)
      .post('/api/alerts')
      .set('Authorization', `Bearer ${token2}`)
      .send({
        canonicalProduct: MOCK_PRODUCT,
        targetPrice: 2000,
        priceContext: 'TRUSTED_ONLY'
      });
    
    expect(res.status).toBe(201);
    expect(res.body.userId).toBe(USER_2_ID);
    user2AlertId = res.body.id;
  });

  it('lists alerts only for the authenticated user', async () => {
    const res1 = await request(app)
      .get('/api/alerts')
      .set('Authorization', `Bearer ${token1}`);
    
    expect(res1.status).toBe(200);
    expect(Array.isArray(res1.body)).toBe(true);
    expect(res1.body.length).toBe(1);
    expect(res1.body[0].id).toBe(user1AlertId);

    const res2 = await request(app)
      .get('/api/alerts')
      .set('Authorization', `Bearer ${token2}`);
    expect(res2.body.length).toBe(1);
    expect(res2.body[0].id).toBe(user2AlertId);
  });

  it('gets own alert', async () => {
    const res = await request(app)
      .get(`/api/alerts/${user1AlertId}`)
      .set('Authorization', `Bearer ${token1}`);
    
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(user1AlertId);
  });

  it('cannot get another users alert', async () => {
    const res = await request(app)
      .get(`/api/alerts/${user2AlertId}`) // User 1 trying to get User 2's alert
      .set('Authorization', `Bearer ${token1}`);
    
    expect(res.status).toBe(404);
  });

  it('updates own alert', async () => {
    const res = await request(app)
      .patch(`/api/alerts/${user1AlertId}`)
      .set('Authorization', `Bearer ${token1}`)
      .send({
        targetPrice: 900,
        status: 'PAUSED'
      });
    
    expect(res.status).toBe(200);
    expect(Number(res.body.targetPrice)).toBe(900);
    expect(res.body.status).toBe('PAUSED');
  });

  it('rejects updates containing server-controlled or unknown fields', async () => {
    const res = await request(app)
      .patch(`/api/alerts/${user1AlertId}`)
      .set('Authorization', `Bearer ${token1}`)
      .send({
        userId: USER_2_ID,
        lastNotifiedPrice: 999
      });
    
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unknown or forbidden fields/);
  });

  it('rejects creates containing server-controlled or unknown fields', async () => {
    const res = await request(app)
      .post('/api/alerts')
      .set('Authorization', `Bearer ${token1}`)
      .send({
        canonicalProduct: MOCK_PRODUCT,
        targetPrice: 1000,
        priceContext: 'FULL_INTERNET',
        userId: USER_2_ID
      });
    
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unknown or forbidden fields/);
  });

  it('cannot update another users alert', async () => {
    const res = await request(app)
      .patch(`/api/alerts/${user2AlertId}`)
      .set('Authorization', `Bearer ${token1}`)
      .send({
        targetPrice: 500
      });
    
    expect(res.status).toBe(404);
  });

  it('rejects invalid status on update', async () => {
    const res = await request(app)
      .patch(`/api/alerts/${user1AlertId}`)
      .set('Authorization', `Bearer ${token1}`)
      .send({
        status: 'INVALID_STATUS'
      });
    
    expect(res.status).toBe(400);
  });

  it('cannot delete another users alert', async () => {
    const res = await request(app)
      .delete(`/api/alerts/${user2AlertId}`)
      .set('Authorization', `Bearer ${token1}`);
    
    expect(res.status).toBe(404);
  });

  it('deletes own alert', async () => {
    const res = await request(app)
      .delete(`/api/alerts/${user1AlertId}`)
      .set('Authorization', `Bearer ${token1}`);
    
    expect(res.status).toBe(204);

    // Verify it is gone
    const getRes = await request(app)
      .get(`/api/alerts/${user1AlertId}`)
      .set('Authorization', `Bearer ${token1}`);
    expect(getRes.status).toBe(404);
  });

  it('persists data (fetching User 2 alert from db directly)', async () => {
    const alert = await prisma.priceAlert.findUnique({
      where: { id: user2AlertId }
    });
    expect(alert).not.toBeNull();
    expect(alert.userId).toBe(USER_2_ID);
  });
});
