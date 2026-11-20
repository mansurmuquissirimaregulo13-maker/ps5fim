// api/paystack-verify.js
// Verifies a Paystack transaction reference and finalizes the order.

'use strict';

const fs = require('fs');
const path = require('path');
const { loadSettings } = require('./settings');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const reference = (req.query.reference || (req.body && req.body.reference) || '').trim();
  if (!reference) {
    return res.status(400).json({ error: 'Missing Paystack transaction reference' });
  }

  const settings = loadSettings();
  const paystackSecret = (settings.paystack && settings.paystack.secretKey) || process.env.PAYSTACK_SECRET_KEY || '';

  if (!paystackSecret) {
    return res.status(400).json({ error: 'Paystack Secret Key is not configured' });
  }

  try {
    const verifyRes = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${paystackSecret.trim()}` }
    });
    const data = await verifyRes.json();

    if (!data.status || !data.data) {
      return res.status(400).json({ error: data.message || 'Verification failed' });
    }

    const tx = data.data;
    if (tx.status !== 'success') {
      return res.status(400).json({
        error: `Transaction status is ${tx.status}`,
        status: tx.status
      });
    }

    const meta = tx.metadata || {};
    const orderId = meta.orderId || ('TK' + Date.now().toString(36).toUpperCase());
    const DATA_DIR = path.join(process.cwd(), 'data');
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

    // Mark matching abandoned lead as RECOVERED
    const cleanPhone = (meta.customer_phone || '').replace(/[^0-9]/g, '');
    const cleanEmail = (tx.customer && tx.customer.email ? tx.customer.email : '').replace(/[^a-zA-Z0-9_\-]/g, '_');
    const leadCandidates = [cleanPhone, cleanEmail, orderId].filter(Boolean);

    for (const cid of leadCandidates) {
      const p = path.join(DATA_DIR, `abandoned_${cid}.json`);
      if (fs.existsSync(p)) {
        try {
          const l = JSON.parse(fs.readFileSync(p, 'utf8'));
          l.status = 'RECOVERED';
          l.recovered_at = new Date().toISOString();
          l.recovered_gateway = 'paystack';
          l.recovered_ref = reference;
          fs.writeFileSync(p, JSON.stringify(l, null, 2), 'utf8');
        } catch (_) {}
      }
    }

    const activeSplit = (tx.split && tx.split.split_code) || meta.split_code || (settings.paystack && settings.paystack.splitCode) || 'SPL_8ZpdS87KaP';

    // Save finalized order
    const orderFile = path.join(DATA_DIR, `order_${orderId}.json`);
    const orderRecord = {
      order_id: orderId,
      gateway: 'paystack',
      paystack_reference: reference,
      split_code: activeSplit,
      amount: tx.amount / 100,
      currency: 'ZAR',
      status: 'CONFIRMED',
      payment_status: 'PAID',
      customer_name: meta.customer_name || 'Customer',
      customer_email: (tx.customer && tx.customer.email) || '',
      customer_phone: meta.customer_phone || '',
      shipping_address: meta.shipping_address || '',
      variant: meta.variant || 'Titan Pro',
      quantity: meta.quantity || 1,
      items: meta.items || [],
      customer_ip: (req.headers['x-forwarded-for'] && req.headers['x-forwarded-for'].split(',')[0].trim()) || req.headers['x-real-ip'] || '102.132.22.15',
      trackingParameters: meta.trackingParameters || {},
      created_at: new Date(tx.paid_at || Date.now()).toISOString(),
      updated_at: new Date().toISOString()
    };
    fs.writeFileSync(orderFile, JSON.stringify(orderRecord, null, 2), 'utf8');

    // Report sale to UTMify Server-Side API
    try {
      const { sendOrderToUtmify } = require('../scripts/utmify-api');
      sendOrderToUtmify(orderRecord).catch(() => {});
    } catch (_) {}

    return res.status(200).json({
      success: true,
      orderId: orderId,
      amount: tx.amount / 100,
      status: 'success',
      order: orderRecord
    });
  } catch (err) {
    console.error('[paystack-verify] Error:', err);
    return res.status(500).json({ error: 'Verification network error: ' + err.message });
  }
};
