// api/stripe-config.js
// Stripe is disabled in favor of Paystack (Primary Gateway with Split).

'use strict';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') return res.status(200).end();

  return res.status(200).json({
    publishableKey: '',
    configured: false,
    disabled: true,
    activeGateway: 'paystack',
    currency: 'zar',
  });
};
