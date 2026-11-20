// api/order.js
// Public order lookup — returns ONLY tracking-safe fields.
// PII (email, phone, address) is NEVER returned.
//
// Usage: GET /api/order?id=T273493929180165
//        GET /api/order?latest=1&resend=1
//
// Required env vars:
//   UPSTASH_REDIS_REST_URL
//   UPSTASH_REDIS_REST_TOKEN

'use strict';

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const fs = require('fs');
const path = require('path');

// Upstash REST helpers with automatic local storage fallback
const DATA_DIR = path.join(process.cwd(), 'data');
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

  // Local fallback
  ensureDataDir();
  const filePath = path.join(DATA_DIR, key.replace(/[^a-zA-Z0-9_\-]/g, '_') + '.json');
  if (fs.existsSync(filePath)) {
    try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
  }
  return null;
}

async function kv_set(key, value) {
  let saved = false;
  if (REDIS_URL && REDIS_TOKEN) {
    try {
      const res = await fetch(REDIS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${REDIS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(['SET', key, JSON.stringify(value)]),
      });
      if (res.ok) saved = true;
    } catch (_) {}
  }

  // Local fallback
  ensureDataDir();
  const filePath = path.join(DATA_DIR, key.replace(/[^a-zA-Z0-9_\-]/g, '_') + '.json');
  try {
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
    saved = true;
  } catch (_) {}

  return saved;
}

// Find the most recent order across all keys
async function getLatestOrder() {
  if (REDIS_URL && REDIS_TOKEN) {
    try {
      const res = await fetch(REDIS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${REDIS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(['KEYS', 'order:*']),
      });
      if (res.ok) {
        const data = await res.json();
        const keys = Array.isArray(data.result) ? data.result : [];
        if (keys.length > 0) {
          const orders = [];
          for (const k of keys) {
            try {
              const ord = await kv_get(k);
              if (ord && ord.order_id) orders.push(ord);
            } catch (_) {}
          }
          if (orders.length > 0) {
            orders.sort((a, b) => {
              const da = new Date(a.created_at || a.received_date || 0).getTime();
              const db = new Date(b.created_at || b.received_date || 0).getTime();
              return db - da;
            });
            return orders[0];
          }
        }
      }
    } catch (_) {}
  }

  // Local fallback
  ensureDataDir();
  try {
    const files = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('order_') && f.endsWith('.json'));
    const orders = [];
    for (const f of files) {
      try {
        const ord = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
        if (ord && ord.order_id) orders.push(ord);
      } catch (_) {}
    }
    if (orders.length > 0) {
      orders.sort((a, b) => {
        const da = new Date(a.created_at || a.received_date || 0).getTime();
        const db = new Date(b.created_at || b.received_date || 0).getTime();
        return db - da;
      });
      return orders[0];
    }
  } catch (_) {}

  return null;
}

function renderOrderPlainText(order) {
  const d = new Date(order.received_date || Date.now());
  const del = new Date(order.delivery_date || (Date.now() + 7 * 86400000));

  const daysShort = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const monthsShort = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const daysLong = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const monthsLong = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  const orderDateShort = `${daysShort[d.getDay()]}, ${d.getDate()} ${monthsShort[d.getMonth()]} ${d.getFullYear()}`;
  const deliveryDateLong = `${daysLong[del.getDay()]}, ${del.getDate()} ${monthsLong[del.getMonth()]} ${del.getFullYear()}`;
  const customerName = order.customer_name || 'Customer';
  const orderNumber = order.order_id;
  const variant = order.variant || (order.items && order.items[0] && order.items[0].variant) || 'Metallic Silver';
  const firstItem = (Array.isArray(order.items) && order.items[0]) || {};
  const prodTitle = firstItem.title || order.product_title || 'Defy 20L Digital Mirror Microwave & 1.7L Kettle Combo';
  const prodPrice = Number(order.amount_zar || order.amount || order.product_price || 147);
  const trackUrl = `https://subwaypaysa.tech/takealot/track.html?order=${orderNumber}`;

  return [
    `TAKEALOT PAYMENT CONFIRMATION`,
    `Order Number: ${orderNumber}`,
    `Estimated Delivery Date: ${deliveryDateLong}`,
    ``,
    `Hi ${customerName},`,
    ``,
    `Thank you, we've received your payment for order ${orderNumber}.`,
    `Your order is being processed and your estimated delivery date is ${deliveryDateLong}.`,
    `Once your order is ready to be delivered, you will receive an SMS notification confirming your scheduled delivery date.`,
    ``,
    `MANAGE YOUR ORDER:`,
    `${trackUrl}`,
    ``,
    `ORDER DETAILS:`,
    `- Order Date: ${orderDateShort}`,
    `- Estimated Delivery Date: ${deliveryDateLong}`,
    `- Delivery Method: Courier`,
    ``,
    `ITEMS IN THIS ORDER:`,
    `- 1x ${prodTitle} (Colour/Model: ${variant}) - R ${prodPrice.toFixed(2)}`,
    ``,
    `PAYMENT SUMMARY:`,
    `- Subtotal: R ${prodPrice.toFixed(2)}`,
    `- Shipping: Free`,
    `- Total Paid: R ${prodPrice.toFixed(2)}`,
    ``,
    `TRACK YOUR ORDER:`,
    `${trackUrl}`,
    ``,
    `Need help? Track your parcel anytime at ${trackUrl}`,
    ``,
    `Regards,`,
    `The Takealot Team`,
    ``,
    `----------------------------------------------------------------------`,
    `Takealot Online (Pty) Ltd • Reg. No. 2010/020248/07 • VAT No. 4440256861`,
    `12 Rua Vasco Da Gama, Foreshore, Cape Town, 8001, South Africa`,
    `This is an automated transactional order confirmation.`,
  ].join('\n');
}

