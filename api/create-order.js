// api/create-order.js
// Creates an order with CreaPay / AfricaGrabPoint API (Paystack South Africa processor).
// Returns checkout_token and access_code for the native inline modal sheet.

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

  const settings = loadSettings();
  const creapayConfig = (settings && settings.creapay) || {};
  const creapayKey = creapayConfig.apiKey || process.env.CREAPAY_API_KEY || 'cp_80ef8e4f3af530e285c0f89e80db47707d9b6f802d4f8531107357db7568b2fe';
  const creapayUrl = creapayConfig.apiUrl || 'https://pay.africagrabpoint.com/api/public/v1/orders';

  const customer = body.customer || {};
  const shipping = body.shipping || {};
  const email = (customer.email || body.email || '').trim().toLowerCase();
  const phone = (customer.phone || body.phone || '').trim();
  const name  = (customer.name  || body.name || 'Valued Customer').trim();
  const variant = body.variant || 'Standard';
  const quantity = Math.max(1, parseInt(body.quantity, 10) || 1);

  // Compute total amount in ZAR and minor units (cents)
  let totalZar = 0;
  if (body.amount_minor) {
    totalZar = Number(body.amount_minor) / 100;
  } else if (Array.isArray(body.items) && body.items.length > 0) {
    totalZar = body.items.reduce((s, it) => s + (Number(it.price) || 0) * (Number(it.quantity) || 1), 0);
  } else if (body.cartTotal) {
    totalZar = Number(body.cartTotal);
  } else if (body.amount) {
    totalZar = Number(body.amount);
  }
  if (!totalZar || totalZar <= 0) totalZar = 147;

  const feeAmount = (body.fee !== undefined) ? Math.max(0, Number(body.fee) || 0) : ((settings.fees && settings.fees.enabled) ? Math.max(0, Number(settings.fees.amount) || 0) : 0);
  if (feeAmount > 0) totalZar += feeAmount;

  const amountMinor = Math.round(totalZar * 100);

  // Email format validation
  const isValidEmail = (e) => typeof e === 'string' && /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(e.trim());
  let payEmail = isValidEmail(email) ? email.trim().toLowerCase() : '';
  if (!payEmail) {
    const cleanPrefix = (name || 'client').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10) || 'customer';
    const cleanNum = phone.replace(/[^0-9]/g, '').slice(-6) || Math.floor(100000 + Math.random() * 900000);
    payEmail = `${cleanPrefix}${cleanNum}@gmail.com`;
  }

  const orderId = body.order_id || ('TK' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase());
  const firstItem = (Array.isArray(body.items) && body.items[0]) || {};
  const orderTitle = body.title || body.product_title || firstItem.title || 'Takealot Statutory Order';
  const fullAddress = `${shipping.address || ''}, ${shipping.suburb || ''}, ${shipping.city || ''}, ${shipping.province || ''} ${shipping.postalCode || ''}`.replace(/^[\s,]+|[\s,]+$/g, '');

  // 1. Save pending lead in real-time
  try {
    ensureDataDir();
    const cleanPhone = phone.replace(/[^0-9]/g, '');
    const leadId = cleanPhone || (email ? email.replace(/[^a-zA-Z0-9_\-]/g, '_') : '') || orderId;
    const leadPath = path.join(DATA_DIR, `abandoned_${leadId}.json`);

      const host = req.headers['x-forwarded-host'] || req.headers['host'] || 'ps5fim-s11m.vercel.app';
      const siteUrl = (process.env.SITE_URL || 'https://' + host).replace(/\/+$/, '');
      const leadRecord = {
        id: leadId,
        orderId: orderId,
        customer_name: name,
        customer_email: email,
        customer_phone: phone,
        shipping_address: fullAddress,
        product_title: orderTitle,
        variant: variant,
        quantity: quantity,
        items: body.items || [],
        cart_total: totalZar,
        gateway: 'creapay',
        bank: body.bank || 'Capitec / South Africa Card',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        status: 'ABANDONED',
        recovery_url: `${siteUrl}/order.html?recover=${encodeURIComponent(leadId)}`
      };
    fs.writeFileSync(leadPath, JSON.stringify(leadRecord, null, 2), 'utf8');
  } catch (_) {}

  // 2. Call CreaPay API
  try {
    const cpRes = await fetch(creapayUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${creapayKey.trim()}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        order_id: orderId,
        title: orderTitle,
        amount_minor: amountMinor,
        currency: 'ZAR',
        customer: {
          name: name,
          email: payEmail,
          phone: phone
        }
      })
    });

    const cpData = await cpRes.json();
    if (cpRes.ok && cpData && (cpData.checkout_token || cpData.access_code)) {
      const finalRef = cpData.reference || cpData.id || orderId;
      console.log(`[create-order] CreaPay initialized order: ${orderId} | token: ${cpData.checkout_token} | access_code: ${cpData.access_code} | ref: ${finalRef}`);

      // Save pending order file and lookup index
      try {
        ensureDataDir();
        const initialItems = (Array.isArray(body.items) && body.items.length > 0)
          ? body.items
          : [{
              id: body.product_slug || 'defy-combo',
              title: orderTitle,
              variant: variant,
              price: totalZar,
              quantity: quantity,
              img: body.product_img || 'combo-silver.jpg'
            }];

        const pendingOrder = {
          order_id: orderId,
          reference: finalRef,
          gateway: 'creapay',
          checkout_token: cpData.checkout_token,
          access_code: cpData.access_code,
          sale_id: cpData.sale_id || null,
          status: 'pending',
          payment_status: 'PENDING',
          amount_zar: totalZar,
          product_price: totalZar,
          amount_minor: cpData.amount_minor || amountMinor,
          customer_name: name,
          customer_email: email || payEmail,
          customer_phone: phone,
          shipping_address: fullAddress,
          variant: variant,
          quantity: quantity,
          items: initialItems,
          trackingParameters: body.trackingParameters || body.utms || {},
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          utmify_sent: false
        };

        fs.writeFileSync(path.join(DATA_DIR, `order_${orderId}.json`), JSON.stringify(pendingOrder, null, 2), 'utf8');
        if (finalRef) {
          fs.writeFileSync(path.join(DATA_DIR, `ref_${finalRef}.json`), JSON.stringify({ orderId: orderId, reference: finalRef }, null, 2), 'utf8');
        }
        if (cpData.checkout_token) {
          fs.writeFileSync(path.join(DATA_DIR, `token_${cpData.checkout_token}.json`), JSON.stringify({ orderId: orderId, checkout_token: cpData.checkout_token }, null, 2), 'utf8');
        }
      } catch (saveErr) {
        console.warn('[create-order] Notice saving pending order file:', saveErr.message);
      }

      // Send reservation & recovery email to customer if valid email provided
      if (email && email.includes('@')) {
        try {
          const { sendAbandonedRecoveryEmail } = require('./email-service');
          await sendAbandonedRecoveryEmail({
            order_id: orderId,
            customer_name: name,
            customer_email: email,
            customer_phone: phone,
            amount: totalZar,
            checkout_url: cpData.checkout_url || (cpData.access_code ? ('https://checkout.paystack.com/' + cpData.access_code) : '')
          }).catch(e => console.warn('[create-order] Recovery email notice:', e.message));
        } catch (_) {}
      }

      return res.status(200).json({
        success: true,
        gateway: 'creapay',
        order_id: orderId,
        orderId: orderId,
        checkout_token: cpData.checkout_token,
        access_code: cpData.access_code,
        checkout_url: cpData.checkout_url || (cpData.access_code ? ('https://checkout.paystack.com/' + cpData.access_code) : ''),
        reference: finalRef,
        sale_id: cpData.sale_id,
        amount_minor: cpData.amount_minor || amountMinor,
        amount: totalZar,
        currency: 'ZAR',
        customer: { name, email: payEmail, phone }
      });
    } else {
      console.error('[create-order] CreaPay API error:', cpData);
      return res.status(cpRes.status || 400).json({
        error: cpData.message || cpData.error || 'Failed to initialize order with CreaPay',
        details: cpData
      });
    }
  } catch (err) {
    console.error('[create-order] Exception calling CreaPay:', err);
    return res.status(500).json({ error: 'Failed to contact CreaPay: ' + err.message });
  }
};
