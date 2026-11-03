'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {attachOperatorProfileDeletion} = require('../operator-profile-deletion');

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

const body = {
  customer_id: profile.customer_id,
  member_id: profile.owner_member_id,
  profile_id: profile.voice_profile_id,
  model_id: profile.voice_model_id,
  reason: 'Replace incorrect test metadata',
  confirmation: 'DELETE PXC-999999 TEST-PROFILE-001',
  operator_proof: {
    payload: {actor: 'TEST-OPERATOR'},
    signature: 'synthetic-test-signature'
  }
};

function fixture(verifyOperatorProof, rows = [{record:profile}]) {
  let requests = 0;
  const routes = new Map();

  const app = {
    post(url, ...handlers) {
      routes.set(url, handlers);
    }
  };

  const store = {
    async request(member, record, authority) {
      requests++;
      return {
        request_id: 'synthetic-request',
        customer_id: record.customer_id,
        voice_profile_id: record.voice_profile_id,
        status: 'REQUESTED',
        retention_authority: authority
      };
    }
  };

  attachOperatorProfileDeletion(app, {
    transferAuth: (req, res, next) => next(),
    verifyOperatorProof,
    profiles: async () => rows,
    store
  });

  async function invoke(requestBody) {
    const handlers = routes.get(
      '/api/transfer/operator-profiles/request-deletion'
    );
    assert.equal(handlers.length, 2);

    let result;
    let failure;

    const res = {
      set() { return this; },
      json(value) { result = value; return this; }
    };

    await handlers[1](
      {body: requestBody},
      res,
      error => { failure = error; }
    );

    return {result, failure};
  }

  return {invoke, count:() => requests};
}

test('missing authenticated operator blocks deletion request', async () => {
  const f = fixture(async () => null);
  const r = await f.invoke(body);

  assert.equal(r.failure.status, 403);
  assert.equal(f.count(), 0);
});

test('wrong customer blocks deletion request', async () => {
  const f = fixture(async () => 'TEST-OPERATOR');
  const r = await f.invoke({...body, customer_id:'PXC-999998'});

  assert.ok(r.failure);
  assert.equal(f.count(), 0);
});

test('wrong model blocks deletion request', async () => {
  const f = fixture(async () => 'TEST-OPERATOR');
  const r = await f.invoke({...body, model_id:'OTHER-MODEL'});

  assert.ok(r.failure);
  assert.equal(f.count(), 0);
});

test('exact authenticated request reaches synthetic store', async () => {
  const f = fixture(async () => 'TEST-OPERATOR');
  const r = await f.invoke(body);

  assert.equal(r.failure, undefined);
  assert.equal(r.result.status, 'REQUESTED');
  assert.equal(r.result.physical_deletion_verified, false);
  assert.equal(f.count(), 1);
});

test('unrelated existing authorization is rejected', async () => {
  let routes;
  const app = {
    post(url, ...handlers) { routes = handlers; }
  };
  attachOperatorProfileDeletion(app, {
    transferAuth: (req, res, next) => next(),
    verifyOperatorProof: async () => 'TEST-OPERATOR',
    profiles: async () => [{record:profile}],
    store: {
      request: async () => ({
        retention_authority: {basis:'ACCEPTED_DELETE_AFTER_ORDER'}
      })
    }
  });

  let failure;
  await routes[1](
    {body},
    {set(){return this;},json(){throw Error('Unexpected success');}},
    error => {failure = error;}
  );

  assert.equal(failure.status, 409);
});
