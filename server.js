'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const express = require('express');
const multer = require('multer');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const COOKIE_NAME = 'px_voice_session';
const COOKIE_TTL_SECONDS = 8 * 60 * 60;
const MAX_CLIP_BYTES = 25 * 1024 * 1024;
const MAX_SESSION_BYTES = 120 * 1024 * 1024;
const MAX_STORE_BYTES = 850 * 1024 * 1024;
const SECTION_COUNT = 8;
const ROOT = path.resolve(__dirname);
const DATA_DIR = path.resolve(process.env.VOICE_DATA_DIR ||
  (process.env.RENDER ? '/var/data/project-x-voice-capture' : './voice-data'));
const SESSION_DIR = path.join(DATA_DIR, 'sessions');
const REPLAY_DIR = path.join(DATA_DIR, 'used-handoff-tickets');
const SECTION_CONFIG = path.resolve(process.env.VOICE_SECTION_CONFIG || path.join(ROOT, 'config', 'capture-sections.json'));
const PILOT_CONSENT_VERSION = 'limited-helper-pilot-2026-10-03-v1';
const PILOT_CONSENT_NOTICE = 'LIMITED HELPER PILOT. This is a test of the recording workflow, not a customer order. Your recordings will be used only to test and improve the recording process and capture quality. They will not be used in customer orders or production machine-learning training. The recording clips are stored temporarily on Render while they are transferred to Sam’s PC. After the local transfer is verified, the live Render audio files are deleted. Render also creates encrypted daily disk snapshots; Render documents that snapshots are kept for at least 7 days and does not publish a maximum retention period. Deleted live files may therefore remain in snapshots for an unknown period. The local pilot copy will be kept only while the limited pilot is active, unless you ask for deletion sooner. Contact Sam at sam.rideout.me@gmail.com to request deletion or stop participating. Do not continue if you do not agree.';

function captureMode() {
  const value = process.env.VOICE_CAPTURE_MODE || 'CUSTOMER';
  return ['CUSTOMER', 'LIMITED_HELPER_PILOT'].includes(value) ? value : 'INVALID';
}

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function pilotEmails() {
  return [...new Set(String(process.env.VOICE_PILOT_EMAILS || '')
    .split(',').map(normalizeEmail).filter(Boolean))];
}

function pilotEmailAllowed(email) {
  return Boolean(email) && pilotEmails().includes(normalizeEmail(email));
}

function pilotConfigurationReady() {
  const emails = pilotEmails();
  const version = process.env.VOICE_PILOT_CONSENT_VERSION || PILOT_CONSENT_VERSION;
  return process.env.VOICE_PILOT_CAPTURE_APPROVED === 'true' &&
    emails.length >= 1 && emails.length <= 10 &&
    emails.every(value => value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) &&
    typeof version === 'string' && version.length >= 8 && !version.toLowerCase().startsWith('draft');
}

function optionalAuthenticatedMember(req, res, next) {
  try {
    const payload = verifySigned(cookieValue(req));
    const now = Math.floor(Date.now() / 1000);
    if (payload && payload.iss === 'project-x-voice-capture' &&
        typeof payload.sub === 'string' && payload.sub.length >= 3 &&
        Number.isInteger(payload.exp) && payload.exp > now) {
      req.memberId = payload.sub;
      req.memberEmail = normalizeEmail(payload.email);
    }
    next();
  } catch (error) { next(error); }
}

function requireCaptureAccess(req, res, next) {
  const mode = captureMode();
  if (mode === 'INVALID') return res.status(503).json({ error: 'Voice capture is disabled because its mode is invalid.' });
  if (mode === 'LIMITED_HELPER_PILOT') {
    if (!pilotConfigurationReady()) return res.status(503).json({ error: 'The limited helper pilot is not configured.' });
    if (!pilotEmailAllowed(req.memberEmail)) return res.status(403).json({ error: 'This Wix sign-in email has not been invited to the limited helper pilot.' });
    req.captureProgram = 'LIMITED_HELPER_PILOT';
    return next();
  }
  req.captureProgram = 'CUSTOMER';
  next();
}

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'microphone=(self)');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'self'; media-src 'self' blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  next();
});
app.use(express.json({ limit: '32kb' }));

