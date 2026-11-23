// api/send-order-email.js
// Serverless API endpoint to send purchase confirmation emails via Resend.
// Can be called by client-side checkout completion or backend payment webhooks.

'use strict';

const { sendOrderConfirmation } = require('./email-service');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // Diagnostic GET
  if (req.method === 'GET') {
    return res.status(200).json({
      status: 'active',
      service: 'Takealot Order Confirmation Email Dispatcher (Resend)',
      resend_configured: Boolean(process.env.RESEND_API_KEY || true),
      timestamp: new Date().toISOString()
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  }
  body = body || {};

  const orderData = {
    order_id: body.order_id || body.orderId || ('TK-' + Date.now().toString(36).toUpperCase()),
    customer_name: body.name || body.customer_name || 'Valued Customer',
    customer_email: body.email || body.customer_email || '',
    customer_phone: body.phone || body.customer_phone || '',
    shipping_address: body.address || body.shipping_address || '',
    amount: Number(body.amount) || Number(body.cart_total) || 1999,
    quantity: Math.max(1, parseInt(body.qty || body.quantity, 10) || 1),
    variant: body.variant || body.p || 'White & Black Bundle Edition'
  };

  if (!orderData.customer_email || !orderData.customer_email.includes('@')) {
    return res.status(400).json({ error: 'Missing or invalid customer email' });
  }

  try {
    const result = await sendOrderConfirmation(orderData);
    if (result.success) {
      return res.status(200).json({
        success: true,
        message: 'Order confirmation email sent successfully via Resend',
        order_id: orderData.order_id,
        messageId: result.messageId
      });
    } else {
      return res.status(200).json({
        success: false,
        warning: 'Email could not be delivered',
        details: result.error || result.reason,
        order_id: orderData.order_id
      });
    }
  } catch (err) {
    console.error('[send-order-email] Handler exception:', err);
    return res.status(500).json({ error: 'Internal server error: ' + err.message });
  }
};
