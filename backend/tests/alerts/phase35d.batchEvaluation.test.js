'use strict';

const prisma = require('../../../backend/lib/prismaClient');
const alertEvaluator = require('../../../backend/services/alertEvaluator');
const { evaluateAllActiveAlerts } = require('../../../backend/services/batchAlertEvaluator');

jest.mock('../../../backend/lib/prismaClient', () => ({
  priceAlert: {
    findMany: jest.fn()
  }
}));

jest.mock('../../../backend/services/alertEvaluator', () => ({
  evaluateAlert: jest.fn()
}));

describe('Phase 35D - Batch Alert Evaluation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('1. & 10. No ACTIVE alerts: zero attempted, zero errors, deterministic empty result', async () => {
    prisma.priceAlert.findMany.mockResolvedValue([]);

    const result = await evaluateAllActiveAlerts();

    expect(prisma.priceAlert.findMany).toHaveBeenCalledWith({
      where: { status: 'ACTIVE' },
      select: { id: true }
    });

    expect(alertEvaluator.evaluateAlert).not.toHaveBeenCalled();
    
    expect(result.attempted).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.results).toEqual([]);
    expect(result.statuses.TRIGGERED).toBe(0);
  });

  it('2., 4. & 8. ACTIVE alerts are fetched and multiple are all evaluated exactly once', async () => {
    prisma.priceAlert.findMany.mockResolvedValue([
      { id: 'alert-1' },
      { id: 'alert-2' }
    ]);
    alertEvaluator.evaluateAlert.mockResolvedValue({ status: 'NO_PRICE' });

    const result = await evaluateAllActiveAlerts();

    expect(alertEvaluator.evaluateAlert).toHaveBeenCalledTimes(2);
    expect(alertEvaluator.evaluateAlert).toHaveBeenCalledWith('alert-1');
    expect(alertEvaluator.evaluateAlert).toHaveBeenCalledWith('alert-2');

    expect(result.attempted).toBe(2);
    expect(result.errors).toBe(0);
  });

  it('3. & 9. PAUSED alerts are excluded by the database query and not evaluated', async () => {
    prisma.priceAlert.findMany.mockResolvedValue([
      { id: 'alert-active' }
    ]);
    alertEvaluator.evaluateAlert.mockResolvedValue({ status: 'NO_PRICE' });

    const result = await evaluateAllActiveAlerts();

    expect(prisma.priceAlert.findMany).toHaveBeenCalledWith({
      where: { status: 'ACTIVE' },
      select: { id: true }
    });
    // This implicit check proves we asked the DB to filter out non-ACTIVE alerts, 
    // and since evaluateAlert is only called on the results, PAUSED alerts are excluded.
    expect(result.attempted).toBe(1);
    expect(alertEvaluator.evaluateAlert).toHaveBeenCalledWith('alert-active');
  });

  it('5. & 7. Mixed evaluator results are aggregated correctly and match alert IDs', async () => {
    prisma.priceAlert.findMany.mockResolvedValue([
      { id: 'a1' },
      { id: 'a2' },
      { id: 'a3' },
      { id: 'a4' },
      { id: 'a5' }
    ]);

    alertEvaluator.evaluateAlert.mockImplementation(async (id) => {
      switch (id) {
        case 'a1': return { status: 'TRIGGERED' };
        case 'a2': return { status: 'ABOVE_TARGET' };
        case 'a3': return { status: 'NO_PRICE' };
        case 'a4': return { status: 'ALREADY_NOTIFIED' };
        case 'a5': return { status: 'CONCURRENT_MODIFICATION' };
      }
    });

    const result = await evaluateAllActiveAlerts();

    expect(result.attempted).toBe(5);
    expect(result.errors).toBe(0);
    
    expect(result.statuses.TRIGGERED).toBe(1);
    expect(result.statuses.ABOVE_TARGET).toBe(1);
    expect(result.statuses.NO_PRICE).toBe(1);
    expect(result.statuses.ALREADY_NOTIFIED).toBe(1);
    expect(result.statuses.CONCURRENT_MODIFICATION).toBe(1);

    expect(result.results).toEqual([
      { alertId: 'a1', status: 'TRIGGERED', error: null },
      { alertId: 'a2', status: 'ABOVE_TARGET', error: null },
      { alertId: 'a3', status: 'NO_PRICE', error: null },
      { alertId: 'a4', status: 'ALREADY_NOTIFIED', error: null },
      { alertId: 'a5', status: 'CONCURRENT_MODIFICATION', error: null }
    ]);
  });

  it('6. Error isolation: one alert throws, next still executes, errors count is correct', async () => {
    prisma.priceAlert.findMany.mockResolvedValue([
      { id: 'alert-throws' },
      { id: 'alert-succeeds' }
    ]);

    alertEvaluator.evaluateAlert.mockImplementation(async (id) => {
      if (id === 'alert-throws') {
        throw new Error('Unexpected DB timeout');
      }
      return { status: 'ABOVE_TARGET' };
    });

    const result = await evaluateAllActiveAlerts();

    // Ensures BOTH were evaluated despite the error
    expect(alertEvaluator.evaluateAlert).toHaveBeenCalledTimes(2);
    
    expect(result.attempted).toBe(2);
    expect(result.errors).toBe(1);
    expect(result.statuses.ABOVE_TARGET).toBe(1);

    expect(result.results[0].alertId).toBe('alert-throws');
    expect(result.results[0].status).toBe('ERROR');
    expect(result.results[0].error).toBe('Unexpected DB timeout');

    expect(result.results[1].alertId).toBe('alert-succeeds');
    expect(result.results[1].status).toBe('ABOVE_TARGET');
    expect(result.results[1].error).toBeNull();
  });
});
