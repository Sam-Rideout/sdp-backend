'use strict';

// Capture access is independent of complimentary order/payment authority.
function linkedCustomerAccess(req, config) {
  return config.customer_capture_scope === 'LINKED_CUSTOMERS'
    && config.customer_intake_release_approved === true
    && typeof req.memberId === 'string'
    && Array.isArray(config.linked_customer_member_ids)
    && config.linked_customer_member_ids.every(id => typeof id === 'string' && /^[a-zA-Z0-9_-]{3,200}$/.test(id))
    && config.linked_customer_member_ids.includes(req.memberId);
}

function suppliedEvidence(manifest) {
  if (manifest.training_source !== 'SUPPLIED_RECORDING') return null;
  const clips = Object.values(manifest.sections || {}).flatMap(s => s.takes || []);
  const approval = manifest.supplied_recording_approval;
  if (clips.length !== 1 || clips[0].section !== 1 || clips[0].take !== 1
      || clips[0].purpose !== 'SUPPLIED_TRAINING_RECORDING'
      || clips[0].excluded_from_training !== false
      || !/^[a-f0-9]{64}$/.test(clips[0].sha256 || '')
      || !approval || approval.accepted !== true
      || approval.member_id !== manifest.owner_member_id
      || approval.session_id !== manifest.session_id
      || approval.consent_version !== manifest.consent?.version
      || approval.source_sha256 !== clips[0].sha256
      || !approval.accepted_at
      || (manifest.special_message?.takes || []).length) {
    throw new Error('The exact supplied recording needs approval from its signed-in owner.');
  }
  return clips;
}

module.exports = {linkedCustomerAccess, suppliedEvidence};
