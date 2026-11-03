'use strict';

const {
  verifyProof
} = require('./operator-deletion-proof');

const {
  createReplayGuard
} = require('./operator-deletion-replay');

function createOperatorDeletionAuth(dataDir, secret) {
  if (typeof secret !== 'string' ||
      Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error(
      'Separate operator deletion signing secret is required.'
    );
  }

  const replay = createReplayGuard(dataDir);

  return async function verifyOperatorProof(req) {
    const proof = req.body?.operator_proof;

    // Signature, expiration and exact request identity
    // must all pass before the nonce is consumed.
    const verified = verifyProof(
      proof,
      req.body,
      secret
    );

    // An authorization can be used only once.
    await replay.consume(verified.nonce);

    // The actor comes from the signed proof,
    // never from the untrusted request body.
    return verified.actor;
  };
}

module.exports = {createOperatorDeletionAuth};
