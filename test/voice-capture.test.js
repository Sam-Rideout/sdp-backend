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
process.env.VOICE_CUSTOMER_CAPTURE_APPROVED = 'true';
const testRoot = fsSync.mkdtempSync(path.join(os.tmpdir(), 'px-voice-capture-api-test-'));
process.env.VOICE_DATA_DIR = path.join(testRoot, 'data');
const configPath = path.join(testRoot, 'capture-sections.json');
const originalConfig = JSON.parse(fsSync.readFileSync(path.join(__dirname, '..', 'config', 'capture-sections.json'), 'utf8'));
originalConfig.consent_version = 'test-consent-v1';
originalConfig.consent_notice = originalConfig.consent_notice.replace('DRAFT — ', '');
originalConfig.prompts_approved = true;
for (const section of originalConfig.sections) {
  if (!section.instructions) section.instructions = 'Automated test prompt.';
}
fsSync.writeFileSync(configPath, `${JSON.stringify(originalConfig, null, 2)}\n`);
process.env.VOICE_SECTION_CONFIG = configPath;
const { app, sign } = require('../server');
let server;
let base;
let cookie;

test('recording page shows exactly three unselected consent checkboxes', () => {
  const page = fsSync.readFileSync(path.join(__dirname, '..', 'public', 'voice-capture.html'), 'utf8');
  const customerPanel = page.match(/<div id="customerConsentPanel">([\s\S]*?)<\/div>\s*<div id="pilotConsentPanel"/)[1];
  const boxes = [...customerPanel.matchAll(/<input\b[^>]*type="checkbox"[^>]*>/g)];
  assert.equal(boxes.length, 3);
  assert.ok(boxes.every(([markup]) => !/\bchecked\b/i.test(markup)));
  assert.match(page, /id="pilotUnderstood"/);
  assert.match(page, /id="pilotConsentPanel" hidden/);
  assert.match(page, /href="\/pilot-consent"/);
  const wixHandoff = fsSync.readFileSync(path.join(__dirname, '..', 'wix', 'voiceCapture.web.js'), 'utf8');
  assert.match(wixHandoff, /email:\s*typeof member\.loginEmail/);
  assert.match(page, /id="deleteAfterOrder"/);
  assert.match(page, /id="futurePurchases"/);
  assert.match(page, /id="developmentUse"/);
  assert.match(page, /function retentionChoice\(\)/);
  assert.match(page, /function syncConsentControls\(changedId=''\)/);
  assert.match(page, /const accepted=config\?\.capture_mode==='LIMITED_HELPER_PILOT'/);
  assert.match(page, /!config\?\.capture_enabled\|\|!accepted/);
  assert.match(page, /id="finishStandard"/);
  assert.match(page, /function allSectionsHaveTakes\(\)/);
  assert.match(page, /function updateFinishStandard\(\)/);
  assert.match(page, /id="sectionSelect"/);
  assert.match(page, /sectionOptions\.label='Sections'/);
  assert.match(page, /deleteOptions\.label='Delete a saved take'/);
  assert.match(page, /async function deleteSavedTake\(sectionId,clipId\)/);
  assert.match(page, /option\.value=`delete\|\$\{section\.id\}\|\$\{take\.clip_id\}`/);
  assert.match(page, /WHITE · STANDARD = 0 saved takes/);
  assert.match(page, /YELLOW = 1 saved take/);
  assert.match(page, /GREEN = 2 or more saved takes/);
  assert.match(page, /function sectionFlag\(count\)/);
  assert.match(page, /#sectionSelect option\[data-state="none"\] \{ color:#fff; \}/);
  assert.match(page, /#sectionSelect option\[data-state="one"\] \{ color:#ffe08a; \}/);
  assert.match(page, /#sectionSelect option\[data-state="complete"\] \{ color:#a9e2c0; \}/);
  assert.match(page, /#sectionSelect option\[data-state="delete"\] \{ color:#ffaaa3; \}/);
  assert.match(page, /id="savedTakePlayback"/);
  assert.match(page, /id="savedPlayback" controls/);
  assert.match(page, /listen\.textContent='Listen'/);
  assert.match(page, /async function playSavedTake\(sectionId,take\)/);
  assert.match(page, /clips\/\$\{encodeURIComponent\(take\.clip_id\)\}/);
  assert.match(page, /credentials:'same-origin'/);
  assert.match(page, /function clearSavedPlayback\(\)/);
  assert.match(page, /option\.dataset\.state=flag\.state/);
  assert.match(page, /function updateSectionMenuColor\(\)/);
  assert.match(page, /consentDocument[\s\S]*href="\/consent"/);
});

async function postTicket(memberId = 'test-member-001') {
  const now = Math.floor(Date.now() / 1000);
  const ticket = sign({
    iss: 'wix', aud: 'project-x-voice-capture', purpose: 'voice-capture-access',
    sub: memberId, email: memberId === 'test-member-001' ? 'sam.rideout.me@gmail.com' : `${memberId}@example.com`,
    iat: now, exp: now + 120, jti: crypto.randomBytes(24).toString('hex')
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

  originalConfig.prompts_approved = false;
  await fs.writeFile(configPath, `${JSON.stringify(originalConfig, null, 2)}\n`);
  const unapprovedConfig = await (await fetch(`${base}/api/config`)).json();
  assert.equal(unapprovedConfig.prompts_ready, false);
  assert.equal(unapprovedConfig.capture_enabled, false);
  const blockedSession = await fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, cookie },
    body: JSON.stringify({ consent: {
      accepted: true, version: unapprovedConfig.consent_version,
      retention_choice: 'DELETE_AFTER_ORDER', development_use: false
    } })
  });
  assert.equal(blockedSession.status, 503, 'sessions stay blocked until prompts are approved');

  originalConfig.prompts_approved = true;
  await fs.writeFile(configPath, `${JSON.stringify(originalConfig, null, 2)}\n`);
  const config = await (await fetch(`${base}/api/config`)).json();
  assert.equal(config.prompts_ready, true);
  assert.equal(config.sections.length, 8);
  assert.ok(config.sections.every(section => section.configured));
  assert.equal(config.finish_standard.title, 'Finish Standard');
  assert.match(config.finish_standard.text, /Target: approximately 10–20 minutes/);
  assert.equal(config.consent_choices.delete_after_order.length > 0, true);
  assert.equal(config.consent_choices.future_purchases.length > 0, true);
  assert.equal(config.consent_choices.development_use.length > 0, true);
  assert.equal(config.consent_document_path, '/consent');
  const consentDocument = await fetch(`${base}/consent`);
  assert.equal(consentDocument.status, 200);
  assert.match(await consentDocument.text(), /DRAFT PREVIEW — NOT LIVE OR OPERATIONAL/);

  for (const consent of [
    true,
    { accepted: true, version: config.consent_version, retention_choice: 'BOTH', development_use: false },
    { accepted: true, version: config.consent_version, retention_choice: 'DELETE_AFTER_ORDER', development_use: 'yes' },
    { accepted: true, version: 'old-version', retention_choice: 'DELETE_AFTER_ORDER', development_use: false }
  ]) {
    const invalid = await fetch(`${base}/api/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base, cookie },
      body: JSON.stringify({ consent, consent_version: config.consent_version })
    });
    assert.equal(invalid.status, 400, 'invalid or incomplete consent selections are rejected');
  }

  const createdResponse = await fetch(`${base}/api/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base, cookie },
    body: JSON.stringify({ consent: {
      accepted: true, version: config.consent_version,
      retention_choice: 'DELETE_AFTER_ORDER', development_use: false
    } })
  });
  assert.equal(createdResponse.status, 201);
  const { session } = await createdResponse.json();
  assert.equal(session.consent.accepted, true);
  assert.equal(session.consent.current_order, true);
  assert.equal(session.consent.retention_choice, 'DELETE_AFTER_ORDER');
  assert.equal(session.consent.future_purchase_storage, false);
  assert.equal(session.consent.development_use, false);
  assert.match(session.consent.choice_text.retention, /delet/i);
  assert.equal(session.consent.consent_evidence_sha256.length, 64);

  await postTicket('test-member-002');
  const futureResponse = await fetch(`${base}/api/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base, cookie },
    body: JSON.stringify({ consent: {
      accepted: true, version: config.consent_version,
      retention_choice: 'FUTURE_PURCHASES', development_use: true
    } })
  });
  assert.equal(futureResponse.status, 201);
  const { session: futureSession } = await futureResponse.json();
  assert.equal(futureSession.consent.current_order, true);
  assert.equal(futureSession.consent.retention_choice, 'FUTURE_PURCHASES');
  assert.equal(futureSession.consent.future_purchase_storage, true);
  assert.equal(futureSession.consent.development_use, true);
  assert.match(futureSession.consent.choice_text.development_use, /development/i);
  await postTicket('test-member-001');

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

  const firstTake = uploadedClips[0];
  const secondAudio = Buffer.from('second take for section 1');
  const secondForm = new FormData();
  secondForm.append('section', '1');
  secondForm.append('duration_seconds', '3');
  secondForm.append('audio', new Blob([secondAudio], { type: 'audio/webm' }), 'section-1-take-2.webm');
  const secondResponse = await fetch(`${base}/api/sessions/${session.session_id}/clips`, {
    method: 'POST', headers: { origin: base, cookie }, body: secondForm
  });
  assert.equal(secondResponse.status, 201);
  const secondUpload = await secondResponse.json();
  assert.equal(secondUpload.clip.take, 2);
  const secondTake = { ...secondUpload.clip, audio: secondAudio };

  const listenedTake = await fetch(`${base}/api/sessions/${session.session_id}/clips/${secondTake.clip_id}`, {
    headers: { cookie }
  });
  assert.equal(listenedTake.status, 200, 'the signed-in owner can retrieve a saved take to listen');
  assert.match(listenedTake.headers.get('content-type'), /^audio\/webm/);
  assert.equal(listenedTake.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Buffer.from(await listenedTake.arrayBuffer()), secondAudio);

  const unauthenticatedListen = await fetch(`${base}/api/sessions/${session.session_id}/clips/${secondTake.clip_id}`);
  assert.equal(unauthenticatedListen.status, 401, 'listening requires member authentication');

  await postTicket('test-member-002');
  const wrongOwnerListen = await fetch(`${base}/api/sessions/${session.session_id}/clips/${secondTake.clip_id}`, {
    headers: { cookie }
  });
  assert.equal(wrongOwnerListen.status, 404, 'another member cannot listen to this take');
  const wrongOwnerDelete = await fetch(`${base}/api/sessions/${session.session_id}/clips/${firstTake.clip_id}`, {
    method: 'DELETE', headers: { origin: base, cookie }
  });
  assert.equal(wrongOwnerDelete.status, 404, 'a different member cannot delete another member\'s take');
  await postTicket('test-member-001');

  const unauthenticatedDelete = await fetch(`${base}/api/sessions/${session.session_id}/clips/${firstTake.clip_id}`, {
    method: 'DELETE', headers: { origin: base }
  });
  assert.equal(unauthenticatedDelete.status, 401, 'take deletion requires member authentication');

  const firstFile = path.join(testRoot, 'data', 'sessions', session.session_id, firstTake.relative_path);
  const deleteResponse = await fetch(`${base}/api/sessions/${session.session_id}/clips/${firstTake.clip_id}`, {
    method: 'DELETE', headers: { origin: base, cookie }
  });
  assert.equal(deleteResponse.status, 200);
  const deleted = await deleteResponse.json();
  assert.equal(deleted.deleted_clip_id, firstTake.clip_id);
  assert.deepEqual(deleted.session.sections['1'].takes.map(item => item.clip_id), [secondTake.clip_id]);
  await assert.rejects(fs.access(firstFile), { code: 'ENOENT' }, 'deleted audio is removed from live storage');

  const thirdAudio = Buffer.from('third take for section 1 after deleting take 1');
  const thirdForm = new FormData();
  thirdForm.append('section', '1');
  thirdForm.append('duration_seconds', '3.5');
  thirdForm.append('audio', new Blob([thirdAudio], { type: 'audio/webm' }), 'section-1-take-3.webm');
  const thirdResponse = await fetch(`${base}/api/sessions/${session.session_id}/clips`, {
    method: 'POST', headers: { origin: base, cookie }, body: thirdForm
  });
  assert.equal(thirdResponse.status, 201);
  const thirdUpload = await thirdResponse.json();
  assert.equal(thirdUpload.clip.take, 3, 'take numbering does not reuse an existing file name after a deletion');
  uploadedClips.splice(0, 1, secondTake, { ...thirdUpload.clip, audio: thirdAudio });

  const completeResponse = await fetch(`${base}/api/sessions/${session.session_id}/complete`, {
    method: 'POST', headers: { origin: base, cookie }
  });
  assert.equal(completeResponse.status, 200);

  const completedTakeDelete = await fetch(`${base}/api/sessions/${session.session_id}/clips/${uploadedClips[0].clip_id}`, {
    method: 'DELETE', headers: { origin: base, cookie }
  });
  assert.equal(completedTakeDelete.status, 409, 'completed sessions cannot be changed while awaiting transfer');

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

  process.env.VOICE_CAPTURE_MODE = 'LIMITED_HELPER_PILOT';
  process.env.VOICE_PILOT_CAPTURE_APPROVED = 'true';
  process.env.VOICE_PILOT_CONSENT_VERSION = 'limited-helper-pilot-test-v1';
  process.env.VOICE_PILOT_EMAILS = 'SAM.RIDEOUT.ME@GMAIL.COM';
  await postTicket('test-member-001');
  const pilotConfig = await (await fetch(`${base}/api/config`, { headers: { cookie } })).json();
  assert.equal(pilotConfig.capture_mode, 'LIMITED_HELPER_PILOT');
  assert.equal(pilotConfig.capture_enabled, true);
  assert.equal(pilotConfig.pilot_access, true);
  assert.equal(pilotConfig.account_email, 'sam.rideout.me@gmail.com');
  assert.match(pilotConfig.pilot_consent_notice, /Render.*encrypted daily disk snapshots/s);
  assert.equal(pilotConfig.pilot_consent_document_path, '/pilot-consent');
  const pilotDocument = await fetch(`${base}/pilot-consent`);
  assert.equal(pilotDocument.status, 200);
  assert.match(await pilotDocument.text(), /does not publish a maximum retention period/);

  const pilotSessions = await (await fetch(`${base}/api/sessions`, { headers: { cookie } })).json();
  assert.deepEqual(pilotSessions.sessions, [], 'customer sessions are hidden while pilot mode is active');
  const pilotCreate = await fetch(`${base}/api/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base, cookie },
    body: JSON.stringify({ pilot_consent: {
      accepted: true, version: pilotConfig.pilot_consent_version, understood: true
    } })
  });
  assert.equal(pilotCreate.status, 201);
  const { session: pilotSession } = await pilotCreate.json();
  assert.equal(pilotSession.program, 'LIMITED_HELPER_PILOT');
  assert.equal(pilotSession.purpose, 'RECORDING_WORKFLOW_AND_CAPTURE_QUALITY_TEST_ONLY');
  assert.equal(pilotSession.consent.current_order, false);
  assert.equal(pilotSession.consent.retention_policy, 'UNTIL_PILOT_END_OR_EARLIER_DELETION_REQUEST');
  assert.equal(pilotSession.consent.accepted, true);
  assert.equal(pilotSession.consent.consent_evidence_sha256.length, 64);

  await postTicket('not-invited-member');
  const deniedConfig = await (await fetch(`${base}/api/config`, { headers: { cookie } })).json();
  assert.equal(deniedConfig.capture_enabled, false);
  assert.equal(deniedConfig.pilot_access, false);
  const deniedCreate = await fetch(`${base}/api/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base, cookie },
    body: JSON.stringify({ pilot_consent: {
      accepted: true, version: pilotConfig.pilot_consent_version, understood: true
    } })
  });
  assert.equal(deniedCreate.status, 403, 'non-allowlisted members cannot create pilot sessions');

  process.env.VOICE_PILOT_EMAILS = 'a1@x.co,a2@x.co,a3@x.co,a4@x.co,a5@x.co,a6@x.co,a7@x.co,a8@x.co,a9@x.co,a10@x.co,a11@x.co';
  const overLimit = await fetch(`${base}/api/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base, cookie },
    body: JSON.stringify({ pilot_consent: {
      accepted: true, version: pilotConfig.pilot_consent_version, understood: true
    } })
  });
  assert.equal(overLimit.status, 503, 'allowlist above ten members fails closed');

  process.env.VOICE_CAPTURE_MODE = 'CUSTOMER';
  delete process.env.VOICE_CUSTOMER_CAPTURE_APPROVED;
  const customerGate = await (await fetch(`${base}/api/config`)).json();
  assert.equal(customerGate.capture_enabled, false, 'customer capture remains off unless separately approved');
});
