'use strict';

// Read-only PC export. Uses the existing transfer credential; never queues work.
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const FIELDS = ['customer_id', 'session_id', 'voice_profile_id', 'voice_model_id',
  'model_sha256', 'index_sha256', 'certification_id', 'certification_sha256'];

function matchesProfile(record, profile) {
  return Boolean(profile && record.owner_member_id === profile.owner_member_id
    && FIELDS.every(key => record[key] === profile[key]));
}

function validateRecord(record, filename) {
  if (!record || record.schema_version !== 'PX-SONG-SELECTION-1.0'
    || record.status !== 'SELECTED'
    || typeof record.owner_member_id !== 'string'
    || record.owner_member_id.length < 3 || record.owner_member_id.length > 200
    || !/^[a-f0-9]{48}$/.test(record.request_id)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(record.selection_id)
    || !/^PX[0-9]{6}$/.test(record.px_song_id)
    || !Number.isFinite(Date.parse(record.selected_at))
    || FIELDS.some(key => typeof record[key] !== 'string' || !record[key])
    || ['model_sha256', 'index_sha256', 'certification_sha256'].some(key => !/^[a-f0-9]{64}$/.test(record[key]))
    || filename !== hash(`${record.owner_member_id}\n${record.request_id}`) + '.json') {
    throw new Error('Stored selection evidence is invalid.');
  }
}

function attachSongSelectionTransfer(app, context) {
  const root = path.join(context.dataDir, 'song-selections');
  app.get('/api/transfer/song-selections/:memberId', context.transferAuth,
    async (req, res, next) => {
      res.set('Cache-Control', 'no-store');
      try {
        const member = req.params.memberId;
        if (typeof member !== 'string' || member.length < 3 || member.length > 200
          || member.trim() !== member || /[\x00-\x1f\x7f]/.test(member)) {
          return res.status(400).json({ error: 'Invalid member identity.' });
        }
        let entries;
        try { entries = await fs.readdir(root, { withFileTypes: true }); }
        catch (error) { if (error.code !== 'ENOENT') throw error; entries = []; }
        const files = entries.filter(entry => /^[a-f0-9]{64}\.json$/.test(entry.name));
        if (files.length > 5000) throw new Error('Selection export requires pagination before further use.');
        const records = [];
        for (const entry of files) {
          if (!entry.isFile()) throw new Error('Selection evidence must be a regular file.');
          const target = path.join(root, entry.name);
          if ((await fs.stat(target)).size > 16384) throw new Error('Stored selection evidence is too large.');
          const record = JSON.parse(await fs.readFile(target, 'utf8'));
          validateRecord(record, entry.name);
          if (record.owner_member_id === member) {
            const cancellation = await require('./wix-cancel').readCancel(context.dataDir, member, 'SELECTION', record.selection_id);
            if (!cancellation || cancellation.status === 'TOO_LATE') records.push(record);
          }
        }
        const profile = await context.readyProfile(member);
        records.sort((a, b) => b.selected_at.localeCompare(a.selected_at)
          || a.selection_id.localeCompare(b.selection_id));
        res.json({ schema_version: 'PX-SONG-SELECTION-EXPORT-1.0',
          owner_member_id: member, current_profile: profile,
          truncated: records.length > 100,
          selections: records.slice(0, 100).map(record => ({
            ...record, current_profile_matches: matchesProfile(record, profile)
          })) });
      } catch (error) { next(error); }
    });
}

module.exports = { attachSongSelectionTransfer, matchesProfile, validateRecord };
