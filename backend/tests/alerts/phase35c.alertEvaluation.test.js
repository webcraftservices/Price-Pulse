'use strict';

/**
 * Phase 35C — Alert Evaluation Tests
 * 
 * Tests the evaluation and notification logic directly via the service layer.
 */

const prisma = require('../../lib/prismaClient');
const compareService = require('../../services/compareService');
const { evaluateAlert } = require('../../services/alertEvaluator');
const { notifyPriceDrop } = require('../../services/notificationService');

jest.mock('../../services/compareService', () => ({
  compareByProduct: jest.fn()
}));

const USER_1_ID = '00000000-0000-0000-0000-000000000010';
const USER_2_ID = '00000000-0000-0000-0000-000000000020';
const MOCK_PRODUCT = { brand: 'TestBrand', model: 'TestModel' };

describe('Phase 35C - Alert Evaluation', () => {
  beforeAll(async () => {
    await prisma.user.upsert({
      where: { id: USER_1_ID },
      update: {},
      create: { id: USER_1_ID, email: 'evaluser1@test.com' }
    });
    await prisma.user.upsert({
      where: { id: USER_2_ID },
      update: {},
      create: { id: USER_2_ID, email: 'evaluser2@test.com' }
    });
  });

  afterAll(async () => {
    await prisma.priceAlert.deleteMany({
      where: { userId: { in: [USER_1_ID, USER_2_ID] } }
    });
  });

  beforeEach(async () => {
    await prisma.priceAlert.deleteMany({
      where: { userId: { in: [USER_1_ID, USER_2_ID] } }
    });
    jest.clearAllMocks();
  });

  async function createTestAlert(overrides = {}) {
    return prisma.priceAlert.create({
      data: {
        userId: USER_1_ID,
        canonicalProduct: MOCK_PRODUCT,
        targetPrice: 1000,
        priceContext: 'FULL_INTERNET',
        status: 'ACTIVE',
        ...overrides
      }
    });
  }

  describe('1. No-op Notification Result', () => {
    it('returns explicit delivery status from abstraction', async () => {
      const alert = await createTestAlert({ targetPrice: 1000 });
      compareService.compareByProduct.mockResolvedValue({
        bestOffer: { price: 900 }
      });

      const res = await evaluateAlert(alert.id);
      expect(res.status).toBe('TRIGGERED');
      expect(res.notificationResult).toEqual({
        delivered: false,
        channel: "noop",
        reason: "notification_delivery_not_configured"
      });
    });
  });

  describe('2. lastNotifiedPrice === null handled safely', () => {
    it('does not incorrectly compare null as zero', async () => {
      const alert = await createTestAlert({ targetPrice: 1000, lastNotifiedPrice: null });
      // If null was treated as 0, currentPrice = 0 would be considered a duplicate.
      // But it shouldn't be. Wait, if currentPrice is 0, it should trigger if target >= 0.
      compareService.compareByProduct.mockResolvedValue({
        bestOffer: { price: 0 }
      });

      const res = await evaluateAlert(alert.id);
      expect(res.status).toBe('TRIGGERED');
    });
  });

  describe('3. Invalid/non-finite current price', () => {
    it('returns NO_PRICE for missing price', async () => {
      const alert = await createTestAlert();
      compareService.compareByProduct.mockResolvedValue({});
      const res = await evaluateAlert(alert.id);
      expect(res.status).toBe('NO_PRICE');
    });

    it('returns NO_PRICE for non-finite price', async () => {
      const alert = await createTestAlert();
      compareService.compareByProduct.mockResolvedValue({
        bestOffer: { price: NaN }
      });
      const res = await evaluateAlert(alert.id);
      expect(res.status).toBe('NO_PRICE');
    });
  });

  describe('4. & 5. Duplicate Prevention', () => {
    it('returns ALREADY_NOTIFIED for same valid lastNotifiedPrice', async () => {
      const alert = await createTestAlert({ targetPrice: 1000, lastNotifiedPrice: 900 });
      compareService.compareByProduct.mockResolvedValue({
        bestOffer: { price: 900 }
      });

      const res = await evaluateAlert(alert.id);
      expect(res.status).toBe('ALREADY_NOTIFIED');
      
      const dbAlert = await prisma.priceAlert.findUnique({ where: { id: alert.id } });
      expect(dbAlert.lastCheckedAt).not.toBeNull();
    });

    it('can trigger again for different valid lastNotifiedPrice', async () => {
      const alert = await createTestAlert({ targetPrice: 1000, lastNotifiedPrice: 950 });
      compareService.compareByProduct.mockResolvedValue({
        bestOffer: { price: 900 } // dropped further
      });

      const res = await evaluateAlert(alert.id);
      expect(res.status).toBe('TRIGGERED');
      
      const dbAlert = await prisma.priceAlert.findUnique({ where: { id: alert.id } });
      expect(Number(dbAlert.lastNotifiedPrice)).toBe(900);
    });
  });

  describe('6. & 9. Context Selection (FULL_INTERNET vs TRUSTED_ONLY)', () => {
    it('uses deliberately different prices and strictly selects the right one', async () => {
      // Mock engine returns both
      compareService.compareByProduct.mockResolvedValue({
        bestOffer: { price: 900 },
        bestTrustedOffer: { price: 1100 }
      });

      // FULL_INTERNET test
      const alertFull = await createTestAlert({ targetPrice: 1000, priceContext: 'FULL_INTERNET' });
      const resFull = await evaluateAlert(alertFull.id);
      // current is 900, which is <= 1000 -> TRIGGERED
      expect(resFull.status).toBe('TRIGGERED');

      // TRUSTED_ONLY test
      const alertTrusted = await createTestAlert({ targetPrice: 1000, priceContext: 'TRUSTED_ONLY' });
      const resTrusted = await evaluateAlert(alertTrusted.id);
      // current is 1100, which is > 1000 -> ABOVE_TARGET
      expect(resTrusted.status).toBe('ABOVE_TARGET');
    });
  });

  describe('7. & 8. Missing specific context prices', () => {
    it('missing bestTrustedOffer under TRUSTED_ONLY returns NO_PRICE (no fallback)', async () => {
      const alert = await createTestAlert({ targetPrice: 1000, priceContext: 'TRUSTED_ONLY' });
      compareService.compareByProduct.mockResolvedValue({
        bestOffer: { price: 900 },
        // bestTrustedOffer is missing
      });

      const res = await evaluateAlert(alert.id);
      expect(res.status).toBe('NO_PRICE');
    });

    it('missing bestOffer under FULL_INTERNET returns NO_PRICE', async () => {
      const alert = await createTestAlert({ targetPrice: 1000, priceContext: 'FULL_INTERNET' });
      compareService.compareByProduct.mockResolvedValue({
        bestTrustedOffer: { price: 900 }
      });

      const res = await evaluateAlert(alert.id);
      expect(res.status).toBe('NO_PRICE');
    });
  });

  describe('10. Concurrent evaluation behavior', () => {
    it('prevents duplicate notification via atomic optimistic lock', async () => {
      const alert = await createTestAlert({ targetPrice: 1000, lastNotifiedPrice: null });
      compareService.compareByProduct.mockResolvedValue({
        bestOffer: { price: 900 }
      });

      // Simulate a concurrent update that changes lastNotifiedPrice right before this evaluateAlert finishes its read
      // We will mock prisma.priceAlert.findUnique to return the alert, 
      // but manually update it before the evaluateAlert reaches the updateMany phase.
      // Since evaluateAlert is async, we can do it by intercepting or running them truly concurrently?
      
      // Better way: run two evaluateAlerts simultaneously.
      // We need compareByProduct to be slightly slow to let them overlap.
      compareService.compareByProduct.mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
        return { bestOffer: { price: 900 } };
      });

      const [res1, res2] = await Promise.all([
        evaluateAlert(alert.id),
        evaluateAlert(alert.id)
      ]);

      // One should succeed, one should fail the optimistic lock
      const statuses = [res1.status, res2.status].sort();
      expect(statuses).toEqual(['CONCURRENT_MODIFICATION', 'TRIGGERED']);

      const dbAlert = await prisma.priceAlert.findUnique({ where: { id: alert.id } });
      expect(Number(dbAlert.lastNotifiedPrice)).toBe(900);
    });
  });

  describe('11. Existing Phase 35C constraints', () => {
    it('ACTIVE alert below target -> trigger', async () => {
      const alert = await createTestAlert({ targetPrice: 1000 });
      compareService.compareByProduct.mockResolvedValue({ bestOffer: { price: 999 } });
      const res = await evaluateAlert(alert.id);
      expect(res.status).toBe('TRIGGERED');
    });

    it('ACTIVE alert exact target -> trigger', async () => {
      const alert = await createTestAlert({ targetPrice: 1000 });
      compareService.compareByProduct.mockResolvedValue({ bestOffer: { price: 1000 } });
      const res = await evaluateAlert(alert.id);
      expect(res.status).toBe('TRIGGERED');
    });

    it('ACTIVE alert above target -> no trigger', async () => {
      const alert = await createTestAlert({ targetPrice: 1000 });
      compareService.compareByProduct.mockResolvedValue({ bestOffer: { price: 1001 } });
      const res = await evaluateAlert(alert.id);
      expect(res.status).toBe('ABOVE_TARGET');
      
      const dbAlert = await prisma.priceAlert.findUnique({ where: { id: alert.id } });
      expect(dbAlert.lastNotifiedPrice).toBeNull();
    });

    it('PAUSED alert -> no evaluation', async () => {
      const alert = await createTestAlert({ targetPrice: 1000, status: 'PAUSED' });
      const res = await evaluateAlert(alert.id);
      expect(res.status).toBe('PAUSED');
      expect(compareService.compareByProduct).not.toHaveBeenCalled();
    });

    it('updates lastCheckedAt always (when unpaused)', async () => {
      const alert = await createTestAlert({ targetPrice: 1000 });
      compareService.compareByProduct.mockResolvedValue({ bestOffer: { price: 1001 } }); // ABOVE_TARGET
      
      await evaluateAlert(alert.id);
      const dbAlert = await prisma.priceAlert.findUnique({ where: { id: alert.id } });
      expect(dbAlert.lastCheckedAt).not.toBeNull();
      expect(dbAlert.lastNotifiedPrice).toBeNull(); // remains untouched
    });

    it('isolation: one users alert cannot affect another', async () => {
      const alert1 = await createTestAlert({ targetPrice: 1000, userId: USER_1_ID });
      const alert2 = await createTestAlert({ targetPrice: 1000, userId: USER_2_ID });

      compareService.compareByProduct.mockResolvedValue({ bestOffer: { price: 900 } });
      
      await evaluateAlert(alert1.id);

      const dbAlert1 = await prisma.priceAlert.findUnique({ where: { id: alert1.id } });
      const dbAlert2 = await prisma.priceAlert.findUnique({ where: { id: alert2.id } });

      expect(dbAlert1.lastCheckedAt).not.toBeNull();
      expect(Number(dbAlert1.lastNotifiedPrice)).toBe(900);

      expect(dbAlert2.lastCheckedAt).toBeNull();
      expect(dbAlert2.lastNotifiedPrice).toBeNull();
    });
  });
});
