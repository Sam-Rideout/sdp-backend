'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

process.env.WIX_HANDOFF_SECRET = 'test-handoff-secret-that-is-longer-than-thirty-two-bytes';
process.env.VOICE_TRANSFER_TOKEN = 'test-transfer-token-that-is-longer-than-thirty-two-bytes';
process.env.VOICE_CONSENT_APPROVED = 'true';
const testRoot = fsSync.mkdtempSync(path.join(os.tmpdir(), 'px-voice-capture-api-test-'));
process.env.VOICE_DATA_DIR = path.join(testRoot, 'data');
const configPath = path.join(testRoot, 'capture-sections.json');
const originalConfig = JSON.parse(fsSync.readFileSync(path.join(__dirname, '..', 'config', 'capture-sections.json'), 'utf8'));
originalConfig.consent_version = 'test-consent-v1';
originalConfig.consent_notice = originalConfig.consent_notice.replace('DRAFT — ', '');
for (const section of originalConfig.sections) {
  if (!section.instructions) section.instructions = 'Automated test prompt.';
}
fsSync.writeFileSync(configPath, `${JSON.stringify(originalConfig, null, 2)}\n`);
process.env.VOICE_SECTION_CONFIG = configPath;
const { app, sign } = require('../server');
let server;
let base;
let cookie;

async function postTicket() {
  const now = Math.floor(Date.now() / 1000);
  const ticket = sign({
    iss: 'wix', aud: 'project-x-voice-capture', purpose: 'voice-capture-access',
    sub: 'test-member-001', iat: now, exp: now + 120, jti: crypto.randomBytes(24).toString('hex')
  });
  const response = await fetch(`${base}/api/session/exchange`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ ticket })
  });
  assert.equal(response.status, 200);
  const setCookie = response.headers.get('set-cookie');
  assert.ok(setCookie);
  cookie = setCookie.split(';', 1)[0];
  return ticket;
}

test('authenticated member saves separate takes and transfer verification gates Render deletion', async t => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(testRoot, { recursive: true, force: true });
  });

  const ticket = await postTicket();
  const replay = await fetch(`${base}/api/session/exchange`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ ticket })
  });
  assert.equal(replay.status, 401, 'handoff tickets are one-use');

  const config = await (await fetch(`${base}/api/config`)).json();
  const createdResponse = await fetch(`${base}/api/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base, cookie },
    body: JSON.stringify({ consent: true, consent_version: config.consent_version })
  });
  assert.equal(createdResponse.status, 201);
  const { session } = await createdResponse.json();
  assert.equal(session.consent.accepted, true);

  const uploadedClips = [];
  for (let section = 1; section <= 8; section += 1) {
    const audio = Buffer.from(`small test audio bytes for section ${section}`);
    const form = new FormData();
    form.append('section', String(section));
    form.append('duration_seconds', '2.5');
    form.append('audio', new Blob([audio], { type: 'audio/webm' }), `take-${section}.webm`);
    const uploadedResponse = await fetch(`${base}/api/sessions/${session.session_id}/clips`, {
      method: 'POST', headers: { origin: base, cookie }, body: form
    });
    assert.equal(uploadedResponse.status, 201);
    const uploaded = await uploadedResponse.json();
    assert.equal(uploaded.clip.take, 1);
    assert.equal(uploaded.clip.sha256, crypto.createHash('sha256').update(audio).digest('hex'));
    uploadedClips.push({ ...uploaded.clip, audio });
  }

  const completeResponse = await fetch(`${base}/api/sessions/${session.session_id}/complete`, {
    method: 'POST', headers: { origin: base, cookie }
  });
  assert.equal(completeResponse.status, 200);

  const auth = { authorization: `Bearer ${process.env.VOICE_TRANSFER_TOKEN}` };
  const transferResponse = await fetch(`${base}/api/transfer/sessions/${session.session_id}`, { headers: auth });
  assert.equal(transferResponse.status, 200);
  const transfer = await transferResponse.json();
  const uploaded = uploadedClips[0];
  const localCopy = await fetch(`${base}/api/transfer/sessions/${session.session_id}/clips/${uploaded.clip_id}`, { headers: auth });
  assert.equal(localCopy.status, 200);
  assert.deepEqual(Buffer.from(await localCopy.arrayBuffer()), uploaded.audio);

  const blockedDelete = await fetch(`${base}/api/transfer/sessions/${session.session_id}/confirm`, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ manifest_sha256: transfer.manifest_sha256, files: [] })
  });
  assert.equal(blockedDelete.status, 400, 'Render audio is retained if the local verification list is incomplete');

  const confirmed = await fetch(`${base}/api/transfer/sessions/${session.session_id}/confirm`, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ manifest_sha256: transfer.manifest_sha256, files: uploadedClips.map(({ clip_id, sha256 }) => ({ clip_id, sha256 })) })
  });
  assert.equal(confirmed.status, 200);
  assert.equal((await confirmed.json()).status, 'TRANSFERRED_AUDIO_DELETED');

  const missing = await fetch(`${base}/api/transfer/sessions/${session.session_id}/clips/${uploaded.clip_id}`, { headers: auth });
  assert.equal(missing.status, 410);
});
