// api/create-payment-intent.js
// Stripe is disabled in favor of Paystack (Primary Gateway with Split).

'use strict';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') return res.status(200).end();

  return res.status(400).json({
    error: 'Stripe gateway has been permanently replaced by Paystack. Please proceed with Paystack.',
    activeGateway: 'paystack',
    disabled: true
  });
};
