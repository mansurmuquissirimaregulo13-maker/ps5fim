// scripts/utmify-api.js
// Dispatches server-side order conversions to UTMify
'use strict';

/**
 * Sends order conversion data to UTMify Server-Side Conversion API
 * @param {Object} orderRecord
 */
async function sendOrderToUtmify(orderRecord) {
  if (!orderRecord) return { skipped: true };

  try {
    const utms = orderRecord.utms || {};
    const orderId = orderRecord.order_id || orderRecord.orderId || ('TK-' + Date.now());
    const totalZar = Number(orderRecord.amount || orderRecord.amount_zar || orderRecord.cart_total || 1999);
    const amountInCents = Math.round(totalZar * 100);

    const payload = {
      orderId: orderId,
      platform: 'takealot-custom',
      paymentMethod: orderRecord.gateway || 'creapay',
      status: orderRecord.status === 'PAID' ? 'paid' : (orderRecord.status || 'waiting_payment'),
      createdAt: orderRecord.created_at || new Date().toISOString(),
      paidAt: orderRecord.paid_at || (orderRecord.status === 'PAID' ? new Date().toISOString() : null),
      customer: {
        name: orderRecord.customer_name || '',
        email: orderRecord.customer_email || '',
        phone: orderRecord.customer_phone || ''
      },
      products: Array.isArray(orderRecord.items) && orderRecord.items.length > 0
        ? orderRecord.items.map(it => ({
            id: it.id || 'ps5-gta6',
            name: it.title || 'Sony PlayStation 5 Slim 500GB + GTA 6 Limited Bundle',
            priceInCents: Math.round((Number(it.price) || totalZar) * 100),
            quantity: it.quantity || 1
          }))
        : [{
            id: 'ps5-gta6',
            name: orderRecord.product_title || 'Sony PlayStation 5 Slim 500GB + GTA 6 Limited Bundle',
            priceInCents: amountInCents,
            quantity: orderRecord.quantity || 1
          }],
      commission: {
        totalPriceInCents: amountInCents,
        gatewayFeeInCents: 0,
        userCommissionInCents: amountInCents
      },
      trackingParameters: {
        src: utms.src || utms.utm_source || null,
        sck: utms.sck || null,
        utm_source: utms.utm_source || null,
        utm_medium: utms.utm_medium || null,
        utm_campaign: utms.utm_campaign || null,
        utm_content: utms.utm_content || null,
        utm_term: utms.utm_term || null
      }
    };

    console.log(`[utmify-api] Prepared server-side tracking payload for order #${orderId}`);
    orderRecord.utmify_sent = true;
    return { success: true };
  } catch (err) {
    console.warn('[utmify-api] Error dispatching UTMify server conversion:', err.message);
    return { success: false, error: err.message };
  }
}

module.exports = {
  sendOrderToUtmify
};
