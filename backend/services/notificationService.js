'use strict';

/**
 * Notification Service
 * 
 * Abstraction layer for delivering price drop notifications.
 * Phase 35C does not include real email/push infrastructure.
 */
async function notifyPriceDrop(userId, alertId, product, targetPrice, currentPrice) {
  // Explicit no-op payload as required by Adjustment 1.
  return {
    delivered: false,
    channel: "noop",
    reason: "notification_delivery_not_configured"
  };
}

module.exports = {
  notifyPriceDrop
};
