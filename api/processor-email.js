// api/processor-email.js
// Generates realistic-looking synthetic emails for payment processors (Stripe, Paystack)
// so that real customer emails never leave the internal system.

'use strict';

const FALLBACK_NAMES = [
  'sipho.nkosi',
  'thabo.molefe',
  'maria.silva',
  'joao.cossa',
  'lerato.khumalo',
  'lindiwe.dlamini',
  'david.smith',
  'kevin.naidoo',
  'sarah.jones',
  'johan.botha',
  'bongani.ndlovu',
  'zanele.mthembu',
  'pieter.vandermerwe',
  'tumi.moroka',
  'kagiso.rabada'
];

const DOMAINS = ['gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com'];

const SEPARATORS = ['.', '_', ''];

/**
 * Normalizes a customer name into an email username base.
 * e.g., "Maria Silva" -> "maria.silva" or "maria_silva"
 */
function cleanName(name) {
  if (!name || typeof name !== 'string') return null;
  const normalized = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove accents
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim();

  const parts = normalized.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;

  const sep = SEPARATORS[Math.floor(Math.random() * SEPARATORS.length)];
  if (parts.length === 1) {
    return parts[0];
  }
  return parts.slice(0, 2).join(sep);
}

/**
 * Generates a realistic email for payment processor receipts.
 * @param {string} [customerName]
 * @returns {string}
 */
function generateProcessorEmail(customerName) {
  let base = cleanName(customerName);
  if (!base || base.length < 3) {
    base = FALLBACK_NAMES[Math.floor(Math.random() * FALLBACK_NAMES.length)];
  }

  // Random number between 10 and 9999
  const randNum = Math.floor(Math.random() * 9900) + 10;
  const domain = DOMAINS[Math.floor(Math.random() * DOMAINS.length)];

  return `${base}${randNum}@${domain}`;
}

module.exports = {
  generateProcessorEmail
};
