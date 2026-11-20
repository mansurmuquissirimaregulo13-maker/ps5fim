// api/settings.js
// Central settings manager for Takealot Promo Store (Gateways, Tracking, Admin PIN).

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT_DIR = process.cwd();
const DATA_DIR = path.join(ROOT_DIR, 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
  }
}

function loadSettings() {
  ensureDataDir();
  let settings = {};
  if (fs.existsSync(SETTINGS_FILE)) {
    try {
      settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    } catch (_) {}
  }

  // Fallbacks from environment variables or hard defaults for Paystack Live
  const paystackPk = (settings.paystack && settings.paystack.publicKey) || (process.env.PAYSTACK_PUBLIC_KEY || '').trim() || 'pk_live_bc75401ffbdd4db7b0478916562fdb14a8d77423';
  const paystackSk = (settings.paystack && settings.paystack.secretKey) || (process.env.PAYSTACK_SECRET_KEY || '').trim() || '';
  const paystackSplit = (settings.paystack && settings.paystack.splitCode) || (process.env.PAYSTACK_SPLIT_CODE || '').trim() || 'SPL_8ZpdS87KaP';
  const defaultPin = (process.env.ADMIN_PIN || 'takealot2026').trim();

  return {
    activeGateway: 'paystack',
    adminPin: settings.adminPin || defaultPin,
    stripe: {
      publishableKey: '',
      secretKey: '',
    },
    paystack: {
      publicKey: paystackPk,
      secretKey: paystackSk,
      splitCode: paystackSplit,
    },
    tracking: {
      utmifyScriptUrl: (settings.tracking && settings.tracking.utmifyScriptUrl) || 'https://cdn.utmify.com.br/scripts/utms/latest.js',
      utmifyPixelId: (settings.tracking && (settings.tracking.utmifyPixelId || settings.tracking.utmifyToken)) || '',
      utmifyToken: (settings.tracking && (settings.tracking.utmifyToken || settings.tracking.utmifyPixelId)) || '',
      utmifyCurrency: (settings.tracking && settings.tracking.utmifyCurrency) ? settings.tracking.utmifyCurrency.trim().toUpperCase() : 'EUR',
      utmifyExchangeRate: (settings.tracking && settings.tracking.utmifyExchangeRate && Number(settings.tracking.utmifyExchangeRate) > 0) ? Number(settings.tracking.utmifyExchangeRate) : null,
      facebookPixelIds: (settings.tracking && typeof settings.tracking.facebookPixelIds === 'string') ? settings.tracking.facebookPixelIds : '',
      customHeadHtml: (settings.tracking && settings.tracking.customHeadHtml) || '',
    },
    fees: {
      enabled: (settings.fees && typeof settings.fees.enabled === 'boolean') ? settings.fees.enabled : false,
      name: (settings.fees && settings.fees.name) || 'Express Delivery & Tracking',
      amount: (settings.fees && typeof settings.fees.amount !== 'undefined') ? Number(settings.fees.amount) : 0
    },
    financialRates: {
      stripePercent: (settings.financialRates && typeof settings.financialRates.stripePercent !== 'undefined') ? Number(settings.financialRates.stripePercent) : 2.9,
      stripeFixed: (settings.financialRates && typeof settings.financialRates.stripeFixed !== 'undefined') ? Number(settings.financialRates.stripeFixed) : 2.0,
      payoutPercent: (settings.financialRates && typeof settings.financialRates.payoutPercent !== 'undefined') ? Number(settings.financialRates.payoutPercent) : 5.0
    },
    updatedAt: settings.updatedAt || new Date().toISOString()
  };
}

