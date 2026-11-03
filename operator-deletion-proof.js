'use strict';

const crypto = require('node:crypto');

const FIELDS = [
  'actor',
  'confirmation',
  'customer_id',
  'issued_at',
  'member_id',
  'model_id',
  'nonce',
  'profile_id',
  'reason'
];

function deny() {
  const error = new Error('Operator deletion proof is invalid.');
  error.status = 403;
  throw error;
}

function canonical(payload) {
  if (!payload || typeof payload !== 'object' ||
      Array.isArray(payload)) deny();

  if (Object.keys(payload).sort().join('|') !==
      FIELDS.join('|')) deny();

  const ordered = {};

  for (const field of FIELDS) {
    ordered[field] = payload[field];
  }

  return JSON.stringify(ordered);
}

function verifyProof(proof, body, secret, now = Date.now()) {
  if (!proof || typeof proof !== 'object' ||
      Array.isArray(proof) ||
      typeof secret !== 'string' ||
      Buffer.byteLength(secret) < 32) deny();

  if (!proof.payload ||
      typeof proof.signature !== 'string') deny();

  const payload = proof.payload;

  if (!payload ||
      !Number.isSafeInteger(payload.issued_at) ||
      Math.abs(now - payload.issued_at * 1000) > 120000 ||
      !/^[a-f0-9]{48}$/.test(payload.nonce || '') ||
      !/^[a-f0-9]{64}$/.test(proof.signature || '')) {
    deny();
  }

  const message = canonical(payload);

  const expected = crypto
    .createHmac('sha256', secret)
    .update(message)
    .digest('hex');

  if (!crypto.timingSafeEqual(
    Buffer.from(expected, 'hex'),
    Buffer.from(proof.signature, 'hex')
  )) deny();

  for (const field of [
    'customer_id',
    'member_id',
    'profile_id',
    'model_id',
    'reason',
    'confirmation'
  ]) {
    if (payload[field] !== body?.[field]) deny();
  }

  if (typeof payload.actor !== 'string' ||
      !payload.actor.trim()) deny();

  return {
    actor: payload.actor,
    nonce: payload.nonce,
    issued_at: payload.issued_at
  };
}

module.exports = {canonical, verifyProof};
