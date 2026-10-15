'use strict';

const PHASES = new Set(['QUEUED','PREPARING','TRAINING','KEY_SELECTION','CERTIFYING','READY','FAILED','REVIEW_REQUIRED']);
const STAGES = new Set(['QUEUED','CHECKING_RECORDINGS','ANALYZING_VOICE','CALIBRATING','TRAINING','BUILDING_INDEX','PREPARING_PREVIEWS','KEY_SELECTION','VERIFYING','READY','FAILED','REVIEW_REQUIRED']);
const TERMINAL = new Set(['READY','FAILED','REVIEW_REQUIRED']);
const iso = value => typeof value === 'string' && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const stageFor = phase => ({QUEUED:'QUEUED',PREPARING:'CHECKING_RECORDINGS',TRAINING:'TRAINING',KEY_SELECTION:'KEY_SELECTION',CERTIFYING:'VERIFYING',READY:'READY',FAILED:'FAILED',REVIEW_REQUIRED:'REVIEW_REQUIRED'})[phase] || 'QUEUED';

function stampProgress(old, body, now = new Date().toISOString()) {
  if (body.stage_code !== undefined && !STAGES.has(body.stage_code)) throw new Error('Invalid preparation stage.');
  if (body.stage_code === 'READY' && body.phase !== 'READY') throw new Error('READY stage requires certified READY phase.');
  if (body.progress_updated_at !== undefined && body.progress_updated_at !== null &&
      (!iso(body.progress_updated_at) || Date.parse(body.progress_updated_at) > Date.parse(now) + 300000)) {
    throw new Error('Invalid preparation heartbeat.');
  }
  // Do not invent a historical start for a legacy state already in progress.
  const begins = (!old || old.phase === 'QUEUED') && body.phase !== 'QUEUED' && !TERMINAL.has(body.phase);
  const started = old?.preparation_started_at || (begins ? now : null);
  return {
    preparation_started_at: started,
    preparation_finished_at: old?.preparation_finished_at || (TERMINAL.has(body.phase) ? now : null),
    stage_code: body.stage_code || stageFor(body.phase),
    progress_updated_at: body.progress_updated_at ?? null
  };
}

function publicPreparation(manifest, state, profileStatus, record = null, now = new Date().toISOString()) {
  if (['MISSING','RECORDING','REVOKED'].includes(profileStatus)) return null;
  let phase = PHASES.has(state?.phase) ? state.phase : 'QUEUED';
  if (profileStatus === 'READY') phase = 'READY';
  else if (profileStatus === 'FAILED') phase = 'FAILED';
  else if (phase === 'READY') phase = 'REVIEW_REQUIRED';
  else if (state?.stage_code === 'REVIEW_REQUIRED') phase = 'REVIEW_REQUIRED';
  const submitted = manifest.phone_training?.accepted_at || manifest.completed_at;
  const terminal = TERMINAL.has(phase);
  const reportedFinish = profileStatus === 'READY' || profileStatus === 'FAILED' ? record?.updated_at : null;
  const finish = reportedFinish || state?.preparation_finished_at || (terminal ? state?.updated_at : null);
  const stage = terminal ? stageFor(phase) : STAGES.has(state?.stage_code) && state.stage_code !== 'READY' ? state.stage_code : stageFor(phase);
  const progressTime = state?.progress_updated_at || state?.updated_at;
  return {
    phase, stage_code: stage,
    submitted_at: iso(submitted) ? submitted : null,
    started_at: iso(state?.preparation_started_at) ? state.preparation_started_at : null,
    finished_at: terminal && iso(finish) ? finish : null,
    progress_updated_at: iso(progressTime) ? progressTime : null,
    updated_at: iso(state?.updated_at) ? state.updated_at : null,
    checked_at: now,
    epoch: Number.isInteger(state?.epoch) && state.epoch >= 0 && state.epoch <= 300 ? state.epoch : 0,
    target_epoch: 300,
    check_back_minutes: 10,
    planning_minutes: 60
  };
}

module.exports = {stampProgress, publicPreparation, STAGES, iso};
