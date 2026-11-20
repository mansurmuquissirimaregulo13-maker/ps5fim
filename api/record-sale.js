// api/record-sale.js
// Records approved orders from CreaPay / Paystack inline sheet and updates lead status to PAID.

'use strict';

const fs = require('fs');
const path = require('path');
const { loadSettings } = require('./settings');

const DATA_DIR = path.join(process.cwd(), 'data');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  }
  body = body || {};

  const orderId = body.order_id || body.orderId || body.reference;
  if (!orderId) {
    return res.status(400).json({ error: 'order_id or reference is required' });
  }

  try {
    ensureDataDir();

    // 1. Read or initialize order record
    const orderFile = path.join(DATA_DIR, `order_${orderId}.json`);
    let existing = {};
    if (fs.existsSync(orderFile)) {
      try { existing = JSON.parse(fs.readFileSync(orderFile, 'utf8')); } catch (_) {}
    }

    const customer = body.customer || {};
    const shipping = body.shipping || {};
    const amountZar = Number(body.amount) || Number(body.amount_minor ? body.amount_minor / 100 : 0) || Number(existing.amount_zar) || 0;

    const orderRecord = {
      ...existing,
      order_id: orderId,
      reference: body.reference || existing.reference || '',
      status: 'approved',
      payment_status: 'PAID',
      gateway: body.gateway || existing.gateway || 'creapay',
      amount_zar: amountZar,
      customer_name: customer.name || body.name || existing.customer_name || 'Customer',
      customer_email: customer.email || body.email || existing.customer_email || '',
      customer_phone: customer.phone || body.phone || existing.customer_phone || '',
      shipping_address: customer.address || shipping.address || existing.shipping_address || '',
      bank: body.bank || existing.bank || 'Capitec / South Africa Card',
      items: body.items || existing.items || [],
      trackingParameters: body.trackingParameters || body.tracking || existing.trackingParameters || existing.tracking || {},
      approved_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    fs.writeFileSync(orderFile, JSON.stringify(orderRecord, null, 2), 'utf8');

    // Also persist reference mapping
    if (orderRecord.reference) {
      try {
        fs.writeFileSync(path.join(DATA_DIR, `ref_${orderRecord.reference}.json`), JSON.stringify({ orderId: orderId, reference: orderRecord.reference }, null, 2), 'utf8');
      } catch (_) {}
    }

    // Send conversion to UTMify in real-time (Strictly Deduplicated)
    if (!orderRecord.utmify_sent) {
      try {
        const { sendOrderToUtmify } = require('../scripts/utmify-api');
        sendOrderToUtmify(orderRecord).catch(e => console.warn('[record-sale] UTMify dispatch notice:', e.message));
      } catch (_) {}
    }

    // Send Confirmation Email if customer email is present
    try {
      const { sendOrderConfirmationEmail } = require('./confirm-order');
      if (typeof sendOrderConfirmationEmail === 'function' && orderRecord.customer_email) {
        sendOrderConfirmationEmail(orderRecord).catch(err => console.warn('[record-sale] Email dispatch notice:', err.message));
      }
    } catch (_) {}

    // Trigger Pushcut Notification
    try {
      const pushcutUrl = 'https://api.pushcut.io/QsggCCih4K4SGeZy3F37z/notifications/MinhaNotifica%C3%A7%C3%A3o';
      fetch(pushcutUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: `🎉 CreaPay Pagamento Aprovado! R ${amountZar.toFixed(2)}`,
          text: `Pedido: #${orderId}\nCliente: ${orderRecord.customer_name}\nStatus: Approved`,
        }),
      }).catch(() => {});
    } catch (_) {}

    // 2. Mark corresponding abandoned lead as PAID
    const cleanPhone = (orderRecord.customer_phone || '').replace(/[^0-9]/g, '');
    const cleanEmail = (orderRecord.customer_email || '').replace(/[^a-zA-Z0-9_\-]/g, '_');
    const possibleLeads = [
      path.join(DATA_DIR, `abandoned_${cleanPhone}.json`),
      path.join(DATA_DIR, `abandoned_${cleanEmail}.json`),
      path.join(DATA_DIR, `abandoned_${orderId}.json`)
    ];

    for (const lp of possibleLeads) {
      if (fs.existsSync(lp)) {
        try {
          const ldata = JSON.parse(fs.readFileSync(lp, 'utf8'));
          ldata.status = 'PAID';
          ldata.paid_at = new Date().toISOString();
          fs.writeFileSync(lp, JSON.stringify(ldata, null, 2), 'utf8');
        } catch (_) {}
      }
    }

    console.log(`[record-sale] Successfully recorded sale: ${orderId} | status: approved | amount: R ${amountZar}`);
    return res.status(200).json({
      success: true,
      order_id: orderId,
      status: 'approved',
      gateway: orderRecord.gateway
    });
  } catch (err) {
    console.error('[record-sale] Error recording sale:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