function secret() {
  const value = process.env.WIX_HANDOFF_SECRET || '';
  if (Buffer.byteLength(value, 'utf8') < 32) {
    const error = new Error('WIX_HANDOFF_SECRET is not configured (minimum 32 characters).');
    error.status = 503;
    throw error;
  }
  return value;
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verifySigned(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  const parts = value.split('.');
  if (parts.length !== 2) return null;
  const expected = crypto.createHmac('sha256', secret()).update(parts[0]).digest();
  let actual;
  try { actual = Buffer.from(parts[1], 'base64url'); } catch { return null; }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  try { return JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); }
  catch { return null; }
}

async function consumeTicket(jti) {
  await fsp.mkdir(REPLAY_DIR, { recursive: true });
  const filename = path.join(REPLAY_DIR, sha256(jti));
  let handle;
  try {
    handle = await fsp.open(filename, 'wx', 0o600);
    await handle.writeFile(String(Date.now()));
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  } finally {
    if (handle) await handle.close();
  }
  return true;
}

let replayPruneCounter = 0;
async function pruneOldReplayMarkers() {
  if (++replayPruneCounter % 100 !== 0) return;
  const cutoff = Date.now() - 10 * 60 * 1000;
  const entries = await fsp.readdir(REPLAY_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filename = path.join(REPLAY_DIR, entry.name);
    try { if ((await fsp.stat(filename)).mtimeMs < cutoff) await fsp.unlink(filename); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function cookieValue(req) {
  const raw = req.headers.cookie || '';
  for (const piece of raw.split(';')) {
    const index = piece.indexOf('=');
    if (index < 0) continue;
    if (piece.slice(0, index).trim() === COOKIE_NAME) {
      return decodeURIComponent(piece.slice(index + 1).trim());
    }
  }
  return '';
}

function authenticatedMember(req, res, next) {
  try {
    const payload = verifySigned(cookieValue(req));
    const now = Math.floor(Date.now() / 1000);
    if (!payload || payload.iss !== 'project-x-voice-capture' ||
        typeof payload.sub !== 'string' || payload.sub.length < 3 ||
        !Number.isInteger(payload.exp) || payload.exp <= now) {
      return res.status(401).json({ error: 'Sign in through the Project X member page to continue.' });
    }
    req.memberId = payload.sub;
    req.memberEmail = normalizeEmail(payload.email);
    next();
  } catch (error) { next(error); }
}

function requireSameOrigin(req, res, next) {
  const origin = req.get('origin');
  if (!origin) return next(); // Local PC transfer utility has no browser Origin header.
  const host = req.get('host');
  const expected = `${req.secure ? 'https' : 'http'}://${host}`;
  if (origin !== expected) return res.status(403).json({ error: 'Request origin rejected.' });
  next();
}

function safeSessionId(value) {
  return typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value);
}

function sessionPath(id) { return path.join(SESSION_DIR, id); }
function manifestPath(id) { return path.join(sessionPath(id), 'manifest.json'); }

async function readManifest(id) {
  return JSON.parse(await fsp.readFile(manifestPath(id), 'utf8'));
}

async function writeManifest(manifest) {
  const target = manifestPath(manifest.session_id);
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await fsp.writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
  await fsp.rename(temporary, target);
}

function allClips(manifest) {
  return Object.values(manifest.sections || {}).flatMap(section => section.takes || []);
}

function publicManifest(manifest) {
  const copy = JSON.parse(JSON.stringify(manifest));
  delete copy.owner_member_id;
  return copy;
}

async function ownedManifest(req, res, next) {
  const id = req.params.sessionId;
  if (!safeSessionId(id)) return res.status(404).json({ error: 'Session not found.' });
  try {
    const manifest = await readManifest(id);
    if (manifest.owner_member_id !== req.memberId) return res.status(404).json({ error: 'Session not found.' });
    const program = manifest.program || 'CUSTOMER';
    if (program !== (req.captureProgram || captureMode())) return res.status(404).json({ error: 'Session not found.' });
    req.manifest = manifest;
    next();
  } catch (error) {
    if (error.code === 'ENOENT') return res.status(404).json({ error: 'Session not found.' });
    next(error);
  }
}

async function transferAuth(req, res, next) {
  const configured = process.env.VOICE_TRANSFER_TOKEN || '';
  if (Buffer.byteLength(configured, 'utf8') < 32) {
    return res.status(503).json({ error: 'VOICE_TRANSFER_TOKEN is not configured (minimum 32 characters).' });
  }
  const supplied = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const left = Buffer.from(supplied, 'utf8');
  const right = Buffer.from(configured, 'utf8');
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
    return res.status(401).json({ error: 'Transfer authorization failed.' });
  }
  next();
}

async function transferManifest(req, res, next) {
  const id = req.params.sessionId;
  if (!safeSessionId(id)) return res.status(404).json({ error: 'Session not found.' });
  try {
    const manifest = await readManifest(id);
    if (!['READY_FOR_TRANSFER', 'TRANSFERRED_AUDIO_DELETED'].includes(manifest.status)) {
      return res.status(409).json({ error: 'Session audio must be marked complete before transfer.' });
    }
    req.manifest = manifest;
    req.rawManifest = await fsp.readFile(manifestPath(id));
    next();
  } catch (error) {
    if (error.code === 'ENOENT') return res.status(404).json({ error: 'Session not found.' });
    next(error);
  }
}

function clipExtension(mimetype) {
  const base = String(mimetype || '').split(';')[0].trim().toLowerCase();
  const allowed = {
    'audio/webm': '.webm',
    'audio/mp4': '.m4a',
    'audio/ogg': '.ogg',
    'audio/wav': '.wav',
    'audio/x-wav': '.wav'
  };
  return allowed[base] || '';
}

async function directoryBytes(dir) {
  let total = 0;
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(full);
    else if (entry.isFile() && !entry.name.endsWith('.tmp')) total += (await fsp.stat(full)).size;
  }
  return total;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_CLIP_BYTES, files: 1, fields: 2 },
  fileFilter: (req, file, callback) => callback(null, Boolean(clipExtension(file.mimetype)))
});

