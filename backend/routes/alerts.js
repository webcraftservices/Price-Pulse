'use strict';

const express = require('express');
const { authenticate } = require('../middleware/auth');
const alertService = require('../services/alertService');

const router = express.Router();

// All alert routes require authentication
router.use(authenticate);

/**
 * POST /api/alerts
 * Create a new price alert
 */
router.post('/', async (req, res, next) => {
  try {
    const { canonicalProduct, targetPrice, priceContext } = req.body;

    const allowedPostKeys = ['canonicalProduct', 'targetPrice', 'priceContext'];
    const invalidPostKeys = Object.keys(req.body).filter(k => !allowedPostKeys.includes(k));
    if (invalidPostKeys.length > 0) {
      return res.status(400).json({ error: `Unknown or forbidden fields: ${invalidPostKeys.join(', ')}` });
    }

    if (!canonicalProduct || typeof canonicalProduct !== 'object') {
      return res.status(400).json({ error: 'Missing or invalid canonicalProduct' });
    }

    if (targetPrice === undefined || targetPrice === null || typeof targetPrice !== 'number' || isNaN(targetPrice) || targetPrice <= 0 || !isFinite(targetPrice)) {
      return res.status(400).json({ error: 'Missing or invalid targetPrice' });
    }

    if (!priceContext || !['FULL_INTERNET', 'TRUSTED_ONLY'].includes(priceContext)) {
      return res.status(400).json({ error: 'Missing or invalid priceContext' });
    }

    const alert = await alertService.createAlert(req.user.id, {
      canonicalProduct,
      targetPrice,
      priceContext
    });

    return res.status(201).json(alert);
  } catch (err) {
    console.error('[alerts] Error creating alert:', err.message);
    return next(err);
  }
});

/**
 * GET /api/alerts
 * List all price alerts for the authenticated user
 */
router.get('/', async (req, res, next) => {
  try {
    const alerts = await alertService.listAlerts(req.user.id);
    return res.status(200).json(alerts);
  } catch (err) {
    console.error('[alerts] Error listing alerts:', err.message);
    return next(err);
  }
});

/**
 * GET /api/alerts/:id
 * Get a specific price alert
 */
router.get('/:id', async (req, res, next) => {
  try {
    const alert = await alertService.getAlert(req.user.id, req.params.id);
    if (!alert) {
      return res.status(404).json({ error: 'Alert not found' });
    }
    return res.status(200).json(alert);
  } catch (err) {
    console.error('[alerts] Error getting alert:', err.message);
    return next(err);
  }
});

/**
 * PATCH /api/alerts/:id
 * Update a specific price alert
 */
router.patch('/:id', async (req, res, next) => {
  try {
    const { canonicalProduct, targetPrice, priceContext, status } = req.body;
    
    const allowedPatchKeys = ['canonicalProduct', 'targetPrice', 'priceContext', 'status'];
    const invalidPatchKeys = Object.keys(req.body).filter(k => !allowedPatchKeys.includes(k));
    if (invalidPatchKeys.length > 0) {
      return res.status(400).json({ error: `Unknown or forbidden fields: ${invalidPatchKeys.join(', ')}` });
    }

    if (Object.keys(req.body).length === 0) {
      return res.status(400).json({ error: 'No fields provided for update' });
    }

    // Validate targetPrice if provided
    if (targetPrice !== undefined) {
      if (targetPrice === null || typeof targetPrice !== 'number' || isNaN(targetPrice) || targetPrice <= 0 || !isFinite(targetPrice)) {
        return res.status(400).json({ error: 'Invalid targetPrice' });
      }
    }

    // Validate priceContext if provided
    if (priceContext !== undefined) {
      if (!['FULL_INTERNET', 'TRUSTED_ONLY'].includes(priceContext)) {
        return res.status(400).json({ error: 'Invalid priceContext' });
      }
    }

    // Validate status if provided
    if (status !== undefined) {
      if (!['ACTIVE', 'PAUSED'].includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
      }
    }

    const updatedAlert = await alertService.updateAlert(req.user.id, req.params.id, {
      canonicalProduct,
      targetPrice,
      priceContext,
      status
    });

    if (!updatedAlert) {
      return res.status(404).json({ error: 'Alert not found' });
    }

    return res.status(200).json(updatedAlert);
  } catch (err) {
    console.error('[alerts] Error updating alert:', err.message);
    return next(err);
  }
});

/**
 * DELETE /api/alerts/:id
 * Delete a specific price alert
 */
router.delete('/:id', async (req, res, next) => {
  try {
    const deleted = await alertService.deleteAlert(req.user.id, req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: 'Alert not found' });
    }
    return res.status(204).send();
  } catch (err) {
    console.error('[alerts] Error deleting alert:', err.message);
    return next(err);
  }
});

module.exports = router;