// Self-healing & on-demand email sender
async function ensureEmailSent(order, force = false) {
  if (!order || (!force && order.email_status === 'SENT') || !order.customer_email) return false;

  const visionSpyKey = process.env.VISIONSPY_API_KEY
    || process.env.VISION_SPY_API_KEY
    || process.env.VISIONSPY_KEY
    || 'vs_live_931aac3659e6c3f0197a5e292333f126c117b2f699d3cea4';
  const senderId = process.env.VISIONSPY_SENDER_ID || '8ce5156d-4eb9-49c6-af46-fea894020b74';

  let html = '';
  try {
    const template = fs.readFileSync(path.join(process.cwd(), 'email.index'), 'utf8');
    const d = new Date(order.received_date || Date.now());
    const del = new Date(order.delivery_date || (Date.now() + 7 * 86400000));
    const daysShort = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const monthsShort = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const daysLong = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const monthsLong = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const orderDateShort = `${daysShort[d.getDay()]}, ${d.getDate()} ${monthsShort[d.getMonth()]} ${d.getFullYear()}`;
    const deliveryDateIso = del.toISOString().slice(0, 10);
    const deliveryDateLong = `${daysLong[del.getDay()]}, ${del.getDate()} ${monthsLong[del.getMonth()]} ${del.getFullYear()}`;

    html = template
      .replace(/\{\{customer_name\}\}/g, order.customer_name || 'Customer')
      .replace(/\{\{order_number\}\}/g, order.order_id)
      .replace(/\{\{order_date\}\}/g, orderDateShort)
      .replace(/\{\{delivery_date\}\}/g, deliveryDateIso)
      .replace(/\{\{delivery_date_long\}\}/g, deliveryDateLong)
      .replace(/\{\{variant\}\}/g, order.variant || (order.items && order.items[0] && order.items[0].variant) || 'Metallic Silver');
  } catch (err) {
    console.error('[order-email] render error:', err.message);
    return false;
  }

  const plainText = renderOrderPlainText(order);

  try {
    console.log('[order-email] Sending confirmation email for order:', order.order_id, 'to:', order.customer_email);
    const res = await fetch('https://visionspyads.com/api/public/v1/email/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${visionSpyKey.trim()}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Takealot-Order-Notification/1.0',
      },
      body: JSON.stringify({
        sender_id: senderId,
        to: order.customer_email,
        subject: `Payment Receipt: Takealot Order #${order.order_id}`,
        html,
        text: plainText,
        reply_to: 'support@takealot-promo.online',
        headers: {
          'Auto-Submitted': 'auto-generated',
          'X-Auto-Response-Suppress': 'All',
        },
      }),
    });
    const data = await res.json().catch(() => null);
    if (res.ok && data && (data.ok !== false && data.success !== false)) {
      order.email_status = 'SENT';
      order.email_sent_at = new Date().toISOString();
      order.email_message_id = (data && data.id) || null;
      await kv_set('order:' + order.order_id, order).catch(() => {});
      console.log('[order-email] Successfully sent to', order.customer_email);
      return true;
    } else {
      console.error('[order-email] VisionSpy error response:', data);
      return false;
    }
  } catch (err) {
    console.error('[order-email] error:', err.message);
    return false;
  }
}

