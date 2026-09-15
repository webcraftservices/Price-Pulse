'use strict';

const prisma = require('../lib/prismaClient');
const compareService = require('./compareService');
const notificationService = require('./notificationService');

/**
 * Evaluates a single PriceAlert against the current market data.
 */
async function evaluateAlert(alertId) {
  const alert = await prisma.priceAlert.findUnique({
    where: { id: alertId }
  });

  if (!alert) {
    return { status: 'NOT_FOUND' };
  }

  if (alert.status === 'PAUSED') {
    return { status: 'PAUSED' };
  }

  const compareResult = await compareService.compareByProduct(alert.canonicalProduct);

  let currentPrice = null;
  if (alert.priceContext === 'FULL_INTERNET') {
    currentPrice = compareResult.bestOffer ? compareResult.bestOffer.price : null;
  } else if (alert.priceContext === 'TRUSTED_ONLY') {
    currentPrice = compareResult.bestTrustedOffer ? compareResult.bestTrustedOffer.price : null;
  }

  // Adjustment 2: Type-safe missing/invalid price check
  if (currentPrice === null || currentPrice === undefined || !Number.isFinite(currentPrice)) {
    await prisma.priceAlert.update({
      where: { id: alertId },
      data: { lastCheckedAt: new Date() }
    });
    return { status: 'NO_PRICE' };
  }

  const targetPriceNum = Number(alert.targetPrice);

  if (currentPrice > targetPriceNum) {
    await prisma.priceAlert.update({
      where: { id: alertId },
      data: { lastCheckedAt: new Date() }
    });
    return { status: 'ABOVE_TARGET' };
  }

  // Adjustment 2: Type-safe duplicate check
  // Avoid logic like Number(null) === 0
  const isDuplicate = alert.lastNotifiedPrice !== null && 
                      Number(alert.lastNotifiedPrice) === currentPrice;

  if (isDuplicate) {
    await prisma.priceAlert.update({
      where: { id: alertId },
      data: { lastCheckedAt: new Date() }
    });
    return { status: 'ALREADY_NOTIFIED' };
  }

  // Adjustment 3: Concurrency / duplicate-trigger protection
  // Atomic update using optimistic concurrency control. 
  // We only update if lastNotifiedPrice hasn't changed since we read it.
  const updated = await prisma.priceAlert.updateMany({
    where: {
      id: alertId,
      lastNotifiedPrice: alert.lastNotifiedPrice
    },
    data: {
      lastCheckedAt: new Date(),
      lastNotifiedPrice: currentPrice
    }
  });

  if (updated.count === 0) {
    // Another worker triggered the alert already or modified the state concurrently.
    return { status: 'CONCURRENT_MODIFICATION' };
  }

  // Adjustment 1: The notificationService returns an explicit no-op delivery status.
  const notificationResult = await notificationService.notifyPriceDrop(
    alert.userId,
    alert.id,
    alert.canonicalProduct,
    alert.targetPrice,
    currentPrice
  );

  return { status: 'TRIGGERED', notificationResult };
}

module.exports = {
  evaluateAlert
};
