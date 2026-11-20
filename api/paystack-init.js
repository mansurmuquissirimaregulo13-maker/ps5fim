// api/paystack-init.js
// Initializes a South African Rand (ZAR) payment session with Paystack.

'use strict';

const fs = require('fs');
const path = require('path');
const { loadSettings } = require('./settings');

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

  const settings = loadSettings();
  const creapayConfig = (settings && settings.creapay) || {};
  const creapayKey = creapayConfig.apiKey || process.env.CREAPAY_API_KEY || 'cp_80ef8e4f3af530e285c0f89e80db47707d9b6f802d4f8531107357db7568b2fe';
  const creapayUrl = creapayConfig.apiUrl || process.env.CREAPAY_API_URL || 'https://pay.africagrabpoint.com/api/public/v1/orders';

  // --------------------------------------------------------------
  // 1️⃣ Modo de operação (hybrid ou direct)
  // --------------------------------------------------------------
  const mode = (body.mode || 'hybrid').toLowerCase(); // default = hybrid
  const isCreaPayActive = mode === 'hybrid' && ((settings.activeGateway === 'creapay') || Boolean(creapayKey));

  const paystackSecret = (settings.paystack && settings.paystack.secretKey) || process.env.PAYSTACK_SECRET_KEY || '';
  const paystackPublic = (settings.paystack && settings.paystack.publicKey) || process.env.PAYSTACK_PUBLIC_KEY || '';
  const splitCode = (settings.paystack && settings.paystack.splitCode) || process.env.PAYSTACK_SPLIT_CODE || 'SPL_8ZpdS87KaP';

  if (!paystackSecret && !creapayKey) {
    return res.status(400).json({
      error: 'Payment Gateway is not configured. Please add keys in the Admin Settings tab.',
      notConfigured: true
    });
  }

  const customer = body.customer || {};
  const shipping = body.shipping || {};
  const email = (customer.email || '').trim().toLowerCase();
  const phone = (customer.phone || '').trim();
  const name  = (customer.name  || 'Valued Customer').trim();
  const variant = body.variant || 'Metallic Silver';
  const quantity = Math.max(1, parseInt(body.quantity, 10) || 1);

  // Compute total amount in ZAR
  let totalZar = 147;
  if (Array.isArray(body.items) && body.items.length > 0) {
    totalZar = body.items.reduce((s, it) => s + (Number(it.price) || 0) * (Number(it.quantity) || 1), 0);
  } else if (body.cartTotal) {
    totalZar = Number(body.cartTotal);
  }
  if (!totalZar || totalZar <= 0) totalZar = 147;

  // Adiciona taxa se configurada (body.fee ou settings.fees)
  const feeAmount = (body.fee !== undefined) ? Math.max(0, Number(body.fee) || 0) : ((settings.fees && settings.fees.enabled) ? Math.max(0, Number(settings.fees.amount) || 0) : 0);
  if (feeAmount > 0) {
    totalZar += feeAmount;
  }

  // Paystack expects amount in sub-units (cents): R 147 = 14700 cents
  const amountInCents = Math.round(totalZar * 100);

  // Ensure 100% valid, reliable email address for Paystack
  const isValidEmail = (e) => typeof e === 'string' && /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(e.trim());
  let payEmail = isValidEmail(email) ? email.trim().toLowerCase() : '';
  if (!payEmail) {
    const cleanPrefix = (name || 'client').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10) || 'customer';
    const cleanNum = phone.replace(/[^0-9]/g, '').slice(-6) || Math.floor(100000 + Math.random() * 900000);
    payEmail = `${cleanPrefix}${cleanNum}@gmail.com`;
  }

  const orderId = 'TK' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
  const reference = 'tk_pay_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);

  const fullAddress = `${shipping.address || ''}, ${shipping.suburb || ''}, ${shipping.city || ''}, ${shipping.province || ''} ${shipping.postalCode || ''}`.replace(/^[\\s,]+|[\\s,]+$/g, '');

  // Save abandoned checkout lead locally in real-time
  try {
    const DATA_DIR = path.join(process.cwd(), 'data');
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const cleanPhone = phone.replace(/[^0-9]/g, '');
    const leadId = cleanPhone || (email ? email.replace(/[^a-zA-Z0-9_\\-]/g, '_') : '') || orderId;
    const leadPath = path.join(DATA_DIR, `abandoned_${leadId}.json`);

    // Determine instance base URL from referer or request headers
    const referer = (req.headers.referer || '').toLowerCase();
    let instancePrefix = '/takealot';
    if (referer.includes('/takealotmicro') || (process.env.PORT === '3003') || (process.env.INSTANCE_SLUG === 'takealotmicro')) {
      instancePrefix = '/takealotmicro';
    } else if (referer.includes('/takealot2') || (process.env.PORT === '3002') || (process.env.INSTANCE_SLUG === 'takealot2')) {
      instancePrefix = '/takealot2';
    }
    const baseUrl = `https://subwaypaysa.tech${instancePrefix}`;

    const firstItem = (Array.isArray(body.items) && body.items[0]) || {};
    const leadSlug = body.product_slug || firstItem.slug || firstItem.id || '';
    const leadTitle = body.product_title || firstItem.title || 'Takealot Deal';
    const leadImg = body.product_img || firstItem.img || firstItem.image || 'produto.png';

    const leadRecord = {
      id: leadId,
      orderId: orderId,
      paystack_reference: reference,
      split_code: splitCode,
      customer_name: name,
      customer_email: email,
      customer_phone: phone,
      shipping_address: fullAddress,
      product_slug: leadSlug,
      product_title: leadTitle,
      product_img: leadImg,
      variant: variant,
      quantity: quantity,
      items: body.items || [],
      cart_total: totalZar,
      gateway: 'paystack',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      status: 'ABANDONED',
      recovery_url: `${baseUrl}/checkout.html?recover=${encodeURIComponent(leadId)}${leadSlug ? '&p=' + encodeURIComponent(leadSlug) : ''}`
    };
    fs.writeFileSync(leadPath, JSON.stringify(leadRecord, null, 2), 'utf8');
  } catch (_) {}

  // --------------------------------------------------------------
  // 2️⃣ Tentativa híbrida – CreaPay → Paystack
  // --------------------------------------------------------------
  if (isCreaPayActive && creapayKey) {
    try {
      const firstItem = (Array.isArray(body.items) && body.items[0]) || {};
      const orderTitle = body.title || body.product_title || firstItem.title || 'Takealot Order';
      const cpRes = await fetch(creapayUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${creapayKey.trim()}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          order_id: orderId,
          title: orderTitle,
          amount_minor: amountInCents,
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
        const finalRef = cpData.reference || reference;
        console.log(`[creapay-init] Initialized order: ${orderId} | token: ${cpData.checkout_token} | access_code: ${cpData.access_code} | ref: ${finalRef}`);

        // Persist initial pending order record with 100% complete data
        try {
          const DATA_DIR = path.join(process.cwd(), 'data');
          if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

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
            amount_minor: cpData.amount_minor || amountInCents,
            customer_name: name,
            customer_email: email || payEmail,
            customer_phone: phone,
            shipping_address: fullAddress,
            variant: variant,
            quantity: quantity,
            items: initialItems,
            trackingParameters: body.trackingParameters || {},
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            utmify_sent: false
          };
          fs.writeFileSync(path.join(DATA_DIR, `order_${orderId}.json`), JSON.stringify(pendingOrder, null, 2), 'utf8');

          // Reference and Token lookup indices for webhook & confirmation
          if (finalRef) {
            fs.writeFileSync(path.join(DATA_DIR, `ref_${finalRef}.json`), JSON.stringify({ orderId: orderId, reference: finalRef }, null, 2), 'utf8');
          }
          if (cpData.checkout_token) {
            fs.writeFileSync(path.join(DATA_DIR, `token_${cpData.checkout_token}.json`), JSON.stringify({ orderId: orderId, checkout_token: cpData.checkout_token }, null, 2), 'utf8');
          }
        } catch (saveErr) {
          console.warn('[creapay-init] Notice saving pending order file:', saveErr.message);
        }

        // --------------------------------------------------------------
        // 2️⃣ Resposta híbrida – devolve *access_code* para o cliente
        // --------------------------------------------------------------
        return res.status(200).json({
          success: true,
          gateway: 'paystack',
          orderId: orderId,
          reference: finalRef,
          access_code: cpData.access_code,
          public_key: paystackPublic,
          amount: totalZar,
          currency: 'ZAR'
        });
      } else {
        console.warn('[creapay] CreaPay response error, falling back to direct Paystack:', cpData);
      }
    } catch (cpErr) {
      console.warn('[creapay] Exception contacting CreaPay, falling back to direct Paystack:', cpErr.message);
    }
  }

  // --------------------------------------------------------------
  // 3️⃣ Modo **direct** – Salta CreaPay e usa Paystack direto
  // --------------------------------------------------------------
  if (mode === 'direct' || !isCreaPayActive) {
    try {
      const referer = (req.headers.referer || '').toLowerCase();
      let instancePrefix = '/takealot';
      if (referer.includes('/takealotmicro') || (process.env.PORT === '3003') || (process.env.INSTANCE_SLUG === 'takealotmicro')) {
        instancePrefix = '/takealotmicro';
      } else if (referer.includes('/takealot2') || (process.env.PORT === '3002') || (process.env.INSTANCE_SLUG === 'takealot2')) {
        instancePrefix = '/takealot2';
      }
      const baseUrl = `https://subwaypaysa.tech${instancePrefix}`;

      let callbackUrl = body.callbackUrl;
      if (callbackUrl) {
        const sep = callbackUrl.includes('?') ? '&' : '?';
        callbackUrl = `${callbackUrl}${sep}order=${orderId}&ref=${reference}`;
      } else {
        callbackUrl = `${baseUrl}/sucesso.html?order=${orderId}&ref=${reference}`;
      }

      const initPayload = {
        email: payEmail,
        amount: amountInCents,
        currency: 'ZAR',
        reference: reference,
        split_code: splitCode,
        callback_url: callbackUrl,
        metadata: {
          orderId: orderId,
          split_code: splitCode,
          customer_name: name,
          customer_phone: phone,
          customer_email: email || '',
          real_email: email || '',
          generated_paystack_email: payEmail,
          shipping_address: fullAddress,
          variant: variant,
          quantity: quantity,
          items: body.items || [],
          cart_total: totalZar,
          trackingParameters: body.trackingParameters || {}
        }
      };

      const paystackRes = await fetch('https://api.paystack.co/transaction/initialize', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${paystackSecret.trim()}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(initPayload)
      });

      const data = await paystackRes.json();
      if (data.status && data.data) {
        console.log(`[paystack-init] Initialized order: ${orderId} | ref: ${reference} | split_code: ${splitCode} | payEmail: ${payEmail}`);
        // --------------------------------------------------------------
        // 3️⃣ Resposta direta – devolve *access_code* para o cliente
        // --------------------------------------------------------------
        return res.status(200).json({
          success: true,
          gateway: 'paystack',
          orderId: orderId,
          reference: reference,
          access_code: data.data.access_code,
          public_key: paystackPublic,
          amount: totalZar,
          currency: 'ZAR'
        });
      } else {
        console.error('[paystack] Init error:', data);
        return res.status(400).json({
          error: data.message || 'Error initializing Paystack transaction',
          details: data
        });
      }
    } catch (err) {
      console.error('[paystack] Fetch exception:', err);
      return res.status(500).json({ error: 'Failed to contact Paystack: ' + err.message });
    }
  }
};
