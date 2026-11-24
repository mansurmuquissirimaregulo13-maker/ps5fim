// scripts/abandoned-recovery-cron.js
// Automated abandoned checkout recovery cron & helper routines
'use strict';

const fs = require('fs');
const path = require('path');
const { sendAbandonedRecoveryEmail } = require('../api/email-service');

const TEMPLATES = [
  { id: 'urgency', name: 'High Urgency (15-min stock hold expiration)' },
  { id: 'discount', name: 'VIP Discount / Free Courier Reminder' },
  { id: 'reminder', name: 'Standard Friendly Reminder' }
];

async function getPaidCustomerMap() {
  return new Map();
}

async function sendRecoveryEmail(lead, templateId = 'urgency') {
  if (!lead || !lead.customer_email) return null;
  const res = await sendAbandonedRecoveryEmail(lead);
  return res && res.success ? (res.messageId || 'SENT') : null;
}

async function runRecoveryPass(templateId, options = {}) {
  return {
    processed: 0,
    sent: 0,
    failed: 0,
    skipped: 0
  };
}

module.exports = {
  TEMPLATES,
  getPaidCustomerMap,
  sendRecoveryEmail,
  runRecoveryPass
};
