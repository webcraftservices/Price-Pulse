'use strict';

const request = require('supertest');
const express = require('express');
const alertsRoute = require('../../routes/alerts');
const batchAlertEvaluator = require('../../services/batchAlertEvaluator');

jest.mock('../../services/batchAlertEvaluator', () => ({
  evaluateAllActiveAlerts: jest.fn()
}));

// We only need the alerts route and basic middleware to test the trigger
const app = express();
app.use(express.json());
app.use('/api/alerts', alertsRoute);

describe('Phase 35F - Batch Evaluation Trigger', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('1. returns 401 Unauthorized and does not call evaluator when Authorization header is missing', async () => {
    process.env.CRON_SECRET = 'valid-secret-123';

    const response = await request(app).post('/api/alerts/internal/evaluate-batch');
    
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'Unauthorized' });
    expect(batchAlertEvaluator.evaluateAllActiveAlerts).not.toHaveBeenCalled();
  });

  it('2. returns 401 Unauthorized and does not call evaluator when secret is wrong', async () => {
    process.env.CRON_SECRET = 'valid-secret-123';

    const response = await request(app)
      .post('/api/alerts/internal/evaluate-batch')
      .set('Authorization', 'Bearer wrong-secret');
    
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'Unauthorized' });
    expect(batchAlertEvaluator.evaluateAllActiveAlerts).not.toHaveBeenCalled();
  });

  it('3. returns 503 Service Unavailable and fails closed when CRON_SECRET is missing from env', async () => {
    delete process.env.CRON_SECRET;

    const response = await request(app)
      .post('/api/alerts/internal/evaluate-batch')
      .set('Authorization', 'Bearer anything');
    
    expect(response.status).toBe(503);
    // Explicitly verify secret is not exposed in error
    expect(response.body).toEqual({ error: 'Service Unavailable: Missing configuration' });
    expect(batchAlertEvaluator.evaluateAllActiveAlerts).not.toHaveBeenCalled();
  });

  it('4. returns 200 OK and aggregate result when correct secret is provided in Bearer format', async () => {
    process.env.CRON_SECRET = 'valid-secret-123';
    
    const mockResult = {
      attempted: 2,
      errors: 0,
      statuses: { TRIGGERED: 1, ABOVE_TARGET: 1 },
      results: []
    };
    batchAlertEvaluator.evaluateAllActiveAlerts.mockResolvedValue(mockResult);

    const response = await request(app)
      .post('/api/alerts/internal/evaluate-batch')
      .set('Authorization', 'Bearer valid-secret-123');
    
    expect(response.status).toBe(200);
    expect(response.body).toEqual(mockResult);
    expect(batchAlertEvaluator.evaluateAllActiveAlerts).toHaveBeenCalledTimes(1);
  });

  it('5. returns 500 Internal Server Error when evaluator throws unexpectedly', async () => {
    process.env.CRON_SECRET = 'valid-secret-123';
    
    batchAlertEvaluator.evaluateAllActiveAlerts.mockRejectedValue(new Error('Unexpected DB failure'));

    const response = await request(app)
      .post('/api/alerts/internal/evaluate-batch')
      .set('Authorization', 'Bearer valid-secret-123');
    
    expect(response.status).toBe(500);
    // Verifying that exact error string (which might contain sensitive data like DB paths) isn't leaked
    expect(response.body).toEqual({ error: 'Internal Server Error' });
    expect(batchAlertEvaluator.evaluateAllActiveAlerts).toHaveBeenCalledTimes(1);
  });

  it('6. rejects query parameters and body payloads for authentication', async () => {
    process.env.CRON_SECRET = 'valid-secret-123';

    // Query param
    const responseQuery = await request(app)
      .post('/api/alerts/internal/evaluate-batch?secret=valid-secret-123');
    expect(responseQuery.status).toBe(401);

    // Body payload
    const responseBody = await request(app)
      .post('/api/alerts/internal/evaluate-batch')
      .send({ secret: 'valid-secret-123' });
    expect(responseBody.status).toBe(401);

    expect(batchAlertEvaluator.evaluateAllActiveAlerts).not.toHaveBeenCalled();
  });
});
