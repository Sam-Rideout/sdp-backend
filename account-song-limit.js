'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const MESSAGE = 'You already have a song waiting or processing. Please wait until it finishes before creating another.';
const TERMINAL = new Set(['COMPLETED', 'REJECTED', 'TECHNICAL_FAILURE', 'CANCELLED', 'REFUNDED', 'PAYMENT_FAILED']);
const ACTIVE = new Set(['READY', 'QUEUED', 'PROCESSING']);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function gateError(code, message, status = 409) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  throw error;
}
async function read(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function createAccountSongGate(dataDir) {
  const root = path.join(dataDir, 'song-commits');
  const lockRoot = path.join(dataDir, 'song-account-locks');
  // A shared-disk lock serializes admission across tabs and backend instances.
  // Never expire a lock by age: an interrupted save must not admit a duplicate.
  async function exclusive(owner, action) {
    await fs.mkdir(lockRoot, {recursive:true, mode:0o700});
    const lock = path.join(lockRoot, hash(owner) + '.lock');
    try { await fs.mkdir(lock); }
    catch (error) {
      if (error.code === 'EEXIST') gateError('SONG_REQUEST_IN_PROGRESS',
        'A song request is being saved for your account. Refresh your orders before trying again.');
      throw error;
    }
    try { return await action(); }
    finally { await fs.rmdir(lock); }
  }
  async function findActive(owner, excludeSelection = '') {
    const {readCancel} = require('./wix-cancel');
    const raw = await read(path.join(dataDir, 'order-status', hash(owner) + '.json'));
    const snapshot = raw && require('./wix-orders').validateSnapshot(raw);
    if (snapshot && (snapshot.owner_member_id !== owner || snapshot.truncated)) {
      gateError('SONG_STATUS_UNAVAILABLE', 'Your current song status needs review. Please contact Project X before creating another song.', 503);
    }
    const orders = snapshot ? snapshot.orders : [];
    async function cancellation(selectionId, orderId) {
      const selection = selectionId ? await readCancel(dataDir, owner, 'SELECTION', selectionId) : null;
      const order = orderId ? await readCancel(dataDir, owner, 'ORDER', orderId) : null;
      const states = [selection?.status, order?.status];
      // A confirmed cancellation is stronger evidence than an older pending command.
      if (states.includes('CANCELLED')) return 'CANCELLED';
      if (states.includes('REQUESTED')) return 'REQUESTED';
      return '';
    }
    for (const order of orders) {
      if (excludeSelection && order.selection_id === excludeSelection) continue;
      const cancelled = await cancellation(order.selection_id, order.order_id);
      if (cancelled === 'CANCELLED') continue;
      if (cancelled === 'REQUESTED' || ACTIVE.has(order.order_status)) return true;
      if (!TERMINAL.has(order.order_status)) gateError('SONG_STATUS_UNAVAILABLE', 'Your current song status could not be confirmed.', 503);
    }
    let files;
    try { files = await fs.readdir(root); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    files = files.filter(name => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.json$/.test(name));
    if (files.length > 5000) gateError('SONG_STATUS_UNAVAILABLE', 'Song request history needs Project X review.', 503);
    for (const name of files) {
      const record = await read(path.join(root, name));
      if (!record) gateError('SONG_STATUS_UNAVAILABLE', 'Song request status could not be confirmed.', 503);
      if (record.owner_member_id !== owner || record.selection_id === excludeSelection) continue;
      if (record.schema_version !== 'PX-CREATE-SONG-1.0' || name !== record.selection_id + '.json'
          || !['REQUESTED', 'WORKING', 'DONE', 'CANCELLED', 'NEEDS_ATTENTION'].includes(record.state)) {
        gateError('SONG_STATUS_UNAVAILABLE', 'Song request status needs Project X review.', 503);
      }
      const cancelled = await cancellation(record.selection_id, record.order_id);
      if (cancelled === 'CANCELLED') continue;
      if (cancelled === 'REQUESTED') return true;
      if (record.state === 'CANCELLED') continue;
      const linked = orders.filter(order => order.selection_id === record.selection_id
        || record.order_id && order.order_id === record.order_id);
      if (linked.length > 1 || linked.some(order => record.order_id && order.order_id !== record.order_id)) {
        gateError('SONG_STATUS_UNAVAILABLE', 'Song request identity needs Project X review.', 503);
      }
      if (linked.length === 1 && TERMINAL.has(linked[0].order_status)) continue;
      // DONE means handoff finished; it does not prove that audio processing finished.
      // Missing status and NEEDS_ATTENTION remain blocked until resolved.
      return true;
    }
    return false;
  }
  async function assertAvailable(owner, selectionId) {
    if (await findActive(owner, selectionId)) gateError('ACTIVE_SONG_LIMIT', MESSAGE);
  }
  return {exclusive, findActive, assertAvailable};
}
module.exports = {createAccountSongGate, MESSAGE};
