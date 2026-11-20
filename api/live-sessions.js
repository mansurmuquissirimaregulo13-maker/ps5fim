// api/live-sessions.js
// Handles client heartbeats (POST) and Admin Live Sessions feed (GET).

'use strict';

const tracker = require('../lib/session-tracker');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // 1. RECORD PING FROM VISITOR
  if (req.method === 'POST') {
    let body = req.body || {};
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (_) { body = {}; }
    }

    const forwarded = req.headers['x-forwarded-for'];
    const ip = (forwarded ? forwarded.split(',')[0].trim() : (req.headers['x-real-ip'] || (req.socket && req.socket.remoteAddress) || '127.0.0.1'))
      .replace(/^::ffff:/, '');

    const userAgent = req.headers['user-agent'] || '';
    const country = req.headers['cf-ipcountry'] || 'ZA';

    const session = tracker.recordPing({
      sessionId: body.sessionId,
      path: body.path || req.query.path || '/',
      query: req.query || {},
      title: body.title || '',
      referrer: body.referrer || req.headers['referer'] || '',
      cart: body.cart || null,
      customer: body.customer || null,
      orderId: body.orderId || null,
      ip,
      country,
      userAgent
    });

    return res.status(200).json({
      success: true,
      sessionId: session.id,
      onlineNow: tracker.getActiveSessions().length
    });
  }

  // 2. ADMIN LIVE FEED (GET)
  const summary = tracker.getSummary();
  return res.status(200).json(Object.assign({ success: true }, summary));
};
