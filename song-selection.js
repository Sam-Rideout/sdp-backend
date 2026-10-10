'use strict';

// Records a customer selection only. Does not create orders or launch production.
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const bounded = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 200;
const token = value => typeof value === 'string' && /^[a-f0-9]{48}$/.test(value);

function authorized(claims, now) {
  return Boolean(claims && claims.iss === 'wix' && claims.aud === 'project-x-catalog'
    && claims.purpose === 'song-selection' && bounded(claims.sub) && claims.sub.length >= 3
    && Number.isInteger(claims.iat) && Number.isInteger(claims.exp)
    && claims.iat <= now + 60 && claims.iat >= now - 180
    && claims.exp > now && claims.exp <= now + 180 && claims.exp > claims.iat
    && token(claims.jti) && token(claims.request_id)
    && bounded(claims.catalog_item_id)
    && typeof claims.px_song_id === 'string' && /^PX[0-9]{6}$/.test(claims.px_song_id));
}

function attachSongSelection(app, context) {
  const root = path.join(context.dataDir, 'song-selections');
  const locks = new Set();
  const filename = claims => path.join(root, hash(`${claims.sub}\n${claims.request_id}`) + '.json');

  app.post('/api/wix/song-selection', async (req, res, next) => {
    let lock;
    try {
      const claims = context.verifySigned(req.body && req.body.ticket);
      if (!authorized(claims, Math.floor(Date.now() / 1000))) {
        return res.status(401).json({ error: 'Song-selection authorization failed.' });
      }
      if (!(await context.consumeTicket(claims.jti))) {
        return res.status(401).json({ error: 'Song-selection authorization was already used.' });
      }
      await context.pruneOldReplayMarkers();
      // Identity, song and request are all signed by Wix backend; ignore other request fields.
      const target = filename(claims);
      if (locks.has(target)) return res.status(409).json({ error: 'Selection is being saved. Please retry.' });
      lock = target;
      locks.add(lock);
      const profile = await context.readyProfile(claims.sub);
      if (!profile) return res.status(409).json({ error: 'A current certified READY voice profile is required.' });
      let existing;
      try { existing = JSON.parse(await fs.readFile(target, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (existing) {
        if (existing.owner_member_id !== claims.sub || existing.request_id !== claims.request_id
          || existing.catalog_item_id !== claims.catalog_item_id || existing.px_song_id !== claims.px_song_id
          || existing.session_id !== profile.session_id || existing.voice_profile_id !== profile.voice_profile_id
          || existing.voice_model_id !== profile.voice_model_id || existing.model_sha256 !== profile.model_sha256
          || existing.index_sha256 !== profile.index_sha256 || existing.customer_id !== profile.customer_id
          || existing.certification_id !== profile.certification_id
          || existing.certification_sha256 !== profile.certification_sha256) {
          return res.status(409).json({ error: 'Selection request changed. Start a new selection.' });
        }
        return res.json({ ok: true, status: 'SELECTED', selection_id: existing.selection_id, px_song_id: existing.px_song_id });
      }
      const record = {
        schema_version: 'PX-SONG-SELECTION-1.0', selection_id: crypto.randomUUID(),
        status: 'SELECTED', request_id: claims.request_id,
        owner_member_id: claims.sub, catalog_item_id: claims.catalog_item_id, px_song_id: claims.px_song_id,
        customer_id: profile.customer_id, session_id: profile.session_id,
        voice_profile_id: profile.voice_profile_id, voice_model_id: profile.voice_model_id,
        model_sha256: profile.model_sha256, index_sha256: profile.index_sha256,
        certification_id: profile.certification_id, certification_sha256: profile.certification_sha256,
        selected_at: new Date().toISOString()
      };
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      const temporary = target + '.' + crypto.randomUUID() + '.tmp';
      await fs.writeFile(temporary, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      try {
        // Atomic publication without overwriting an existing request, including across workers.
        await fs.link(temporary, target);
      } catch (error) {
        if (error.code === 'EEXIST') return res.status(409).json({ error: 'Selection is being saved. Please retry.' });
        throw error;
      } finally { await fs.unlink(temporary); }
      res.json({ ok: true, status: 'SELECTED', selection_id: record.selection_id, px_song_id: record.px_song_id });
    } catch (error) { next(error); }
    finally { if (lock) locks.delete(lock); }
  });
}

module.exports = { attachSongSelection, authorized };
