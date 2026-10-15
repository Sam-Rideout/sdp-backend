'use strict';
// Explicit migration of Sam's existing retained PC model into his test account.
// This does not create phone-training evidence or release a real-customer model.
const crypto=require('node:crypto');
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const MODEL='TRN-PC-19c512ae-af53-4280-a1e3-f93733a1391c';
const EXPECTED={model:'724883bdc78f28d8c8d43742c4a9c2fce61ecd87406ba526e2a22079588430c1',index:'742958c014bbdf8bc8bcd2610e71dc90ec65f16176eb98cb00730c8cf2fb9a5b'};
function canonical(value){
 if(Array.isArray(value))return value.map(canonical);
 if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));
 return value;
}
const consentHash=value=>hash(JSON.stringify(canonical(value)));
function validateExisting(record,manifest){
 if(!record||record.profile_origin!=='EXISTING_OWNER_TEST'||record.account_test_only!==true
  ||record.scope!=='SAM_COMPLIMENTARY_ACCOUNT_TEST'
  ||typeof record.owner_member_id!=='string'||record.owner_member_id.length<3||record.owner_member_id.length>200
  ||!/^PXC-\d{6}$/.test(record.customer_id||'')
  ||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(record.session_id||'')
  ||record.consent_session_id!==record.session_id
  ||record.voice_model_id!==MODEL||record.voice_profile_id!=='PXPITCH-'+MODEL
  ||record.model_sha256!==EXPECTED.model||record.index_sha256!==EXPECTED.index
  ||!/^PXCERT-[A-F0-9]{32}$/.test(record.certification_id||'')
  ||!/^[a-f0-9]{64}$/.test(record.certification_sha256||'')
  ||!/^[a-f0-9]{64}$/.test(record.consent_sha256||'')
  ||!manifest||manifest.owner_member_id!==record.owner_member_id||manifest.session_id!==record.session_id
  ||manifest.program!=='CUSTOMER'||manifest.status!=='TRANSFERRED_AUDIO_DELETED'){
  throw new Error('Existing PC profile ownership or scope is invalid.');
 }
}
function attachExistingProfileStatus(app,c,catalog){
 app.post('/api/transfer/existing-voice-profiles',c.transferAuth,async(req,res,next)=>{try{
  const b=req.body||{};
  if(typeof b.certificate_json!=='string'||Buffer.byteLength(b.certificate_json)>16384
    ||hash(Buffer.from(b.certificate_json))!==b.certification_sha256
    ||b.certification_id!=='PXCERT-'+String(b.certification_sha256).slice(0,32).toUpperCase()){
   return res.status(400).json({error:'Invalid existing-profile binding bytes.'});
  }
  let e;try{e=JSON.parse(b.certificate_json);}catch{return res.status(400).json({error:'Invalid existing-profile binding JSON.'});}
  if(e.schema_version!=='PX-EXISTING-VOICE-OWNER-TEST-1.0'||e.status!=='BOUND_FOR_ACCOUNT_TEST'
    ||e.original_authorization_reference!=='SAM_RIDEOUT_OWNER_TEST_20261003'
    ||e.owner_assertion_reference!=='SAM_RIDEOUT_JOB20_PC_PROFILE_20261015'){
   return res.status(400).json({error:'Existing owner-test binding authority is invalid.'});
  }
  if(!c.customerTestAccess({memberId:e.owner_member_id,memberEmail:e.account_email})) {
   return res.status(403).json({error:'Existing-model publication is restricted to the approved complimentary account test.'});
  }
  if(!c.safeSessionId(e.session_id))return res.status(400).json({error:'Invalid consent session.'});
  const manifest=await c.readManifest(e.session_id);
  const record={schema_version:'PX-VOICE-PROFILE-STATUS-1.0',status:b.status==='REVOKED'?'REVOKED':'READY',
    profile_origin:e.profile_origin,account_test_only:e.account_test_only,scope:e.scope,
    owner_member_id:e.owner_member_id,customer_id:e.customer_id,session_id:e.session_id,
    consent_session_id:e.consent_session_id,consent_sha256:e.consent_sha256,
    voice_profile_id:e.voice_profile_id,voice_model_id:e.voice_model_id,
    model_sha256:e.model_sha256,index_sha256:e.index_sha256,
    certification_id:b.certification_id,certification_sha256:b.certification_sha256,
    display_name:'Sam Rideout — Tier 1 PC',updated_at:new Date().toISOString(),
    created_at:e.calibration_created_at||manifest.created_at};
  try { validateExisting(record,manifest); }
  catch { return res.status(400).json({error:'Existing PC profile ownership or scope is invalid.'}); }
  const linked=await catalog.recordFor(record.owner_member_id,manifest);
  if(!linked||linked.customer_id!==record.customer_id||linked.owner_member_id!==record.owner_member_id) {
   return res.status(409).json({error:'An existing verified member/customer profile link is required.'});
  }
  const consent=manifest.consent;
  if(!consent||consent.accepted!==true||consent.current_order!==true||consent.adult_confirmed!==true
    ||consent.own_voice_confirmed!==true||consent.retention_choice!=='FUTURE_PURCHASES'
    ||consentHash(consent)!==record.consent_sha256){
   return res.status(409).json({error:'Current own-voice retention consent does not match the PC binding.'});
  }
  if(b.status!==undefined&&!['READY','REVOKED'].includes(b.status))return res.status(400).json({error:'Invalid existing-profile status.'});
  await catalog.publishExisting(record);
  res.json({ok:true,status:record.status,voice_profile_id:record.voice_profile_id,account_test_only:true});
 }catch(e){if(e.code==='ENOENT')return res.status(404).json({error:'Owned consent session not found.'});next(e);}});
}
module.exports={attachExistingProfileStatus,validateExisting,consentHash};
