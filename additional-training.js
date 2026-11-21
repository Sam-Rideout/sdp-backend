'use strict';
// New consent authorizes an independent updated version, never edits a sealed capture.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const NOTICE='I want to combine the retained training recordings from the profile I choose with these new recordings to train an updated version. My current profile remains available while the updated version is verified. The updated version has its own consent and deletion settings; deleting an older version does not delete the separately authorized updated version. A personal message is never used for training.';
const SCHEMA='PX-ADDITIONAL-VOICE-TRAINING-1.0';
function fail(message,status=409){const e=new Error(message);e.status=status;throw e;}
function createAdditionalTraining(c){
 const enabled=()=>process.env.PX_ADDITIONAL_TRAINING_ENABLED==='true';
 async function parents(member){
  const candidates=(await c.profiles(member)).filter(({record:r,manifest:m,selectable})=>selectable&&r.status==='READY'&&!r.consent_expired&&!r.deletion_requested
   &&m.status==='TRANSFERRED_AUDIO_DELETED'&&m.consent?.retention_choice==='FUTURE_PURCHASES'
   &&r.session_id===m.session_id&&r.owner_member_id===member&&m.owner_member_id===member
   &&r.voice_profile_id==='PXPITCH-'+r.voice_model_id&&r.profile_origin!=='EXISTING_OWNER_TEST');
  if(process.env.PX_ENFORCE_PROFILE_AVAILABILITY!=='true')return candidates;
  const availability=require('./profile-availability').createProfileAvailability(c.dataDir);
  const checked=await Promise.all(candidates.map(x=>availability.available(x.record)));
  return candidates.filter((x,i)=>checked[i]);
 }
 async function parent(member,id){
  const rows=(await parents(member)).filter(x=>x.record.voice_profile_id===id);
  if(rows.length!==1)fail('The selected profile is unavailable, withdrawn, or its storage consent has expired. Refresh before adding recordings.');
  return rows[0];
 }
 async function evidence(member,request,acceptedAt){
  if(!enabled())fail('Additional voice training is not enabled yet.',503);
  if(!request||request.accepted!==true||request.notice_text!==NOTICE)fail('Choose your profile and explicitly agree to combine its retained recordings.',400);
  const {record:r}=await parent(member,request.parent_voice_profile_id);
  return {schema_version:SCHEMA,parent_session_id:r.session_id,parent_voice_profile_id:r.voice_profile_id,parent_model_id:r.voice_model_id,
   parent_certification_sha256:r.certification_sha256,accepted:true,accepted_at:acceptedAt,notice_text:NOTICE};
 }
 async function validateManifest(m){
  const a=m.additional_training;if(!a)return null;
  if(a.schema_version!==SCHEMA||a.accepted!==true||a.notice_text!==NOTICE||a.accepted_at!==m.consent?.accepted_at||a.parent_session_id===m.session_id)fail('Additional-training consent or lineage differs.');
  const {record:r}=await parent(m.owner_member_id,a.parent_voice_profile_id);
  if(r.session_id!==a.parent_session_id||r.voice_model_id!==a.parent_model_id||r.certification_sha256!==a.parent_certification_sha256)fail('The selected profile version changed.');
  return r;
 }
 async function validatePublication(m,body){
  const r=await validateManifest(m);if(!r)return null;
  let proof;try{proof=JSON.parse(body.certificate_json).additional_training_source;}catch{fail('Additional-training certification could not be read.',400);}
  const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
  if(!proof||proof.schema_version!=='PX-ADDITIONAL-TRAINING-SOURCE-1.0'
    ||JSON.stringify(canonical(proof.authorization))!==JSON.stringify(canonical(m.additional_training))
    ||!Number.isSafeInteger(proof.parent_frames)||proof.parent_frames<=0
    ||!/^PXTRAIN-[A-F0-9]{32}$/.test(proof.parent_enrollment_id||'')
    ||!['parent_source_sha256','parent_intake_sha256'].every(k=>/^[a-f0-9]{64}$/.test(proof[k]||'')))fail('Certified additional-training lineage is missing or differs.',400);
  return r;
 }
 async function assertIdle(member){
  for(const m of await c.ownedSessions(member)){
   if(m.status==='RECORDING')fail('Resume or delete your open recording session before starting another.');
   if(['READY_FOR_TRANSFER','TRANSFERRED_AUDIO_DELETED'].includes(m.status)){
    const r=await c.recordFor(member,m);
    if(!r||r.status==='PROCESSING')fail('A voice profile is already being prepared. Wait for it before starting another recording session.');
   }
  }
 }
 async function creationLock(req,res,next){
  const folder=path.join(c.dataDir,'capture-creation-locks',crypto.createHash('sha256').update(req.memberId).digest('hex'));
  try{await fs.mkdir(path.dirname(folder),{recursive:true});await fs.mkdir(folder);}
  catch(e){if(e.code==='EEXIST')return res.status(409).json({error:'A recording session is being opened for your account. Refresh before trying again.'});return next(e);}
  let released=false;const release=()=>{if(!released){released=true;fs.rmdir(folder).catch(()=>{});}};
  res.once('finish',release);res.once('close',release);next();
 }
 return {enabled,parents,evidence,validateManifest,validatePublication,assertIdle,creationLock};
}
function attachAdditionalTraining(app,c){
 const service=createAdditionalTraining(c);
 app.get('/api/additional-training',c.authenticatedMember,async(req,res,next)=>{try{
  if(!service.enabled())fail('Additional voice training is not enabled yet.',503);
  const rows=await service.parents(req.memberId);
  res.set('Cache-Control','no-store');res.json({ok:true,notice_text:NOTICE,profiles:rows.map(({record:r,manifest:m})=>({voice_profile_id:r.voice_profile_id,created_at:m.created_at,label:r.display_name||'Voice profile',setup:r.recording_setup_summary?.compact_label||'Setup unknown'}))});
 }catch(e){next(e);}});
 app.get('/api/transfer/additional-training/:sessionId',c.transferAuth,async(req,res,next)=>{try{
  if(!c.safeSessionId(req.params.sessionId))fail('Session not found.',404);
  const m=await c.readManifest(req.params.sessionId);
  if(!m.additional_training||m.status!=='TRANSFERRED_AUDIO_DELETED')fail('Verified additional-training transfer is required.');
  const record=await service.validateManifest(m);
  res.set('Cache-Control','no-store');res.json({ok:true,additional_training:m.additional_training,parent:record});
 }catch(e){next(e);}});
 return service;
}
module.exports={NOTICE,SCHEMA,createAdditionalTraining,attachAdditionalTraining};