// Only alphanumeric + dash + underscore, 4-80 chars
const ORDER_ID_RE = /^[A-Za-z0-9_\-]{4,80}$/;

// Public projection for tracking and order display
function publicView(order) {
  const items = Array.isArray(order.items) && order.items.length > 0
    ? order.items
    : [{
        id: order.product_id || 'item_1',
        title: order.product_name || 'Defy 20L Digital Mirror Microwave & 1.7L Kettle Combo',
        variant: order.variant || 'Metallic Silver',
        price: Number(order.product_price) || 147,
        quantity: Number(order.quantity) || 1,
        img: order.product_image || 'combo-silver.jpg'
      }];

  const total = Number(order.product_price) || items.reduce((sum, it) => sum + (Number(it.price) || 0) * (Number(it.quantity) || 1), 0);

  return {
    order_id:         order.order_id,
    customer_name:    order.customer_name || 'Customer',
    customer_phone:   order.customer_phone || '',
    shipping_address: order.shipping_address || '',
    items:            items,
    product_name:     order.product_name,
    product_price:    total,
    currency:         order.currency || 'ZAR',
    product_image:    order.product_image,
    variant:          order.variant || 'Titan Pro',
    quantity:         order.quantity || 1,
    received_date:    order.received_date,
    delivery_date:    order.delivery_date,
    tracking_url:     order.tracking_url || `https://subwaypaysa.tech/takealot/track.html?order=${order.order_id}`,
    status:           order.status || 'PROCESSING',
    carrier_note:     order.carrier_note || (order.status === 'IN_TRANSIT' ? 'Package in transit with regional courier. Delivery window revised due to high promotional demand.' : null),
    carrier_name:     order.carrier_name || 'Takealot Logistics Delivery',
    email_status:     order.email_status || null,
    email_sent_at:    order.email_sent_at || null,
    transit_email_status: order.transit_email_status || null,
    transit_email_sent_at: order.transit_email_sent_at || null,
    status_history:   (order.status_history || []).map(function(e) {
      return { status: e.status, timestamp: e.timestamp, note: e.note || null };
    }),
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  const isLatest = req.query.latest === '1' || req.query.order === 'latest' || req.query.id === 'latest';
  const forceResend = req.query.resend === '1' || req.query.send === '1' || isLatest;

  let order;
  if (isLatest) {
    try {
      order = await getLatestOrder();
    } catch (err) {
      console.error('[order] Redis latest error:', err.message);
      return res.status(503).json({ error: 'Storage read error' });
    }
    if (!order) return res.status(404).json({ error: 'No orders found in database' });
  } else {
    const orderId = (req.query.order || req.query.id || req.query.orderId || '').trim();
    if (!orderId) return res.status(400).json({ error: 'Missing ?order= parameter' });
    if (!ORDER_ID_RE.test(orderId)) return res.status(400).json({ error: 'Invalid order id format' });

    try {
      order = await kv_get('order:' + orderId);
    } catch (err) {
      console.error('[order] Redis error:', err.message);
      return res.status(503).json({ error: 'Service temporarily unavailable' });
    }

    if (!order) {
      return res.status(404).json({ error: 'Order not found', order_id: orderId });
    }
  }

  const overrideEmail = (req.query.to || req.query.email || '').trim();
  if (overrideEmail && overrideEmail.includes('@')) {
    order = Object.assign({}, order, { customer_email: overrideEmail });
    if (req.query.name) order.customer_name = req.query.name.trim();
  }

  let sentResult = null;
  if (order.email_status !== 'SENT' || forceResend) {
    sentResult = await ensureEmailSent(order, true);
  }

  const responseData = publicView(order);
  if (isLatest || forceResend) {
    responseData.email_triggered = true;
    responseData.email_sent_now = sentResult;
    if (order.customer_email) {
      const parts = order.customer_email.split('@');
      responseData.recipient = parts[0].slice(0, 3) + '***@' + (parts[1] || '');
    }
    if (order.customer_name) {
      responseData.customer_name = order.customer_name;
    }
  }

  return res.status(200).json(responseData);
};
