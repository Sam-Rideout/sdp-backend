'use strict';

// Metadata bridge only. Training/certification must publish via the protected
// PC endpoint. Browser capture completion never grants READY status.
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 200;
const { publicPreparation } = require('./voice-preparation');
const STATES = new Set(['PROCESSING', 'READY', 'FAILED', 'REVOKED']);

function attachProfileStatus(app, context) {
  const { dataDir, sessionDir, readManifest, safeSessionId, verifySigned,
    consumeTicket, pruneOldReplayMarkers, transferAuth } = context;
  const root = path.join(dataDir, 'voice-profile-status');
  const filename = member => path.join(root, `${hash(member)}.json`);
  const isCustomer = manifest => (manifest.program || 'CUSTOMER') === 'CUSTOMER';

  async function ownedSessions(member) {
    let entries;
    try { entries = await fsp.readdir(sessionDir, { withFileTypes: true }); }
    catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    const sessions = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !safeSessionId(entry.name)) continue;
      // Fail on unreadable evidence rather than claiming there is no profile.
      const manifest = await readManifest(entry.name);
      if (manifest.owner_member_id === member && isCustomer(manifest)) sessions.push(manifest);
    }
    return sessions.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  }

  function validateRecord(record, manifest) {
    if (!record || record.schema_version !== 'PX-VOICE-PROFILE-STATUS-1.0'
      || !STATES.has(record.status) || record.owner_member_id !== manifest.owner_member_id
      || record.session_id !== manifest.session_id || !isCustomer(manifest)
      || manifest.status !== 'TRANSFERRED_AUDIO_DELETED') {
      throw new Error('Profile status does not match verified customer transfer evidence.');
    }
    if (record.status === 'READY' && (!text(record.voice_profile_id)
      || !text(record.voice_model_id) || !text(record.customer_id)
      || !hex(record.model_sha256) || !hex(record.index_sha256)
      || !text(record.certification_id) || !hex(record.certification_sha256))) {
      throw new Error('READY requires the certified model and index identities.');
    }
  }

  const catalog = require('./profile-catalog').createProfileCatalog({dataDir, ownedSessions, validateRecord});

  async function preparation(manifest, status, record = null) {
    if (!safeSessionId(manifest.session_id)) throw new Error('Invalid preparation session.');
    let state = null;
    try {
      state = JSON.parse(await fsp.readFile(path.join(dataDir, 'phone-training', manifest.session_id, 'state.json'), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        // Progress is optional display metadata, never profile-release authority.
        const publicView = publicPreparation(manifest, null, status, record);
        return publicView && status === 'PROCESSING'
          ? {...publicView, phase:'UNKNOWN', stage_code:'UNKNOWN', details_available:false}
          : publicView;
      }
    }
    if (status === 'READY' && state && record && state.model_id !== record.voice_model_id) state = null;
    return publicPreparation(manifest, state, status, record);
  }

  async function snapshot(member, includeReadyEvidence = false, sessionId = undefined) {
    const sessions = await ownedSessions(member);
    if (!sessions.length) return { status: 'MISSING', preparation: null, checked_at: new Date().toISOString() };
    const latest = sessionId === undefined ? sessions[0] : sessions.find(m => m.session_id === sessionId);
    if (!latest) return {status:'MISSING', preparation:null, checked_at:new Date().toISOString()};
    const record = await catalog.recordFor(member, latest);
    if (record && record.session_id === latest.session_id) {
      validateRecord(record, latest);
      const result = { status: record.status, preparation: includeReadyEvidence ? null : await preparation(latest, record.status, record), checked_at: new Date().toISOString() };
      return includeReadyEvidence && record.status === 'READY'
        ? { ...result, profile: record } : result;
    }
    if (latest.status === 'RECORDING') return { status: 'RECORDING', preparation: null, checked_at: new Date().toISOString() };
    if (['READY_FOR_TRANSFER', 'TRANSFERRED_AUDIO_DELETED'].includes(latest.status)) {
      return { status: 'PROCESSING', preparation: await preparation(latest, 'PROCESSING'), checked_at: new Date().toISOString() };
    }
    throw new Error('Unknown voice session state.');
  }

  async function hasProcessingProfile(member) {
    // Check every owned customer session. A READY profile or newer unfinished
    // capture must not hide another session that is still being prepared.
    const activePhases = new Set(['QUEUED', 'PREPARING', 'TRAINING', 'KEY_SELECTION', 'CERTIFYING', 'UNKNOWN']);
    for (const manifest of await ownedSessions(member)) {
      if (!['READY_FOR_TRANSFER', 'TRANSFERRED_AUDIO_DELETED'].includes(manifest.status)) continue;
      const record = await catalog.recordFor(member, manifest);
      if (record && record.status !== 'PROCESSING') continue;
      const progress = await preparation(manifest, 'PROCESSING', record);
      if (progress && activePhases.has(progress.phase)) return true;
    }
    return false;
  }

  app.post('/api/wix/voice-profile-status', async (req, res, next) => {
    try {
      const claims = verifySigned(req.body && req.body.ticket);
      const now = Math.floor(Date.now() / 1000);
      if (!claims || claims.iss !== 'wix' || claims.aud !== 'project-x-catalog'
        || claims.purpose !== 'voice-profile-status' || !text(claims.sub)
        || claims.sub.length < 3 || !Number.isInteger(claims.iat)
        || !Number.isInteger(claims.exp) || claims.iat > now + 60
        || claims.iat < now - 180 || claims.exp <= now || claims.exp > now + 180
        || claims.exp <= claims.iat || typeof claims.jti !== 'string'
        || !/^[a-f0-9]{48}$/.test(claims.jti)) {
        return res.status(401).json({ error: 'Profile-status authorization failed.' });
      }
      if (!(await consumeTicket(claims.jti))) {
        return res.status(401).json({ error: 'Profile-status authorization was already used.' });
      }
      await pruneOldReplayMarkers();
      // Claims identify the member; browser-supplied member IDs are ignored.
      const result = await snapshot(claims.sub);
      const profiles = await catalog.publicProfiles(claims.sub);
      const selected = await catalog.selectableProfile(claims.sub);
      const processing = await hasProcessingProfile(claims.sub);
      res.set('Cache-Control', 'no-store');
      res.json({...result, status:selected ? 'READY' : result.status,
        latest_session_status:result.status, profiles,
        has_processing_profile:processing,
        default_voice_profile_id:selected?.voice_profile_id || ''});
    } catch (error) { next(error); }
  });

  app.post('/api/transfer/sessions/:sessionId/profile-status', transferAuth,
    async (req, res, next) => {
      try {
        if (!safeSessionId(req.params.sessionId)) return res.status(404).json({ error: 'Session not found.' });
        const manifest = await readManifest(req.params.sessionId);
        if (!isCustomer(manifest) || manifest.status !== 'TRANSFERRED_AUDIO_DELETED') {
          return res.status(409).json({ error: 'A verified customer transfer is required.' });
        }
        const body = req.body || {};
        const record = {
          schema_version: 'PX-VOICE-PROFILE-STATUS-1.0',
          owner_member_id: manifest.owner_member_id, session_id: manifest.session_id,
          status: body.status, voice_profile_id: body.voice_profile_id,
          voice_model_id: body.voice_model_id, customer_id: body.customer_id,
          model_sha256: body.model_sha256, index_sha256: body.index_sha256,
          certification_id: body.certification_id,
          certification_sha256: body.certification_sha256,
          updated_at: new Date().toISOString()
        };
        try { validateRecord(record, manifest); }
        catch { return res.status(400).json({ error: 'Invalid profile status or missing certified-model evidence.' }); }
        // Every publication stays bound to its verified owned session.
        await catalog.publish(manifest.owner_member_id, manifest, record);
        res.json({ ok: true, status: record.status });
      } catch (error) {
        if (error.code === 'ENOENT') return res.status(404).json({ error: 'Session not found.' });
        next(error);
      }
    });
  require('./existing-profile-status').attachExistingProfileStatus(app, context, catalog);
  return {snapshot, readyProfile:catalog.readyProfile,
    selectableProfile:catalog.selectableProfile, profiles:catalog.records};
}

module.exports = { attachProfileStatus };
