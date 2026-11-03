'use strict';

const CUSTOMER = /^PXC-\d{6}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function fail(message) {
  const error = new Error(message);
  error.status = 403;
  throw error;
}

function bounded(value) {
  return typeof value === 'string' &&
    value.length >= 3 &&
    value.length <= 200 &&
    value.trim() === value &&
    !/[\x00-\x1f\x7f]/.test(value);
}

function validateOperatorDeletion(body, profile) {
  if (!body || !profile) {
    fail('Exact operator request and profile are required.');
  }

  const {
    customer_id,
    member_id,
    profile_id,
    model_id,
    actor,
    reason,
    confirmation
  } = body;

  if (!CUSTOMER.test(customer_id || '') ||
      !bounded(member_id) ||
      !bounded(profile_id) ||
      !bounded(model_id) ||
      !bounded(actor) ||
      !bounded(reason)) {
    fail('Operator deletion request is incomplete.');
  }

  if (reason.length > 500) {
    fail('Operator deletion reason is too long.');
  }

  if (profile.customer_id !== customer_id ||
      profile.owner_member_id !== member_id ||
      profile.voice_profile_id !== profile_id ||
      profile.voice_model_id !== model_id ||
      profile.status !== 'READY' ||
      !bounded(profile.session_id) ||
      !bounded(profile.certification_id) ||
      !SHA256.test(profile.certification_sha256 || '')) {
    fail('Exact certified profile ownership is required.');
  }

  const expected = `DELETE ${customer_id} ${profile_id}`;

  if (confirmation !== expected) {
    fail('Explicit profile deletion confirmation is required.');
  }

  return Object.freeze({
    basis: 'PX_ADMIN_OPERATOR',
    actor,
    reason,
    customer_id,
    member_id,
    profile_id,
    model_id,
    session_id: profile.session_id,
    approved_at: new Date().toISOString(),
    account_deletion: false
  });
}

module.exports = { validateOperatorDeletion };
