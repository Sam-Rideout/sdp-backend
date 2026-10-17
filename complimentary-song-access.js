'use strict';
const fs = require('node:fs');
const path = require('node:path');
const POLICY = 'PX-COMPLIMENTARY-SONG-ACCOUNTS-1.0';
const AUTHORIZATION = 'PX-COMPLIMENTARY-SONG-AUTHORIZATION-1.0';
const normalizeEmail = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
function validatePolicy(policy) {
  if (!policy || policy.schema_version !== POLICY || typeof policy.enabled !== 'boolean' ||
      !Array.isArray(policy.accounts) || policy.accounts.length > 100) throw new Error('Invalid complimentary song policy.');
  const ids = new Set(), members = new Set(), emails = new Set();
  for (const a of policy.accounts) {
    if (!a || typeof a.customer_id !== 'string' || a.customer_id.length !== 10 || !/^PXC-\d{6}$/.test(a.customer_id) ||
        typeof a.wix_member_id !== 'string' || a.wix_member_id !== a.wix_member_id.trim() || !/^[a-zA-Z0-9_-]{3,200}$/.test(a.wix_member_id) ||
        typeof a.email !== 'string' || a.email !== normalizeEmail(a.email) || a.email.length > 254 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.email) ||
        typeof a.complimentary_processing_approved !== 'boolean' ||
        typeof a.test_email_delivery_approved !== 'boolean' || typeof a.allow_legacy_commands !== 'boolean' ||
        ids.has(a.customer_id) || members.has(a.wix_member_id) || emails.has(a.email)) throw new Error('Invalid or ambiguous complimentary song account.');
    ids.add(a.customer_id); members.add(a.wix_member_id); emails.add(a.email);
  }
  return policy.enabled ? policy.accounts.filter(a => a.complimentary_processing_approved && a.test_email_delivery_approved) : [];
}
function createAccess(file = path.join(__dirname, 'config', 'complimentary-song-accounts.json')) {
  const accounts = () => {
    if (fs.statSync(file).size > 65536) throw new Error('Complimentary song policy is oversized.');
    return validatePolicy(JSON.parse(fs.readFileSync(file, 'utf8')));
  };
  return {
    memberAllowed(memberId) { return accounts().some(a => a.wix_member_id === memberId); },
    account(memberId, email) { return accounts().find(a => a.wix_member_id === memberId && a.email === normalizeEmail(email)) || null; }
  };
}
function evidence(account) {
  return {schema_version:AUTHORIZATION,policy:POLICY,customer_id:account.customer_id,
    wix_member_id:account.wix_member_id,email:account.email};
}
module.exports = {createAccess, validatePolicy, evidence, POLICY, AUTHORIZATION};
