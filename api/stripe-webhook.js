// api/stripe-webhook.js
// Handles asynchronous Stripe webhook notifications (e.g. payment_intent.succeeded)
// Optional env var: STRIPE_WEBHOOK_SECRET (whsec_...)

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const REDIS_URL       = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN     = process.env.UPSTASH_REDIS_REST_TOKEN;
const WEBHOOK_SECRET  = process.env.STRIPE_WEBHOOK_SECRET;

const config = {
  api: {
    bodyParser: false,
  },
};

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
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(['GET', key]),
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.result) return null;
  try { return JSON.parse(data.result); } catch { return null; }
}

async function kv_set(key, value) {
  if (!REDIS_URL || !REDIS_TOKEN) return false;
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(['SET', key, JSON.stringify(value)]),
  });
  return res.ok;
}

function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!sigHeader || !secret) return false;
  const parts = sigHeader.split(',').reduce((acc, part) => {
    const [k, v] = part.trim().split('=');
    if (k && v) acc[k] = v;
    return acc;
  }, {});

  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) return false;

  const payload = `${timestamp}.${rawBody.toString('utf8')}`;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch {
    return res.status(400).json({ error: 'Failed to read raw body' });
  }

  if (WEBHOOK_SECRET) {
    const sigHeader = req.headers['stripe-signature'];
    const valid = verifyStripeSignature(rawBody, sigHeader, WEBHOOK_SECRET);
    if (!valid) {
      console.warn('[stripe-webhook] Signature verification failed');
      return res.status(400).json({ error: 'Invalid signature' });
    }
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data.object;
    const orderId = (pi.metadata && pi.metadata.order_id) || null;
    if (orderId && REDIS_URL && REDIS_TOKEN) {
      try {
        let order = await kv_get('order:' + orderId);
        if (order) {
          order.status = 'PAID';
          order.status_history = (order.status_history || []).concat([{
            status: 'PAID',
            timestamp: new Date().toISOString(),
          }]);
          await kv_set('order:' + orderId, order);
          console.log('[stripe-webhook] Order updated to PAID:', orderId);
        }
      } catch (err) {
        console.error('[stripe-webhook] Redis update error:', err.message);
      }
    }

    // Trigger Pushcut notification from webhook
    try {
      const amountZar = pi.amount ? (pi.amount / 100).toFixed(2) : '97.00';
      const pushcutUrl = 'https://api.pushcut.io/QsggCCih4K4SGeZy3F37z/notifications/MinhaNotifica%C3%A7%C3%A3o';
      await fetch(pushcutUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: `🎉 Stripe Pagamento Aprovado! R ${amountZar}`,
          text: `Pedido: #${orderId || pi.id}\nValor: R ${amountZar}\nStatus: Succeeded`,
        }),
      });
    } catch (_) {}
  }

  return res.status(200).json({ received: true });
};

module.exports.config = config;