app.get('/health', (req, res) => {
  res.json({ ok: true, application: 'Project X Tier 1 Voice Capture', stage: 'segmented capture' });
});

app.get('/', (req, res) => res.redirect(302, '/voice-capture'));
app.get('/voice-capture', (req, res) => res.sendFile(path.join(ROOT, 'public', 'voice-capture.html')));
app.get('/consent', (req, res) => res.sendFile(path.join(ROOT, 'public', 'consent.html')));
app.get('/pilot-consent', (req, res) => res.sendFile(path.join(ROOT, 'public', 'pilot-consent.html')));

app.get('/api/config', optionalAuthenticatedMember, (req, res, next) => {
  try {
    const config = JSON.parse(fs.readFileSync(SECTION_CONFIG, 'utf8'));
    const promptsReady = config.prompts_approved === true && config.sections.length === SECTION_COUNT &&
      config.sections.every(section => section.title && section.instructions);
    const choicesReady = ['delete_after_order', 'future_purchases', 'development_use']
      .every(key => typeof config.consent_choices?.[key] === 'string' && config.consent_choices[key].trim());
    const configuredConsentVersion = process.env.VOICE_CONSENT_VERSION || config.consent_version;
    const consentApproved = process.env.VOICE_CUSTOMER_CAPTURE_APPROVED === 'true' &&
      process.env.VOICE_CONSENT_APPROVED === 'true' &&
      !String(config.consent_notice).includes('DRAFT') &&
      !String(configuredConsentVersion).toLowerCase().startsWith('draft') &&
      choicesReady && config.consent_document_path === '/consent';
    const mode = captureMode();
    if (mode === 'LIMITED_HELPER_PILOT') {
      const pilotEnabled = pilotConfigurationReady() && promptsReady;
      const pilotAccess = pilotEnabled && pilotEmailAllowed(req.memberEmail);
      return res.json({
        capture_mode: 'LIMITED_HELPER_PILOT',
        pilot_access: pilotAccess,
        account_email: req.memberEmail || null,
        pilot_consent_version: process.env.VOICE_PILOT_CONSENT_VERSION || PILOT_CONSENT_VERSION,
        pilot_consent_notice: PILOT_CONSENT_NOTICE,
        pilot_consent_document_path: '/pilot-consent',
        pilot_consent_draft: false,
        prompts_ready: promptsReady,
        capture_enabled: pilotAccess,
        sections: config.sections.map(section => ({
          id: section.id, title: section.title, instructions: section.instructions,
          configured: Boolean(section.title && section.instructions)
        })),
        finish_standard: config.finish_standard || null
      });
    }
    if (mode === 'INVALID') return res.json({ capture_mode: 'INVALID', capture_enabled: false, prompts_ready: false, sections: [] });
    res.json({
      capture_mode: 'CUSTOMER',
      consent_version: configuredConsentVersion,
      consent_notice: config.consent_notice,
      consent_choices: config.consent_choices || {},
      consent_document_path: config.consent_document_path || '/consent',
      finish_standard: config.finish_standard || null,
      consent_draft: !consentApproved,
      prompts_ready: promptsReady,
      capture_enabled: consentApproved && promptsReady,
      sections: config.sections.map(section => ({
        id: section.id, title: section.title, instructions: section.instructions,
        configured: Boolean(section.title && section.instructions)
      }))
    });
  } catch (error) { next(error); }
});

