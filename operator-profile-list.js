'use strict';

// Read-only profile discovery for the local PX Admin operator.
// This module does not authorize or request deletion.

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function attachOperatorProfileList(app, context) {
  const { transferAuth, profiles } = context;

  if (typeof transferAuth !== 'function' ||
      typeof profiles !== 'function') {
    throw new Error('Operator profile listing dependencies are missing.');
  }

  app.post(
    '/api/transfer/operator-profiles/lookup',
    transferAuth,
    async (req, res, next) => {
      try {
        const body = req.body || {};
        const member = body.member_id;
        const customer = body.customer_id;

        if (typeof member !== 'string' ||
            member.length < 3 ||
            member.length > 200 ||
            member.trim() !== member ||
            /[\x00-\x1f\x7f]/.test(member) ||
            !/^PXC-\d{6}$/.test(customer || '')) {
          fail('Exact member and customer identities are required.');
        }

        const rows = await profiles(member);

        const result = rows
          .filter(({ record }) =>
            record.owner_member_id === member &&
            record.customer_id === customer
          )
          .map(({ record }) => ({
            customer_id: record.customer_id,
            owner_member_id: record.owner_member_id,
            voice_profile_id: record.voice_profile_id,
            voice_model_id: record.voice_model_id,
            session_id: record.session_id,
            status: record.status,
            deletion_requested: record.deletion_requested === true,
            deletion_status: record.deletion_status || null,
            certification_id: record.certification_id || null,
            certification_sha256: record.certification_sha256 || null
          }));

        if (new Set(result.map(r => r.voice_profile_id)).size !==
            result.length) {
          fail('Duplicate profile identities.', 409);
        }

        res.set('Cache-Control', 'no-store');

        res.json({
          ok: true,
          customer_id: customer,
          member_id: member,
          profiles: result
        });
      } catch (error) {
        next(error);
      }
    }
  );
}

module.exports = { attachOperatorProfileList };
