'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const SCHEMA = 'PX-WIX-CUSTOMER-IDENTITY-1.0';

function validate(value, member, email) {
  if (!value || value.schema_version !== SCHEMA || value.member_id !== member ||
      !/^[A-Za-z0-9_-]{3,200}$/.test(member || '') ||
      typeof value.email !== 'string' || value.email !== value.email.trim().toLowerCase() ||
      value.email !== email || value.email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email)) {
    throw new Error('Customer identity does not match the signed Wix member.');
  }
  for (const key of ['first_name', 'last_name']) {
    if (typeof value[key] !== 'string' ||
        value[key] !== value[key].trim() || value[key].length > 100 || /[\u0000-\u001f\u007f]/.test(value[key])) {
      throw new Error('Customer profile names contain invalid characters or are too long.');
    }
  }
  return {schema_version: SCHEMA, member_id: member, email: value.email,
    first_name: value.first_name, last_name: value.last_name};
}

function createIdentityStore(dataDir) {
  const directory = path.join(dataDir, 'customer-identities');
  const file = member => {
    if (typeof member !== 'string' || !/^[A-Za-z0-9_-]{3,200}$/.test(member)) throw new Error('Invalid member identity.');
    return path.join(directory, crypto.createHash('sha256').update(member).digest('hex') + '.json');
  };
  return {
    // Called only after server.js verifies and consumes the one-use Wix ticket.
    async recordVerifiedClaims(claims) {
      if (claims.customer_identity === undefined) return; // Legacy tickets remain usable.
      const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
      const value = validate(claims.customer_identity, claims.sub, email);
      await fs.mkdir(directory, {recursive: true, mode: 0o700});
      const target = file(claims.sub), temporary = target + '.' + crypto.randomUUID() + '.tmp';
      try {
        await fs.writeFile(temporary, JSON.stringify(value) + '\n', {flag: 'wx', mode: 0o600});
        await fs.rename(temporary, target);
      } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    },
    async forTransfer(member) {
      let raw;
      try { raw = await fs.readFile(file(member), 'utf8'); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      const value = JSON.parse(raw);
      return validate(value, member, value.email);
    }
  };
}

module.exports = {createIdentityStore, validate};
