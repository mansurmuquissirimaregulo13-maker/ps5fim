// api/upsell.js
// Handles 1-Click Upsell & Downsell charges and adds items to the existing Takealot order.

'use strict';

const fs = require('fs');
const path = require('path');

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const DATA_DIR    = path.join(process.cwd(), 'data');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
  }
}

async function kv_get(key) {
  if (REDIS_URL && REDIS_TOKEN) {
    try {
      const res = await fetch(REDIS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${REDIS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(['GET', key]),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.result) {
          try { return JSON.parse(data.result); } catch { return null; }
        }
      }
    } catch (_) {}
  }

  ensureDataDir();
  const filePath = path.join(DATA_DIR, key.replace(/[^a-zA-Z0-9_\-]/g, '_') + '.json');
  if (fs.existsSync(filePath)) {
    try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
  }
  return null;
}

async function kv_set(key, value) {
  if (REDIS_URL && REDIS_TOKEN) {
    try {
      await fetch(REDIS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${REDIS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(['SET', key, JSON.stringify(value)]),
      });
    } catch (_) {}
  }

  ensureDataDir();
  const filePath = path.join(DATA_DIR, key.replace(/[^a-zA-Z0-9_\-]/g, '_') + '.json');
  try {
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
  } catch (err) {
    console.error('[upsell] Save error:', err.message);
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  }
  body = body || {};

  const orderId = (body.orderId || '').trim();
  if (!orderId) {
    return res.status(400).json({ error: 'Missing orderId' });
  }

  const order = await kv_get('order:' + orderId);
  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }

  const itemsToAdd = (Array.isArray(body.items) && body.items.length > 0)
    ? body.items
    : [{
        offer: body.offer || 'microwave',
        type: body.type || 'upsell',
        price: Number(body.price) || (body.offer === 'microwave' ? (body.type === 'downsell' ? 197 : 397) : (body.type === 'downsell' ? 297 : 597)),
        title: body.title || (body.offer === 'microwave' ? 'Defy 20L Digital Mirror Finish Microwave Oven' : 'Lújo Master Chef 24-Piece Stainless Steel Cutlery & Knife Set'),
        img: body.img || (body.offer === 'microwave' ? 'microwave.png' : 'kitchen-kit.png'),
        variant: body.variant || 'Premium Upgrade'
      }];

  const price = (typeof body.price !== 'undefined' && Number(body.price) >= 0)
    ? Number(body.price)
    : itemsToAdd.reduce((sum, itm) => sum + (Number(itm.price) || 0), 0);

  const title = body.title || itemsToAdd.map(i => i.title).join(' + ');
  const offer = body.offer || (itemsToAdd.length > 1 ? 'bundle' : itemsToAdd[0].offer || 'upsell');
  const type  = body.type  || 'upsell';

  let settings = {};
  try {
    const { loadSettings } = require('./settings');
    settings = loadSettings();
  } catch (_) {}
  const stripeSecretKey = ((settings.stripe && settings.stripe.secretKey) || process.env.STRIPE_SECRET_KEY || '').trim();
  const pmId = body.paymentMethodId || order.stripe_payment_method_id;

  // 1-Click Charge attempt via Stripe if keys are present
  if (stripeSecretKey && pmId) {
    try {
      const amountInCents = Math.round(price * 100);
      const params = new URLSearchParams();
      params.append('amount', String(amountInCents));
      params.append('currency', 'zar');
      params.append('payment_method', pmId);
      params.append('confirm', 'true');
      params.append('off_session', 'true');
      params.append('description', `Takealot 1-Click Upsell: ${title.slice(0, 200)} (Order #${orderId})`);
      params.append('metadata[order_id]', orderId);
      params.append('metadata[item_title]', title.slice(0, 200));
      params.append('metadata[item_price]', `R ${price}`);
      params.append('metadata[offer_type]', `${offer}_${type}`.slice(0, 100));

      const stripeRes = await fetch('https://api.stripe.com/v1/payment_intents', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${stripeSecretKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      });

      const stripeData = await stripeRes.json();
      if (stripeData && stripeData.status === 'requires_action') {
        return res.status(200).json({
          requiresAction: true,
          clientSecret: stripeData.client_secret,
          orderId
        });
      }
    } catch (err) {
      console.warn('[upsell] Stripe off-session charge note:', err.message);
    }
  }

  // Update order items & total amount
  if (!Array.isArray(order.items)) {
    order.items = [];
    if (order.product_name) {
      order.items.push({
        id: 'main_product',
        title: order.product_name,
        variant: order.variant || 'Standard',
        price: Number(order.product_price || order.cart_total || 499),
        quantity: order.quantity || 1,
        img: order.product_image || 'produto.png',
      });
    }
  }

  itemsToAdd.forEach((itm, idx) => {
    order.items.push({
      id: `${itm.offer || offer}_${itm.type || type}_${Date.now()}_${idx}`,
      title: itm.title || 'Upgrade Item',
      variant: itm.variant || 'VIP Upgrade',
      price: Number(itm.price) || 0,
      quantity: 1,
      img: itm.img || 'produto.png',
    });
  });

  order.product_price = (Number(order.product_price) || 0) + price;
  order.updated_at = new Date().toISOString();

  if (!Array.isArray(order.status_history)) order.status_history = [];
  order.status_history.push({
    status: 'UPSELL_ADDED',
    timestamp: new Date().toISOString(),
    note: `1-Click Added: ${title} (R ${price}) [${type.toUpperCase()}]`,
  });

  await kv_set('order:' + orderId, order);
  console.log(`[upsell] Order ${orderId} updated: Added ${title} (+R ${price}). New Total: R ${order.product_price}`);

  // Sync updated order total to UTMify in background
  try {
    const { sendOrderToUtmify } = require('../scripts/utmify-api');
    sendOrderToUtmify(order).catch(e => console.warn('[upsell] UTMify sync notice:', e.message));
  } catch (_) {}

  return res.status(200).json({
    success: true,
    orderId: orderId,
    addedItems: itemsToAdd,
    updatedTotal: order.product_price,
    items: order.items,
  });
};
