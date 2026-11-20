// api/abandoned-checkout.js
// Captures and manages checkout abandonment leads in real-time.

'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(process.cwd(), 'data');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();

  ensureDataDir();

  // POST: Capture / Update Abandoned Lead
  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
    }
    body = body || {};

    const customer = body.customer || {};
    const shipping = body.shipping || {};
    const email = (customer.email || '').trim().toLowerCase();
    const phone = (customer.phone || '').trim();
    const name  = (customer.name  || '').trim();

    // Must have at least a phone or email or name
    if (!email && !phone && !name) {
      return res.status(200).json({ saved: false, reason: 'No contact info yet' });
    }

    // Stable identifier based on email or phone or provided id
    const cleanPhone = phone.replace(/[^0-9]/g, '');
    const cleanEmail = email.replace(/[^a-zA-Z0-9_\-]/g, '_');
    const leadId = (body.id || body.checkoutId || cleanPhone || cleanEmail || ('ab_' + Date.now())).slice(0, 50);

    const filePath = path.join(DATA_DIR, `abandoned_${leadId}.json`);

    let existing = {};
    if (fs.existsSync(filePath)) {
      try { existing = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) {}
    }

    const fullAddress = `${shipping.address || ''}, ${shipping.suburb || ''}, ${shipping.city || ''}, ${shipping.province || ''} ${shipping.postalCode || ''}`.replace(/^[\s,]+|[\s,]+$/g, '');

    const firstItem = (Array.isArray(body.items) && body.items[0]) || {};
    let pSlug = body.product_slug || firstItem.slug || firstItem.id || existing.product_slug || '';
    if (pSlug === 'cookware_set') pSlug = 'cookware-set';
    if (pSlug === 'defy_combo') pSlug = 'defy-combo';

    let cat = null;
    try {
      const { getProductFromSlug, PRODUCTS_CATALOG } = require('../products-catalog');
      if (typeof getProductFromSlug === 'function') {
        if (pSlug) cat = getProductFromSlug(pSlug);
        if (!cat) {
          const t = String(body.product_title || firstItem.title || existing.product_title || '').toLowerCase();
          if (t.includes('weld')) cat = getProductFromSlug('welder-inverter-250a');
          else if (t.includes('washer') || t.includes('pressure')) cat = getProductFromSlug('cordless-pressure-washer-48v');
          else if (t.includes('mixer')) cat = getProductFromSlug('stand-mixer-6-5l-inox-1500w');
          else if (t.includes('projector')) cat = getProductFromSlug('smart-4k-projector-120in-cinema');
          else if (t.includes('robot') || t.includes('mop')) cat = getProductFromSlug('smart-robot-vacuum-wet-mop');
          else if (t.includes('drill') || t.includes('toolkit')) cat = getProductFromSlug('master-toolkit-128p-impact-drill');
          else if (t.includes('camera') || t.includes('cctv')) cat = getProductFromSlug('solar-security-camera-4g-sim');
          else if (t.includes('fryer')) cat = getProductFromSlug('dual-basket-air-fryer-9l');
          else if (t.includes('ice')) cat = getProductFromSlug('countertop-fast-ice-maker');
          else if (t.includes('fridge')) cat = getProductFromSlug('portable-car-mini-fridge-20l');
          else if (t.includes('grill')) cat = getProductFromSlug('smokeless-indoor-electric-grill');
          else if (t.includes('braai')) cat = getProductFromSlug('portable-braai-suitcase-grill');
          else if (t.includes('coffee') || t.includes('espresso')) cat = getProductFromSlug('espresso-coffee-machine-20bar');
          else if (t.includes('grind')) cat = getProductFromSlug('cordless-angle-grinder-brushless');
          else if (t.includes('solar') || t.includes('power station')) cat = getProductFromSlug('solar-power-station-500w');
          else if (t.includes('laser')) cat = getProductFromSlug('laser-level-4d-16-lines');
          else if (t.includes('stick') || t.includes('vacuum')) cat = getProductFromSlug('cordless-stick-vacuum-cleaner');
          else if (t.includes('polish') || t.includes('buffer')) cat = getProductFromSlug('cordless-car-buffer-polisher');
          else if (t.includes('pump')) cat = getProductFromSlug('submersible-clean-dirty-water-pump');
          else if (t.includes('cookware') || t.includes('granite') || t.includes('berlinger') || t.includes('panela')) {
            cat = getProductFromSlug('german-granite-cookware-16p') || getProductFromSlug('cookware-set');
          }
        }
        if (cat && cat.slug) pSlug = cat.slug;
      }
    } catch (_) {}

    if (!pSlug) pSlug = 'german-granite-cookware-16p';

    const pTitle = (cat && cat.title) || body.product_title || firstItem.title || existing.product_title || '16-Piece German Granite Non-Stick Cookware';
    const pImg = (cat && (cat.image || cat.fallback_image)) || body.product_img || firstItem.img || firstItem.image || existing.product_img || 'images/products/03_German_Granite_Cookware_16P_R597.jpg';

    // Product promotional price
    let pPrice = Number((cat && cat.price) || body.product_price || firstItem.price || body.cartTotal || existing.product_price || 97);
    if (cat && cat.price) {
      pPrice = Number(cat.price);
    }

    const itemsList = (Array.isArray(body.items) && body.items.length > 0)
      ? body.items.map(it => {
          let itPr = Number(it.price || pPrice);
          return Object.assign({}, it, { price: itPr });
        })
      : [{
          id: pSlug,
          title: pTitle,
          variant: body.variant || existing.variant || 'Standard',
          price: pPrice,
          quantity: body.quantity || existing.quantity || 1,
          img: pImg
        }];

    const record = Object.assign(existing, {
      id: leadId,
      customer_name: name || existing.customer_name || 'Valued Customer',
      customer_email: email || existing.customer_email || '',
      customer_phone: phone || existing.customer_phone || '',
      shipping_address: fullAddress || existing.shipping_address || '',
      product_slug: pSlug,
      product_title: pTitle,
      product_img: pImg,
      product_price: pPrice,
      variant: body.variant || existing.variant || 'Standard',
      quantity: body.quantity || existing.quantity || 1,
      items: itemsList,
      cart_total: pPrice,
      created_at: existing.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
      status: existing.status === 'RECOVERED' ? 'RECOVERED' : 'ABANDONED',
      recovery_email_sent: existing.recovery_email_sent || false,
      recovery_email_at: existing.recovery_email_at || null,
      recovery_msg_id: existing.recovery_msg_id || null,
      recovery_url: `https://subwaypaysa.tech/takealot/checkout.html?recover=${encodeURIComponent(leadId)}${pSlug ? '&p=' + encodeURIComponent(pSlug) : ''}`
    });

    try {
      fs.writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf8');
      console.log(`[abandoned] Lead saved: ${record.customer_name} | Tel: ${record.customer_phone} | Email: ${record.customer_email}`);
      return res.status(200).json({ success: true, leadId, lead: record });
    } catch (err) {
      console.error('[abandoned] File write error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // GET: Lookup or list abandoned checkouts
  if (req.method === 'GET') {
    const recoverId = (req.query.id || req.query.recover || '').trim();
    if (recoverId) {
      const clean = recoverId.replace(/[^a-zA-Z0-9_\-]/g, '_');
      const filePath = path.join(DATA_DIR, `abandoned_${clean}.json`);
      if (fs.existsSync(filePath)) {
        try {
          const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          return res.status(200).json({ success: true, lead: data });
        } catch (_) {}
      }
      return res.status(404).json({ error: 'Lead not found' });
    }

    // List all
    const files = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('abandoned_') && f.endsWith('.json'));
    const list = [];
    for (const file of files) {
      try {
        const item = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
        list.push(item);
      } catch (_) {}
    }
    list.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

    return res.status(200).json({
      success: true,
      total: list.length,
      abandonedCount: list.filter(l => l.status === 'ABANDONED').length,
      recoveredCount: list.filter(l => l.status === 'RECOVERED').length,
      leads: list
    });
  }

  return res.status(405).json({ error: 'Method Not Allowed' });
};
