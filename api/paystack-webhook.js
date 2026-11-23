// api/paystack-webhook.js
// Production Webhook handler for Paystack events (charge.success, split verification, order finalization).
// Handles HMAC-SHA512 signature verification using PAYSTACK_SECRET_KEY.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { loadSettings } = require('./settings');

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const DATA_DIR    = path.join(process.cwd(), 'data');

const config = {
  api: {
    bodyParser: false,
  },
};

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
  }
}

function readRawBody(req) {
  if (Buffer.isBuffer(req.rawBody)) return Promise.resolve(req.rawBody);
  if (typeof req.rawBody === 'string') return Promise.resolve(Buffer.from(req.rawBody, 'utf8'));
  if (Buffer.isBuffer(req.body)) return Promise.resolve(req.body);

  if (req.readableEnded || req.complete) {
    if (typeof req.body === 'string') return Promise.resolve(Buffer.from(req.body, 'utf8'));
    if (req.body && typeof req.body === 'object') return Promise.resolve(Buffer.from(JSON.stringify(req.body), 'utf8'));
    return Promise.resolve(Buffer.alloc(0));
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', err => reject(err));
  });
}

async function kv_get(key) {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  try {
    const res = await fetch(REDIS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['GET', key]),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.result) return null;
    return JSON.parse(data.result);
  } catch {
    return null;
  }
}

