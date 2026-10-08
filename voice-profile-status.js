'use strict';

// Metadata bridge only. Training/certification must publish via the protected
// PC endpoint. Browser capture completion never grants READY status.
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 200;
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

  async function snapshot(member) {
    const sessions = await ownedSessions(member);
    if (!sessions.length) return { status: 'MISSING' };
    const latest = sessions[0];
    let record;
    try { record = JSON.parse(await fsp.readFile(filename(member), 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (record && record.session_id === latest.session_id) {
      validateRecord(record, latest);
      return { status: record.status };
    }
    if (latest.status === 'RECORDING') return { status: 'RECORDING' };
    if (['READY_FOR_TRANSFER', 'TRANSFERRED_AUDIO_DELETED'].includes(latest.status)) {
      return { status: 'PROCESSING' };
    }
    throw new Error('Unknown voice session state.');
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
      res.json(await snapshot(claims.sub));
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
        // Only the newest customer session may change current readiness.
        const sessions = await ownedSessions(manifest.owner_member_id);
        if (!sessions.length || sessions[0].session_id !== manifest.session_id) {
          return res.status(409).json({ error: 'A newer customer recording session exists.' });
        }
        await fsp.mkdir(root, { recursive: true, mode: 0o700 });
        const target = filename(manifest.owner_member_id);
        const temporary = `${target}.${crypto.randomUUID()}.tmp`;
        await fsp.writeFile(temporary, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        try { await fsp.rename(temporary, target); }
        finally { await fsp.unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
        res.json({ ok: true, status: record.status });
      } catch (error) {
        if (error.code === 'ENOENT') return res.status(404).json({ error: 'Session not found.' });
        next(error);
      }
    });
  return { snapshot };
}

module.exports = { attachProfileStatus };