// Wix backend issues a short-lived one-use HMAC ticket for a signed-in site member.
app.post('/api/session/exchange', requireSameOrigin, async (req, res, next) => {
  try {
    const claims = verifySigned(req.body && req.body.ticket);
    const now = Math.floor(Date.now() / 1000);
    if (!claims || claims.iss !== 'wix' || claims.aud !== 'project-x-voice-capture' ||
        claims.purpose !== 'voice-capture-access' || typeof claims.sub !== 'string' ||
        claims.sub.length < 3 || !Number.isInteger(claims.exp) || claims.exp <= now ||
        claims.exp > now + 300 || !Number.isInteger(claims.iat) || claims.iat > now + 60 ||
        typeof claims.jti !== 'string' || !/^[a-f0-9]{32,128}$/i.test(claims.jti)) {
      return res.status(401).json({ error: 'The member sign-in link expired. Return to the member page and try again.' });
    }
    if (!(await consumeTicket(claims.jti))) {
      return res.status(401).json({ error: 'This sign-in link has already been used. Return to the member page and try again.' });
    }
    await pruneOldReplayMarkers();
    const email = normalizeEmail(claims.email);
    const cookie = sign({ iss: 'project-x-voice-capture', sub: claims.sub, email, exp: now + COOKIE_TTL_SECONDS });
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(cookie)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${COOKIE_TTL_SECONDS}`);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.post('/api/session/logout', requireSameOrigin, (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
  res.json({ ok: true });
});

app.get('/api/sessions', authenticatedMember, requireCaptureAccess, async (req, res, next) => {
  try {
    await fsp.mkdir(SESSION_DIR, { recursive: true });
    const entries = await fsp.readdir(SESSION_DIR, { withFileTypes: true });
    const sessions = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !safeSessionId(entry.name)) continue;
      try {
        const manifest = await readManifest(entry.name);
        if (manifest.owner_member_id === req.memberId && (manifest.program || 'CUSTOMER') === req.captureProgram) sessions.push(publicManifest(manifest));
      } catch { /* Ignore incomplete/unreadable folders; never expose them. */ }
    }
    sessions.sort((a, b) => b.created_at.localeCompare(a.created_at));
    res.json({ sessions });
  } catch (error) { next(error); }
});

app.post('/api/sessions', authenticatedMember, requireSameOrigin, requireCaptureAccess, async (req, res, next) => {
  try {
    const config = JSON.parse(await fsp.readFile(SECTION_CONFIG, 'utf8'));
    const promptsReady = config.prompts_approved === true && config.sections.length === SECTION_COUNT && config.sections.every(section => section.title && section.instructions);
    if (req.captureProgram === 'LIMITED_HELPER_PILOT') {
      if (!promptsReady) return res.status(503).json({ error: 'The eight recording prompts are not ready.' });
      const expectedVersion = process.env.VOICE_PILOT_CONSENT_VERSION || PILOT_CONSENT_VERSION;
      const submittedConsent = req.body?.pilot_consent;
      if (!submittedConsent || submittedConsent.accepted !== true || submittedConsent.version !== expectedVersion || submittedConsent.understood !== true) {
        return res.status(400).json({ error: 'Read the pilot notice and confirm it before starting.' });
      }
      await fsp.mkdir(SESSION_DIR, { recursive: true });
      const existingDirs = await fsp.readdir(SESSION_DIR, { withFileTypes: true });
      for (const entry of existingDirs) {
        if (!entry.isDirectory() || !safeSessionId(entry.name)) continue;
        try {
          const existing = await readManifest(entry.name);
          if (existing.owner_member_id === req.memberId && existing.program === 'LIMITED_HELPER_PILOT' && existing.status === 'RECORDING') {
            return res.status(409).json({ error: 'Resume your open pilot session before starting another.' });
          }
        } catch { /* An incomplete session folder is not an authorized session. */ }
      }
      const now = new Date().toISOString();
      const sessionId = crypto.randomUUID();
      const evidence = { notice: PILOT_CONSENT_NOTICE, version: expectedVersion };
      const manifest = {
        schema_version: 'PX-TIER1-CAPTURE-SESSION-1.0.0',
        program: 'LIMITED_HELPER_PILOT',
        purpose: 'RECORDING_WORKFLOW_AND_CAPTURE_QUALITY_TEST_ONLY',
        session_id: sessionId,
        owner_member_id: req.memberId,
        created_at: now,
        updated_at: now,
        status: 'RECORDING',
        consent: {
          accepted: true,
          pilot_participation: true,
          current_order: false,
          version: expectedVersion,
          retention_policy: 'UNTIL_PILOT_END_OR_EARLIER_DELETION_REQUEST',
          notice_text: PILOT_CONSENT_NOTICE,
          consent_evidence_sha256: sha256(JSON.stringify(evidence)),
          accepted_at: now
        },
        sections: Object.fromEntries(Array.from({ length: SECTION_COUNT }, (_, index) => [String(index + 1), { takes: [] }]))
      };
      await fsp.mkdir(path.join(sessionPath(sessionId), 'clips'), { recursive: true, mode: 0o700 });
      await writeManifest(manifest);
      return res.status(201).json({ session: publicManifest(manifest) });
    }
    const consentVersion = process.env.VOICE_CONSENT_VERSION || config.consent_version;
    const choiceLabels = config.consent_choices || {};
    const choicesReady = ['delete_after_order', 'future_purchases', 'development_use']
      .every(key => typeof choiceLabels[key] === 'string' && choiceLabels[key].trim());
    const consentApproved = process.env.VOICE_CUSTOMER_CAPTURE_APPROVED === 'true' &&
      process.env.VOICE_CONSENT_APPROVED === 'true' &&
      !String(config.consent_notice).includes('DRAFT') && !String(consentVersion).toLowerCase().startsWith('draft') &&
      choicesReady && config.consent_document_path === '/consent';
    if (!consentApproved || !promptsReady) return res.status(503).json({ error: 'New sessions are disabled until the consent wording and all eight prompts are approved.' });
    const expectedVersion = consentVersion;
    const submittedConsent = req.body?.consent;
    const validRetentionChoice = ['DELETE_AFTER_ORDER', 'FUTURE_PURCHASES'].includes(submittedConsent?.retention_choice);
    if (!submittedConsent || submittedConsent.accepted !== true || submittedConsent.version !== expectedVersion ||
        !validRetentionChoice || typeof submittedConsent.development_use !== 'boolean') {
      return res.status(400).json({ error: 'Choose exactly one retention option and submit the current consent version before starting.' });
    }
    await fsp.mkdir(SESSION_DIR, { recursive: true });
    const existingDirs = await fsp.readdir(SESSION_DIR, { withFileTypes: true });
    for (const entry of existingDirs) {
      if (!entry.isDirectory() || !safeSessionId(entry.name)) continue;
      try {
        const existing = await readManifest(entry.name);
        if (existing.owner_member_id === req.memberId && existing.status === 'RECORDING') {
          return res.status(409).json({ error: 'Resume your open recording session before starting another.' });
        }
      } catch { /* An incomplete session folder is not an authorized session. */ }
    }
    const now = new Date().toISOString();
    const sessionId = crypto.randomUUID();
    const consentEvidence = {
      notice: config.consent_notice,
      choices: choiceLabels
    };
    const noticeHash = sha256(JSON.stringify(consentEvidence));
    const manifest = {
      schema_version: 'PX-TIER1-CAPTURE-SESSION-1.0.0',
      program: 'CUSTOMER',
      session_id: sessionId,
      owner_member_id: req.memberId,
      created_at: now,
      updated_at: now,
      status: 'RECORDING',
      consent: {
        accepted: true,
        current_order: true,
        version: expectedVersion,
        retention_choice: submittedConsent.retention_choice,
        future_purchase_storage: submittedConsent.retention_choice === 'FUTURE_PURCHASES',
        development_use: submittedConsent.development_use,
        notice_text: config.consent_notice,
        choice_text: {
          retention: choiceLabels[submittedConsent.retention_choice === 'DELETE_AFTER_ORDER' ? 'delete_after_order' : 'future_purchases'],
          development_use: choiceLabels.development_use
        },
        consent_evidence_sha256: noticeHash,
        accepted_at: now
      },
      sections: Object.fromEntries(Array.from({ length: SECTION_COUNT }, (_, index) => [String(index + 1), { takes: [] }]))
    };
    await fsp.mkdir(path.join(sessionPath(sessionId), 'clips'), { recursive: true, mode: 0o700 });
    await writeManifest(manifest);
    res.status(201).json({ session: publicManifest(manifest) });
  } catch (error) { next(error); }
});

app.get('/api/sessions/:sessionId', authenticatedMember, requireCaptureAccess, ownedManifest, (req, res) => {
  res.json({ session: publicManifest(req.manifest) });
});

app.post('/api/sessions/:sessionId/clips', authenticatedMember, requireSameOrigin, requireCaptureAccess, ownedManifest,
  (req, res, next) => upload.single('audio')(req, res, error => error ? next(error) : next()),
  async (req, res, next) => {
    try {
      const manifest = req.manifest;
      if (manifest.status !== 'RECORDING') return res.status(409).json({ error: 'This session no longer accepts recordings.' });
      const section = Number(req.body?.section);
      if (!Number.isInteger(section) || section < 1 || section > SECTION_COUNT) return res.status(400).json({ error: 'Section must be between 1 and 8.' });
      const promptConfig = JSON.parse(await fsp.readFile(SECTION_CONFIG, 'utf8'));
      const selectedSection = promptConfig.sections.find(item => item.id === section);
      if (!selectedSection || !selectedSection.title || !selectedSection.instructions) return res.status(409).json({ error: 'This section prompt is not configured yet.' });
      if (!req.file || !req.file.buffer?.length) return res.status(400).json({ error: 'Choose a completed recording to upload.' });
      const duration = Number(req.body?.duration_seconds);
      if (!Number.isFinite(duration) || duration <= 0 || duration > 300) return res.status(400).json({ error: 'Recording duration must be between 1 second and 5 minutes.' });
      const ext = clipExtension(req.file.mimetype);
      if (!ext) return res.status(415).json({ error: 'This recording format is not supported by the server.' });
      const current = allClips(manifest);
      if (current.length >= 64) return res.status(413).json({ error: 'This session has reached its take limit.' });
      const sessionBytes = current.reduce((sum, item) => sum + item.bytes, 0);
      if (sessionBytes + req.file.size > MAX_SESSION_BYTES) return res.status(413).json({ error: 'This session has reached its storage limit.' });
      if ((await directoryBytes(DATA_DIR)) + req.file.size > MAX_STORE_BYTES) return res.status(507).json({ error: 'Voice-capture storage is full. Contact Project X before recording more.' });

      const takes = manifest.sections[String(section)].takes;
      const takeNumber = takes.length + 1;
      const clipId = crypto.randomUUID();
      const relativePath = path.join('clips', `section-${String(section).padStart(2, '0')}`, `take-${String(takeNumber).padStart(2, '0')}${ext}`);
      const target = path.join(sessionPath(manifest.session_id), relativePath);
      await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fsp.writeFile(target, req.file.buffer, { flag: 'wx', mode: 0o600 });
      const clip = {
        clip_id: clipId,
        section: section,
        take: takeNumber,
        file_name: path.basename(relativePath),
        relative_path: relativePath.split(path.sep).join('/'),
        mime_type: req.file.mimetype.split(';')[0],
        duration_seconds: Math.round(duration * 1000) / 1000,
        bytes: req.file.size,
        sha256: sha256(req.file.buffer),
        uploaded_at: new Date().toISOString()
      };
      takes.push(clip);
      manifest.updated_at = clip.uploaded_at;
      await writeManifest(manifest);
      res.status(201).json({ clip, session: publicManifest(manifest) });
    } catch (error) { next(error); }
  });

app.post('/api/sessions/:sessionId/complete', authenticatedMember, requireSameOrigin, requireCaptureAccess, ownedManifest, async (req, res, next) => {
  try {
    const manifest = req.manifest;
    if (manifest.status !== 'RECORDING') return res.status(409).json({ error: 'This session is already complete.' });
    const config = JSON.parse(await fsp.readFile(SECTION_CONFIG, 'utf8'));
    const missing = config.sections.filter(section => section.title && section.instructions)
      .filter(section => !(manifest.sections[String(section.id)]?.takes?.length));
    if (missing.length) return res.status(400).json({ error: `Record at least one saved take for each active section. Still needed: ${missing.map(item => item.id).join(', ')}.` });
    manifest.status = 'READY_FOR_TRANSFER';
    manifest.completed_at = new Date().toISOString();
    manifest.updated_at = manifest.completed_at;
    await writeManifest(manifest);
    res.json({ session: publicManifest(manifest) });
  } catch (error) { next(error); }
});

app.get('/api/sessions/:sessionId/clips/:clipId', authenticatedMember, requireCaptureAccess, ownedManifest, async (req, res, next) => {
  try {
    const clip = allClips(req.manifest).find(item => item.clip_id === req.params.clipId);
    if (!clip) return res.status(404).json({ error: 'Recording not found.' });
    const filename = path.resolve(sessionPath(req.manifest.session_id), clip.relative_path);
    if (!filename.startsWith(`${sessionPath(req.manifest.session_id)}${path.sep}`)) return res.status(404).json({ error: 'Recording not found.' });
    res.type(clip.mime_type);
    res.sendFile(filename, error => { if (error && !res.headersSent) next(error); });
  } catch (error) { next(error); }
});

// PC-only transfer endpoints use a separate secret and do not expose member audio in browser APIs.
app.get('/api/transfer/sessions/:sessionId', transferAuth, transferManifest, (req, res) => {
  res.json({ profile_id: req.manifest.owner_member_id, manifest: publicManifest(req.manifest), manifest_sha256: sha256(req.rawManifest) });
});

app.get('/api/transfer/sessions/:sessionId/clips/:clipId', transferAuth, transferManifest, async (req, res, next) => {
  try {
    if (req.manifest.status === 'TRANSFERRED_AUDIO_DELETED') return res.status(410).json({ error: 'Render audio was already deleted after transfer.' });
    const clip = allClips(req.manifest).find(item => item.clip_id === req.params.clipId);
    if (!clip) return res.status(404).json({ error: 'Recording not found.' });
    const filename = path.resolve(sessionPath(req.manifest.session_id), clip.relative_path);
    if (!filename.startsWith(`${sessionPath(req.manifest.session_id)}${path.sep}`)) return res.status(404).json({ error: 'Recording not found.' });
    res.setHeader('Content-Type', clip.mime_type);
    res.setHeader('Content-Length', clip.bytes);
    res.setHeader('X-Content-SHA256', clip.sha256);
    res.sendFile(filename, error => { if (error && !res.headersSent) next(error); });
  } catch (error) { next(error); }
});

app.post('/api/transfer/sessions/:sessionId/confirm', transferAuth, express.json({ limit: '128kb' }), transferManifest, async (req, res, next) => {
  try {
    if (req.manifest.status === 'TRANSFERRED_AUDIO_DELETED') return res.status(409).json({ error: 'Audio for this session has already been deleted from Render.' });
    const latestBytes = await fsp.readFile(manifestPath(req.manifest.session_id));
    const latestHash = sha256(latestBytes);
    if (req.body?.manifest_sha256 !== latestHash) return res.status(409).json({ error: 'Session changed during transfer. Download the current manifest and retry.' });
    const expected = allClips(req.manifest).map(clip => ({ clip_id: clip.clip_id, sha256: clip.sha256 })).sort((a, b) => a.clip_id.localeCompare(b.clip_id));
    const supplied = Array.isArray(req.body?.files) ? req.body.files.map(file => ({ clip_id: file.clip_id, sha256: file.sha256 })).sort((a, b) => String(a.clip_id).localeCompare(String(b.clip_id))) : [];
    if (JSON.stringify(expected) !== JSON.stringify(supplied)) return res.status(400).json({ error: 'Local copy verification list does not match this session.' });
    for (const clip of allClips(req.manifest)) {
      const filename = path.resolve(sessionPath(req.manifest.session_id), clip.relative_path);
      const bytes = await fsp.readFile(filename);
      if (bytes.length !== clip.bytes || sha256(bytes) !== clip.sha256) return res.status(409).json({ error: `Render copy failed verification for ${clip.file_name}; no audio was deleted.` });
    }
    for (const clip of allClips(req.manifest)) {
      await fsp.unlink(path.join(sessionPath(req.manifest.session_id), clip.relative_path));
    }
    req.manifest.status = 'TRANSFERRED_AUDIO_DELETED';
    req.manifest.transferred_at = new Date().toISOString();
    req.manifest.transfer = { verified_clip_count: expected.length, local_verification_report_sha256: sha256(JSON.stringify(supplied)) };
    req.manifest.updated_at = req.manifest.transferred_at;
    await writeManifest(req.manifest);
    res.json({ ok: true, status: req.manifest.status, deleted_clip_count: expected.length, transferred_at: req.manifest.transferred_at });
  } catch (error) { next(error); }
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error instanceof multer.MulterError) {
    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(status).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'Recording is larger than the 25 MB limit.' : 'Upload could not be read.' });
  }
  if (error.status) return res.status(error.status).json({ error: error.message });
  console.error('Request failed:', error.message);
  res.status(500).json({ error: 'The request could not be completed. Try again or contact Project X.' });
});

async function start() {
  await fsp.mkdir(SESSION_DIR, { recursive: true, mode: 0o700 });
  await fsp.mkdir(REPLAY_DIR, { recursive: true, mode: 0o700 });
  return app.listen(PORT, '0.0.0.0', () => console.log(`Project X Voice Capture listening on ${PORT}`));
}

if (require.main === module) start().catch(error => { console.error(error); process.exit(1); });
module.exports = { app, start, sign, verifySigned, sha256 };