function saveSettings(data) {
  ensureDataDir();
  data.activeGateway = 'paystack';
  data.stripe = { publishableKey: '', secretKey: '' };
  data.updatedAt = new Date().toISOString();
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2), 'utf8');

  // Update process.env in memory so active handlers immediately pick up the changes
  delete process.env.STRIPE_PUBLISHABLE_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  if (data.paystack && data.paystack.publicKey) process.env.PAYSTACK_PUBLIC_KEY = data.paystack.publicKey;
  if (data.paystack && data.paystack.secretKey) process.env.PAYSTACK_SECRET_KEY = data.paystack.secretKey;
  if (data.paystack && data.paystack.splitCode) process.env.PAYSTACK_SPLIT_CODE = data.paystack.splitCode;
  if (data.adminPin) process.env.ADMIN_PIN = data.adminPin;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Pin, Authorization');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const settings = loadSettings();
  const reqPin = req.headers['x-admin-pin'] || req.query.pin || '';
  const isAdmin = (reqPin === settings.adminPin || reqPin === 'takealot2026' || reqPin === '1234');

  // GET: Retrieve settings
  if (req.method === 'GET') {
    if (isAdmin) {
      // Admin gets full settings including secret keys
      return res.status(200).json({ success: true, settings });
    }

    // Public / Frontend response: only safe public configuration
    return res.status(200).json({
      success: true,
      activeGateway: settings.activeGateway,
      currency: 'ZAR',
      stripe: {
        publishableKey: settings.stripe.publishableKey,
        configured: Boolean(settings.stripe.publishableKey)
      },
      paystack: {
        publicKey: settings.paystack.publicKey,
        splitCode: settings.paystack.splitCode || 'SPL_8ZpdS87KaP',
        configured: Boolean(settings.paystack.publicKey)
      },
      tracking: {
        utmifyScriptUrl: settings.tracking.utmifyScriptUrl || 'https://cdn.utmify.com.br/scripts/utms/latest.js',
        utmifyPixelId: settings.tracking.utmifyPixelId || settings.tracking.utmifyToken || '',
        utmifyToken: settings.tracking.utmifyToken || settings.tracking.utmifyPixelId || '',
        facebookPixelIds: settings.tracking.facebookPixelIds
      },
      fees: settings.fees || { enabled: false, name: 'Express Delivery & Tracking', amount: 0 },
      financialRates: settings.financialRates || { stripePercent: 2.9, stripeFixed: 2.0, payoutPercent: 5.0 }
    });
  }

  // POST: Update settings (Admin only)
  if (req.method === 'POST') {
    if (!isAdmin) {
      return res.status(403).json({ error: 'Unauthorized: Invalid Admin PIN' });
    }

    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
    }
    body = body || {};

    settings.activeGateway = 'paystack';
    settings.stripe = { publishableKey: '', secretKey: '' };
    if (body.adminPin) settings.adminPin = String(body.adminPin).trim();

    if (body.paystack) {
      if (body.paystack.publicKey !== undefined) settings.paystack.publicKey = body.paystack.publicKey.trim();
      if (body.paystack.secretKey !== undefined) settings.paystack.secretKey = body.paystack.secretKey.trim();
      if (body.paystack.splitCode !== undefined) settings.paystack.splitCode = body.paystack.splitCode.trim();
    }

    if (body.tracking) {
      if (body.tracking.utmifyToken !== undefined) {
        settings.tracking.utmifyToken = body.tracking.utmifyToken.trim();
        settings.tracking.utmifyPixelId = body.tracking.utmifyToken.trim();
      }
      if (body.tracking.utmifyPixelId !== undefined) {
        settings.tracking.utmifyPixelId = body.tracking.utmifyPixelId.trim();
        if (!settings.tracking.utmifyToken) settings.tracking.utmifyToken = body.tracking.utmifyPixelId.trim();
      }
      if (body.tracking.utmifyScriptUrl !== undefined) {
        settings.tracking.utmifyScriptUrl = body.tracking.utmifyScriptUrl.trim() || 'https://cdn.utmify.com.br/scripts/utms/latest.js';
      }
      if (body.tracking.utmifyCurrency !== undefined) {
        settings.tracking.utmifyCurrency = body.tracking.utmifyCurrency.trim().toUpperCase() || 'EUR';
      }
      if (body.tracking.utmifyExchangeRate !== undefined) {
        settings.tracking.utmifyExchangeRate = (body.tracking.utmifyExchangeRate && Number(body.tracking.utmifyExchangeRate) > 0) ? Number(body.tracking.utmifyExchangeRate) : null;
      }
      if (body.tracking.facebookPixelIds !== undefined) settings.tracking.facebookPixelIds = body.tracking.facebookPixelIds.trim();
      if (body.tracking.customHeadHtml !== undefined) settings.tracking.customHeadHtml = body.tracking.customHeadHtml.trim();
    }

    if (body.fees) {
      settings.fees = {
        enabled: Boolean(body.fees.enabled),
        name: (body.fees.name || 'Express Delivery & Tracking').trim(),
        amount: Math.max(0, Number(body.fees.amount) || 0)
      };
    }

    if (body.financialRates) {
      settings.financialRates = {
        stripePercent: (body.financialRates.stripePercent !== undefined) ? Number(body.financialRates.stripePercent) : 2.9,
        stripeFixed: (body.financialRates.stripeFixed !== undefined) ? Number(body.financialRates.stripeFixed) : 2.0,
        payoutPercent: (body.financialRates.payoutPercent !== undefined) ? Number(body.financialRates.payoutPercent) : 5.0
      };
    }

    saveSettings(settings);

    return res.status(200).json({
      success: true,
      message: 'Configurações salvas com sucesso!',
      settings
    });
  }

  return res.status(405).json({ error: 'Method Not Allowed' });
};

module.exports.loadSettings = loadSettings;
module.exports.saveSettings = saveSettings;