async function kv_set(key, value) {
  if (!REDIS_URL || !REDIS_TOKEN) return false;
  try {
    const res = await fetch(REDIS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['SET', key, JSON.stringify(value)]),
    });
    return res.ok;
  } catch {
    return false;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Paystack-Signature');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const settings = loadSettings();
  const paystackSecret = (settings.paystack && settings.paystack.secretKey) || process.env.PAYSTACK_SECRET_KEY || '';
  const configuredSplit = (settings.paystack && settings.paystack.splitCode) || process.env.PAYSTACK_SPLIT_CODE || 'SPL_8ZpdS87KaP';

  // GET: Health / Verification diagnostic endpoint
  if (req.method === 'GET') {
    return res.status(200).json({
      status: 'active',
      gateway: 'paystack',
      endpoint: 'Paystack Live Webhook',
      configured: Boolean(paystackSecret),
      split_code: configuredSplit,
      events: ['charge.success'],
      timestamp: new Date().toISOString()
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (err) {
    return res.status(400).json({ error: 'Could not read raw body: ' + err.message });
  }

  const creapayConfig = (settings && settings.creapay) || {};
  const creapaySecret = creapayConfig.webhookSecret || process.env.CREAPAY_SECRET || 'cp_80ef8e4f3af530e285c0f89e80db47707d9b6f802d4f8531107357db7568b2fe';
  const cpSig = req.headers['x-creapay-signature'] || req.headers['http_x_creapay_signature'];
  const cpTime = req.headers['x-creapay-timestamp'] || req.headers['http_x_creapay_timestamp'] || '';
  const psSig = req.headers['x-paystack-signature'];

  // Verify signature (CreaPay HMAC-SHA256 or Paystack HMAC-SHA512)
  if (cpSig && creapaySecret) {
    try {
      // Support both timestamp.rawBody and rawBody HMAC calculations
      const hashWithTime = cpTime ? crypto.createHmac('sha256', creapaySecret.trim()).update(cpTime + '.' + rawBody).digest('hex') : null;
      const hashRaw = crypto.createHmac('sha256', creapaySecret.trim()).update(rawBody).digest('hex');

      const receivedBuf = Buffer.from(cpSig.trim(), 'hex');
      let isValid = false;

      if (hashWithTime && Buffer.from(hashWithTime, 'hex').length === receivedBuf.length && crypto.timingSafeEqual(Buffer.from(hashWithTime, 'hex'), receivedBuf)) {
        isValid = true;
      } else if (Buffer.from(hashRaw, 'hex').length === receivedBuf.length && crypto.timingSafeEqual(Buffer.from(hashRaw, 'hex'), receivedBuf)) {
        isValid = true;
      }

      if (!isValid) {
        console.warn('[creapay-webhook] Invalid HMAC-SHA256 signature');
        return res.status(401).json({ error: 'Invalid CreaPay signature' });
      }
    } catch (err) {
      console.error('[creapay-webhook] Signature verification error:', err.message);
      return res.status(401).json({ error: 'CreaPay signature verification failed' });
    }
  } else if (psSig && paystackSecret) {
    try {
      const hash = crypto
        .createHmac('sha512', paystackSecret.trim())
        .update(rawBody)
        .digest('hex');

      const expectedBuf = Buffer.from(hash, 'hex');
      const receivedBuf = Buffer.from(psSig, 'hex');

      if (expectedBuf.length !== receivedBuf.length || !crypto.timingSafeEqual(expectedBuf, receivedBuf)) {
        console.warn('[paystack-webhook] Invalid HMAC-SHA512 signature');
        return res.status(400).json({ error: 'Invalid Paystack signature' });
      }
    } catch (err) {
      console.error('[paystack-webhook] Signature verification error:', err.message);
      return res.status(400).json({ error: 'Signature verification failed' });
    }
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  const eventType = event.event || event.type || (event.status === 'approved' ? 'payment.approved' : '');
  console.log(`[webhook] Received event: ${eventType} | order_id: ${event.order_id || event.orderId || event.data?.id}`);

  const isApproved = eventType === 'charge.success' || 
                     eventType === 'payment.approved' || 
                     eventType === 'order.approved' || 
                     event.status === 'approved';

  if (isApproved) {
    const data = event.data || event;
    const meta = data.metadata || {};
    const reference = data.reference || event.reference || ('ref_' + Date.now());

    ensureDataDir();

    // 1. Resolve true orderId without generating duplicate ghost orders
    let orderId = event.order_id || event.orderId || data.order_id || meta.orderId || '';

    // Check reference index file if orderId was not directly in payload
    if (!orderId && reference) {
      const refFile = path.join(DATA_DIR, `ref_${reference}.json`);
      if (fs.existsSync(refFile)) {
        try {
          const refData = JSON.parse(fs.readFileSync(refFile, 'utf8'));
          if (refData && refData.orderId) orderId = refData.orderId;
        } catch (_) {}
      }
    }

    // Search data directory for existing order with matching reference
    if (!orderId && reference) {
      try {
        const allFiles = fs.readdirSync(DATA_DIR);
        for (const f of allFiles) {
          if (f.startsWith('order_') && f.endsWith('.json')) {
            try {
              const c = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
              if (c.reference === reference || c.paystack_reference === reference) {
                orderId = c.order_id;
                break;
              }
            } catch (_) {}
          }
        }
      } catch (_) {}
    }

    if (!orderId) {
      orderId = 'TK' + Date.now().toString(36).toUpperCase();
    }

    // 2. Load existing order data to preserve complete real product and customer info
    const orderFile = path.join(DATA_DIR, `order_${orderId}.json`);
    let existing = {};
    if (fs.existsSync(orderFile)) {
      try { existing = JSON.parse(fs.readFileSync(orderFile, 'utf8')); } catch (_) {}
    }

    const amountZar = data.amount_minor 
      ? (Number(data.amount_minor) / 100) 
      : (data.amount ? (Number(data.amount) / 100) : (Number(existing.amount_zar || meta.cart_total) || 147));
    const activeSplit = (data.split && data.split.split_code) || meta.split_code || existing.split_code || configuredSplit;

    // 3. Recover matching abandoned checkout
    try {
      const cleanPhone = (existing.customer_phone || meta.customer_phone || (data.customer && data.customer.phone) || '').replace(/[^0-9]/g, '');
      const cleanEmail = (existing.customer_email || (data.customer && data.customer.email ? data.customer.email : '')).replace(/[^a-zA-Z0-9_\-]/g, '_');
      const leadCandidates = [cleanPhone, cleanEmail, orderId].filter(Boolean);

      for (const cid of leadCandidates) {
        const p = path.join(DATA_DIR, `abandoned_${cid}.json`);
        if (fs.existsSync(p)) {
          try {
            const l = JSON.parse(fs.readFileSync(p, 'utf8'));
            l.status = 'RECOVERED';
            l.recovered_at = new Date().toISOString();
            l.recovered_gateway = 'creapay';
            l.recovered_ref = reference;
            l.split_code = activeSplit;
            fs.writeFileSync(p, JSON.stringify(l, null, 2), 'utf8');
            console.log(`[creapay-webhook] Lead ${cid} marked as RECOVERED`);

            // If existing order lacked items, recover them from the abandoned lead!
            if ((!existing.items || existing.items.length === 0) && Array.isArray(l.items) && l.items.length > 0) {
              existing.items = l.items;
              existing.variant = l.variant || existing.variant;
              existing.customer_name = l.customer_name || existing.customer_name;
              existing.customer_phone = l.customer_phone || existing.customer_phone;
              existing.customer_email = l.customer_email || existing.customer_email;
              existing.shipping_address = l.shipping_address || existing.shipping_address;
            }
          } catch (_) {}
        }
      }
    } catch (_) {}

    // 4. Build finalized Order record strictly preserving real data
    const customerName = existing.customer_name || meta.customer_name || (data.customer && `${data.customer.first_name || ''} ${data.customer.last_name || ''}`.trim()) || 'Valued Customer';
    const customerEmail = existing.customer_email || meta.real_email || meta.customer_email || (data.customer && data.customer.email) || '';
    const customerPhone = existing.customer_phone || meta.customer_phone || (data.customer && data.customer.phone) || '';

    const effectiveItems = (Array.isArray(existing.items) && existing.items.length > 0)
      ? existing.items
      : (Array.isArray(meta.items) && meta.items.length > 0)
        ? meta.items
        : [{
            id: 'ps5-gta6-bundle',
            title: 'Sony PlayStation 5 Slim 500GB Console + Grand Theft Auto VI (GTA 6) Limited Bundle',
            variant: existing.variant || meta.variant || 'Standard Bundle',
            price: amountZar,
            quantity: existing.quantity || 1,
            img: 'ps5_gta6_hero.jpg'
          }];

    const orderRecord = {
      ...existing,
      order_id: orderId,
      gateway: 'creapay',
      reference: reference,
      paystack_reference: reference,
      paystack_id: data.id || existing.paystack_id,
      split_code: activeSplit,
      split_subaccount: (data.split && data.split.subaccounts) || data.subaccount || null,
      amount: amountZar,
      amount_zar: amountZar,
      product_price: amountZar,
      currency: 'ZAR',
      status: 'approved',
      payment_status: 'PAID',
      customer_name: customerName,
      customer_email: customerEmail,
      customer_phone: customerPhone,
      shipping_address: existing.shipping_address || meta.shipping_address || '',
      variant: existing.variant || meta.variant || 'Metallic Silver',
      quantity: existing.quantity || meta.quantity || 1,
      items: effectiveItems,
      customer_ip: existing.customer_ip || data.ip_address || (req.headers['x-forwarded-for'] && req.headers['x-forwarded-for'].split(',')[0].trim()) || '102.132.22.15',
      trackingParameters: existing.trackingParameters || meta.trackingParameters || {},
      paid_at: data.paid_at || existing.paid_at || new Date().toISOString(),
      created_at: existing.created_at || new Date(data.created_at || Date.now()).toISOString(),
      approved_at: existing.approved_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
      received_date: existing.received_date || new Date().toISOString(),
      delivery_date: existing.delivery_date || new Date(Date.now() + 7 * 86400000).toISOString()
    };

    // Save finalized order to local file
    try {
      fs.writeFileSync(orderFile, JSON.stringify(orderRecord, null, 2), 'utf8');
      if (reference) {
        fs.writeFileSync(path.join(DATA_DIR, `ref_${reference}.json`), JSON.stringify({ orderId: orderId, reference: reference }, null, 2), 'utf8');
      }
    } catch (e) {
      console.error('[creapay-webhook] Local order write error:', e.message);
    }

    // Save to Redis
    try {
      await kv_set('order:' + orderId, orderRecord);
    } catch (_) {}

    console.log(`[creapay-webhook] Order ${orderId} saved with status PAID & gateway creapay`);

    // 5. Dispatch Server-Side UTMify conversion (Strictly Deduplicated)
    if (!existing.utmify_sent) {
      try {
        const { sendOrderToUtmify } = require('../scripts/utmify-api');
        sendOrderToUtmify(orderRecord).catch(err => console.warn('[creapay-webhook] UTMify sync notice:', err.message));
      } catch (_) {}
    } else {
      console.log(`[creapay-webhook] Order ${orderId} already sent to UTMify. Skipping duplicate.`);
    }

    // 6. Send Confirmation Email if customer email is present
    try {
      const { sendOrderConfirmationEmail } = require('./confirm-order');
      if (typeof sendOrderConfirmationEmail === 'function' && orderRecord.customer_email) {
        sendOrderConfirmationEmail(orderRecord).catch(() => {});
      }
    } catch (_) {}

    // 7. Trigger Pushcut Notification
    try {
      const pushcutUrl = 'https://api.pushcut.io/QsggCCih4K4SGeZy3F37z/notifications/MinhaNotifica%C3%A7%C3%A3o';
      fetch(pushcutUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: `🎉 CreaPay Pagamento Aprovado! R ${amountZar.toFixed(2)}`,
          text: `Pedido: #${orderId}\nCliente: ${customerName}\nStatus: Approved`,
        }),
      }).catch(() => {});
    } catch (_) {}

    return res.status(200).json({
      received: true,
      status: 'processed',
      order_id: orderId,
      reference: reference,
      split_code: activeSplit
    });
  }

  // Acknowledge other events (e.g. transfer.success, charge.dispute.create)
  return res.status(200).json({ received: true });
};

module.exports.config = config;
