'use strict';

// Operator deletion bridge.
// Not active until explicitly registered with authenticated PX Admin proof.

const {
  validateOperatorDeletion
} = require('./operator-deletion-authority');

function attachOperatorProfileDeletion(app, context) {
  const {
    transferAuth,
    verifyOperatorProof,
    profiles,
    store
  } = context;

  if (typeof transferAuth !== 'function' ||
      typeof verifyOperatorProof !== 'function' ||
      typeof profiles !== 'function' ||
      !store ||
      typeof store.request !== 'function') {
    throw new Error(
      'Operator deletion authentication dependencies are missing.'
    );
  }

  app.post(
    '/api/transfer/operator-profiles/request-deletion',
    transferAuth,
    async (req, res, next) => {
      try {
        const body = req.body || {};

        // Reject incomplete requests before profile lookup.
        // Do not consume a valid signed proof at this stage.
        if (!body.operator_proof ||
            typeof body.member_id !== 'string' ||
            body.member_id.length < 3 ||
            typeof body.customer_id !== 'string' ||
            typeof body.profile_id !== 'string' ||
            typeof body.model_id !== 'string') {
          const error = new Error(
            'Complete signed operator authorization is required.'
          );
          error.status = 403;
          throw error;
        }

        const rows = await profiles(body.member_id);

        const matches = rows.filter(({record}) =>
          record.owner_member_id === body.member_id &&
          record.customer_id === body.customer_id &&
          record.voice_profile_id === body.profile_id
        );

        if (matches.length !== 1) {
          const error = new Error(
            'Exactly one owned profile is required.'
          );
          error.status = 409;
          throw error;
        }

        const selected = matches[0].record;

        if (selected.voice_model_id !== body.model_id ||
            selected.status !== 'READY' ||
            !selected.session_id ||
            !selected.certification_id ||
            !/^[a-f0-9]{64}$/.test(
              selected.certification_sha256 || ''
            )) {
          const error = new Error(
            'Selected certified profile identity differs.'
          );
          error.status = 409;
          throw error;
        }

        // The actor must come from verified Admin proof,
        // never from the submitted request body.
        const actor = await verifyOperatorProof(req);

        if (typeof actor !== 'string' ||
            !actor.trim() ||
            actor.length > 200) {
          const error = new Error(
            'Authenticated operator authorization is required.'
          );
          error.status = 403;
          throw error;
        }

        const authority = validateOperatorDeletion(
          {...body, actor},
          matches[0].record
        );

        // The deletion store creates the durable REQUESTED record.
        // Physical deletion remains a separate, verified operation.
        const deletion = await store.request(
          body.member_id,
          matches[0].record,
          authority
        );

        // Never silently reuse an unrelated prior deletion request.
        if (deletion.retention_authority?.basis !==
            'PX_ADMIN_OPERATOR' ||
            deletion.retention_authority.actor !== actor) {
          const error = new Error(
            'Existing deletion authorization differs.'
          );
          error.status = 409;
          throw error;
        }

        res.set('Cache-Control', 'no-store');

        res.json({
          ok: true,
          request_id: deletion.request_id,
          customer_id: deletion.customer_id,
          voice_profile_id: deletion.voice_profile_id,
          status: deletion.status,
          account_deleted: false,
          physical_deletion_verified: false
        });
      } catch (error) {
        next(error);
      }
    }
  );
}

module.exports = {attachOperatorProfileDeletion};
