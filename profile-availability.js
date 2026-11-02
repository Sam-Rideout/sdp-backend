'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const SCHEMA = 'PX-PROFILE-AVAILABILITY-1.0';
const MAX_AGE_MS = 5 * 60 * 1000;

const hash = value =>
  crypto.createHash('sha256').update(value).digest('hex');

const hex = value =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

const identity = value =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 200 &&
  value.trim() === value &&
  !/[\x00-\x1f\x7f]/.test(value);

const utcTimestamp = value =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

function createProfileAvailability(dataDir) {
  const root = path.join(dataDir, 'profile-availability');

  function filename(profileId) {
    return path.join(root, hash(profileId) + '.json');
  }

  function matches(report, profile) {
    return Boolean(
      report &&
      identity(report.owner_member_id) &&
      identity(report.voice_profile_id) &&
      identity(report.voice_model_id) &&
      identity(report.certification_id) &&
      hex(report.model_sha256) &&
      hex(report.index_sha256) &&
      hex(report.certification_sha256) &&
      report.schema_version === SCHEMA &&
      report.voice_profile_id === profile.voice_profile_id &&
      report.voice_model_id === profile.voice_model_id &&
      report.owner_member_id === profile.owner_member_id &&
      report.model_sha256 === profile.model_sha256 &&
      report.index_sha256 === profile.index_sha256 &&
      report.certification_id === profile.certification_id &&
      report.certification_sha256 === profile.certification_sha256
    );
  }

  async function available(profile) {
    if (!profile || profile.status !== 'READY') return false;

    let report;
    try {
      report = JSON.parse(
        await fs.readFile(filename(profile.voice_profile_id), 'utf8')
      );
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }

    if (!matches(report, profile)) return false;
    if (report.available !== true) return false;
    if (!hex(report.model_sha256) || !hex(report.index_sha256)) return false;

    if (!utcTimestamp(report.checked_at)) return false;
    const checked = Date.parse(report.checked_at);
    if (!Number.isFinite(checked)) return false;

    const age = Date.now() - checked;
    return age >= 0 && age <= MAX_AGE_MS;
  }

  async function publish(profile, report) {
    if (!matches(report, profile)) {
      throw new Error('Availability report does not match certified profile.');
    }

    if (typeof report.available !== 'boolean') {
      throw new Error('Invalid availability status.');
    }

    if (!utcTimestamp(report.checked_at)) throw new Error('Availability timestamp is invalid.');
    const checked = Date.parse(report.checked_at);
    if (!Number.isFinite(checked) ||
        Math.abs(Date.now() - checked) > 60000) {
      throw new Error('Availability timestamp is invalid.');
    }

    await fs.mkdir(root, {recursive:true, mode:0o700});

    const target = filename(profile.voice_profile_id);
    const temporary = target + '.' + crypto.randomUUID() + '.tmp';

    try {
      await fs.writeFile(temporary, JSON.stringify(report) + '\n',
        {flag:'wx', mode:0o600});
      await fs.rename(temporary, target);
    } finally {
      await fs.unlink(temporary).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }

  return {available, publish, matches};
}

module.exports = {createProfileAvailability, SCHEMA, MAX_AGE_MS};
