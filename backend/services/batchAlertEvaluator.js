'use strict';

const prisma = require('../lib/prismaClient');
const alertEvaluator = require('./alertEvaluator');

/**
 * Evaluates all ACTIVE price alerts sequentially.
 * Isolates per-alert errors to ensure batch completion.
 * Returns a deterministic aggregate result object.
 */
async function evaluateAllActiveAlerts() {
  const alerts = await prisma.priceAlert.findMany({
    where: { status: 'ACTIVE' },
    select: { id: true }
  });

  const aggregate = {
    attempted: alerts.length,
    errors: 0,
    statuses: {
      TRIGGERED: 0,
      ABOVE_TARGET: 0,
      NO_PRICE: 0,
      ALREADY_NOTIFIED: 0,
      CONCURRENT_MODIFICATION: 0,
      PAUSED: 0,
      NOT_FOUND: 0
    },
    results: []
  };

  for (const alert of alerts) {
    try {
      const result = await alertEvaluator.evaluateAlert(alert.id);
      
      const status = result.status;
      if (aggregate.statuses[status] !== undefined) {
        aggregate.statuses[status]++;
      } else {
        // Fallback for any dynamically added statuses in the future
        aggregate.statuses[status] = 1;
      }

      aggregate.results.push({
        alertId: alert.id,
        status: status,
        error: null
      });

    } catch (error) {
      aggregate.errors++;
      aggregate.results.push({
        alertId: alert.id,
        status: 'ERROR',
        error: error.message || String(error)
      });
    }
  }

  return aggregate;
}

module.exports = {
  evaluateAllActiveAlerts
};
