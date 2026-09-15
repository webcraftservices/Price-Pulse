'use strict';

const prisma = require('../lib/prismaClient');

/**
 * Create a new Price Alert
 */
async function createAlert(userId, input) {
  const { canonicalProduct, targetPrice, priceContext } = input;

  return prisma.priceAlert.create({
    data: {
      userId,
      canonicalProduct,
      targetPrice,
      priceContext,
      status: 'ACTIVE' // Uses the AlertStatus enum
    }
  });
}

/**
 * List all Price Alerts for a user
 */
async function listAlerts(userId) {
  return prisma.priceAlert.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' }
  });
}

/**
 * Get a specific Price Alert, enforcing ownership
 */
async function getAlert(userId, alertId) {
  return prisma.priceAlert.findFirst({
    where: {
      id: alertId,
      userId
    }
  });
}

/**
 * Update a specific Price Alert, enforcing ownership and protected fields
 */
async function updateAlert(userId, alertId, input) {
  // Only allow updatable fields
  const dataToUpdate = {};
  if (input.canonicalProduct !== undefined) dataToUpdate.canonicalProduct = input.canonicalProduct;
  if (input.targetPrice !== undefined) dataToUpdate.targetPrice = input.targetPrice;
  if (input.priceContext !== undefined) dataToUpdate.priceContext = input.priceContext;
  if (input.status !== undefined) dataToUpdate.status = input.status;

  if (Object.keys(dataToUpdate).length === 0) {
    return getAlert(userId, alertId);
  }

  // Prisma does not have an "updateFirst" (update with arbitrary where).
  // We can use updateMany which supports non-unique filters, 
  // or findFirst then update. Using updateMany ensures atomic ownership check.
  const result = await prisma.priceAlert.updateMany({
    where: {
      id: alertId,
      userId
    },
    data: dataToUpdate
  });

  if (result.count === 0) {
    return null; // Not found or not owned
  }

  // Return the updated record
  return getAlert(userId, alertId);
}

/**
 * Delete a specific Price Alert, enforcing ownership
 */
async function deleteAlert(userId, alertId) {
  const result = await prisma.priceAlert.deleteMany({
    where: {
      id: alertId,
      userId
    }
  });

  return result.count > 0;
}

module.exports = {
  createAlert,
  listAlerts,
  getAlert,
  updateAlert,
  deleteAlert
};
