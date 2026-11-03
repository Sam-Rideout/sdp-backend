'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateOperatorDeletion
} = require('../operator-deletion-authority');

const profile = {
  customer_id: 'PXC-999999',
  owner_member_id: 'synthetic-member',
  voice_profile_id: 'TEST-PROFILE-001',
  voice_model_id: 'TEST-MODEL-001',
  session_id: 'TEST-SESSION-001',
  status: 'READY',
  certification_id: 'TEST-CERT-001',
  certification_sha256: 'a'.repeat(64)
};

const request = {
  customer_id: profile.customer_id,
  member_id: profile.owner_member_id,
  profile_id: profile.voice_profile_id,
  model_id: profile.voice_model_id,
  actor: 'SYNTHETIC-OPERATOR',
  reason: 'Replace incorrect test metadata',
  confirmation: 'DELETE PXC-999999 TEST-PROFILE-001'
};

test('exact certified profile passes validation', () => {
  const result = validateOperatorDeletion(request, profile);

  assert.equal(result.basis, 'PX_ADMIN_OPERATOR');
  assert.equal(result.profile_id, profile.voice_profile_id);
  assert.equal(result.account_deletion, false);
});

test('cross-customer deletion is rejected', () => {
  assert.throws(() =>
    validateOperatorDeletion(
      {...request, customer_id: 'PXC-999998'},
      profile
    )
  );
});

test('cross-member deletion is rejected', () => {
  assert.throws(() =>
    validateOperatorDeletion(
      {...request, member_id: 'another-member'},
      profile
    )
  );
});

test('wrong voice model is rejected', () => {
  assert.throws(() =>
    validateOperatorDeletion(
      {...request, model_id: 'OTHER-MODEL'},
      profile
    )
  );
});

test('missing explicit confirmation is rejected', () => {
  assert.throws(() =>
    validateOperatorDeletion(
      {...request, confirmation: ''},
      profile
    )
  );
});

test('missing operator or reason is rejected', () => {
  assert.throws(() =>
    validateOperatorDeletion({...request, actor: ''}, profile)
  );

  assert.throws(() =>
    validateOperatorDeletion({...request, reason: ''}, profile)
  );
});

test('revoked profile is rejected', () => {
  assert.throws(() =>
    validateOperatorDeletion(
      request,
      {...profile, status: 'REVOKED'}
    )
  );
});
