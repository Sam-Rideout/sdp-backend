'use strict';

// Private metadata only: model assets and recordings remain on the PC.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {validateExisting, consentHash} = require('./existing-profile-status');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function createProfileCatalog({dataDir, ownedSessions, validateRecord}) {
  const displayNames = require('./profile-display-names').createDisplayNames(dataDir);
  const withdrawals = require('./profile-deletion').createProfileDeletionStore(dataDir);
  const legacy = member => path.join(dataDir, 'voice-profile-status', hash(member) + '.json');
  const folder = member => path.join(dataDir, 'voice-profile-records', hash(member));
  async function read(file) {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  async function write(file, value) {
    await fs.mkdir(path.dirname(file), {recursive:true, mode:0o700});
    const temporary = file + '.' + crypto.randomUUID() + '.tmp';
    try {
      await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', {flag:'wx', mode:0o600});
      await fs.rename(temporary, file);
    } finally { await fs.unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  }
  async function recordFor(member, manifest) {
    // Session IDs come only from verified, owned manifests.
    let record = await read(path.join(folder(member), manifest.session_id + '.json'));
    if (!record) {
      const old = await read(legacy(member));
      if (old?.session_id === manifest.session_id) record = old;
    }
    if (record) validateRecord(record, manifest);
    return record ? withdrawals.view(member, record) : record;
  }
  async function records(member) {
    const sessions = await ownedSessions(member);
    const result = [];
    for (const manifest of sessions) {
      const record = await recordFor(member, manifest);
      if (record) result.push({record, manifest,
        // A one-order consent must not become reusable through the picker.
        selectable: record.status === 'READY' &&
          (manifest.session_id === sessions[0].session_id ||
           manifest.consent?.retention_choice === 'FUTURE_PURCHASES')});
    }
    const externalFolder = path.join(folder(member), 'existing');
    let entries = [];
    try { entries = await fs.readdir(externalFolder, {withFileTypes:true}); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (entries.length > 1000) throw new Error('Existing-profile archive requires maintenance.');
    for (const entry of entries) {
      if (!/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
      if (!entry.isFile()) throw new Error('Existing profile must be a regular file.');
      const file = path.join(externalFolder, entry.name);
      if ((await fs.stat(file)).size > 16384) throw new Error('Existing profile metadata is too large.');
      let record = await read(file);
      const manifest = sessions.find(m => m.session_id === record.session_id);
      // Removed consent sessions cannot authorize any new or pending use.
      if (!manifest) continue;
      validateRecord(record, manifest); validateExisting(record, manifest);
      if (entry.name !== hash(record.voice_profile_id) + '.json') throw new Error('Existing profile storage identity differs.');
      if (manifest.consent?.retention_choice !== 'FUTURE_PURCHASES' ||
          consentHash(manifest.consent) !== record.consent_sha256) continue;
      record = await withdrawals.view(member, record);
      result.push({record, manifest, selectable:record.status === 'READY'});
    }
    const ids = result.filter(x => x.record.status === 'READY').map(x => x.record.voice_profile_id);
    if (new Set(ids).size !== ids.length) throw new Error('Duplicate certified profile identity.');
    return result;
  }
  async function readyProfile(member, profileId) {
    const all = await records(member);
    const matches = all.filter(x => x.record.status === 'READY' &&
      (profileId === undefined ? x.selectable : x.record.voice_profile_id === profileId));
    if (profileId !== undefined && matches.length !== 1) return null;
    return matches[0]?.record || null;
  }
  async function selectableProfile(member, profileId) {
    const matches = (await records(member)).filter(x => x.selectable &&
      (profileId === undefined || x.record.voice_profile_id === profileId));
    if (profileId !== undefined && matches.length !== 1) return null;
    return matches[0]?.record || null;
  }
  async function publicProfiles(member) {
    const rows = await records(member);
    const names = await displayNames.decorate(member, rows);
    return rows.map(({record:r, manifest:m, selectable}, i) => ({
      voice_profile_id: r.voice_profile_id || '',
      status:r.status, selectable,
      label:names[i]?.label || 'Setup unknown · Date unknown',
      technical_title:(()=>{const base=typeof r.display_name==='string'&&r.display_name.trim().length>0&&r.display_name.length<=120?r.display_name:'Voice profile';const d=r.recording_setup_summary;const detail=d&&d.status!=='UNKNOWN'?` | Recording setup: ${d.details}`:' | Recording setup unknown';return (base+detail).slice(0,200);})(),
      created_at:r.created_at || m.created_at, updated_at:r.updated_at,
      deletion_requested:r.deletion_requested === true,
      deletion_status:r.deletion_status || '',
      preview_available:false
    }));
  }
  async function publish(member, manifest, record) {
    validateRecord(record, manifest);
    await fs.mkdir(folder(member), {recursive:true, mode:0o700});
    const lock = path.join(folder(member), '.publish.lock');
    try { await fs.mkdir(lock); }
    catch (e) {
      if (e.code === 'EEXIST') { const busy = new Error('Profile publication is busy. Retry shortly.'); busy.status=409; throw busy; }
      throw e;
    }
    try {
      await withdrawals.assertPublishable(member, record, manifest);
      const sessions = await ownedSessions(member);
      const old = await read(legacy(member));
      if (old) {
        const prior = sessions.find(m => m.session_id === old.session_id);
        if (prior) {
          validateRecord(old, prior);
          const oldFile = path.join(folder(member), prior.session_id + '.json');
          // Never overwrite newer per-session revocation with stale legacy data.
          if (!await read(oldFile)) await write(oldFile, old);
        }
      }
      await write(path.join(folder(member), manifest.session_id + '.json'), record);
      // Preserve existing newest-session status consumers during staged rollout.
      if (sessions[0]?.session_id === manifest.session_id) await write(legacy(member), record);
    } finally { await fs.rmdir(lock); }
  }
  async function publishExisting(record) {
    return withdrawals.exclusive(record.owner_member_id, async () => {
    const sessions = await ownedSessions(record.owner_member_id);
    const manifest = sessions.find(m => m.session_id === record.session_id);
    validateRecord(record, manifest); validateExisting(record, manifest);
    if (consentHash(manifest.consent) !== record.consent_sha256) throw new Error('Existing profile consent changed.');
    await withdrawals.assertPublishable(record.owner_member_id, record, manifest);
    await write(path.join(folder(record.owner_member_id), 'existing', hash(record.voice_profile_id) + '.json'), record);
    });
  }
  return {recordFor, records, readyProfile, selectableProfile, publicProfiles, publish, publishExisting};
}

module.exports = {createProfileCatalog};
