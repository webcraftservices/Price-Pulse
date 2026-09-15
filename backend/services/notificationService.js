'use strict';

const prisma = require('../lib/prismaClient');
const { Resend } = require('resend');

/**
 * Escapes unsafe characters for HTML interpolation.
 */
function escapeHtml(unsafe) {
  return String(unsafe)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Notification Service
 * 
 * Abstraction layer for delivering price drop notifications.
 */
async function notifyPriceDrop(userId, alertId, product, targetPrice, currentPrice) {
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM_ADDRESS) {
    return {
      delivered: false,
      channel: "noop",
      reason: "notification_delivery_not_configured"
    };
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true }
    });

    if (!user || !user.email) {
      return {
        delivered: false,
        channel: "email",
        error: "user_email_not_found"
      };
    }

    const resend = new Resend(process.env.RESEND_API_KEY);
    const productName = product.name || product.model || 'Product';
    const escapedProductName = escapeHtml(productName);

    const response = await resend.emails.send({
      from: process.env.EMAIL_FROM_ADDRESS,
      to: user.email,
      subject: `Price Drop Alert: ${productName}`,
      html: `<p>Good news! <strong>${escapedProductName}</strong> has dropped to <strong>₹${currentPrice}</strong>, which meets your target price of ₹${targetPrice}.</p>`
    });

    if (response.error) {
      return {
        delivered: false,
        channel: "email",
        error: response.error.message || String(response.error)
      };
    }

    return {
      delivered: true,
      channel: "email",
      id: response.data ? response.data.id : response.id
    };
  } catch (error) {
    return {
      delivered: false,
      channel: "email",
      error: error.message || String(error)
    };
  }
}

module.exports = {
  notifyPriceDrop
};
