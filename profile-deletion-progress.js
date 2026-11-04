'use strict';
// Private request-scoped progress. Member identity is signed by Wix, never taken
// from a browser-supplied customer ID. Publishing is restricted to the PC bridge.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const text=v=>typeof v==='string'&&v.length>=3&&v.length<=240&&v.trim()===v&&!/[\x00-\x1f\x7f]/.test(v);
const STATES=new Set(['WAITING_FOR_PROCESSING','RUNNING','INTERRUPTED','REVIEW_REQUIRED','RETENTION_PENDING','ACTIVE_DELETION_VERIFIED']);
const CATEGORIES=new Set(['capture_recordings','trained_models_and_features','working_audio','historical_qa','registry_metadata','remote_active_copies','local_master_copies','improvement_copies','finished_song_retention']);
const SUMMARY={REQUESTED:'Your deletion request is saved. Waiting for the processing workstation.',
 WAITING_FOR_PROCESSING:'Waiting for active processing to finish.',RUNNING:'Removing and checking this profile’s voice data.',
 INTERRUPTED:'Deletion stopped before completion. Your request remains saved for recovery.',
 REVIEW_REQUIRED:'Some required data still needs review. Deletion is incomplete.',
 RETENTION_PENDING:'Some data has a separate verified retention deadline. Deletion is not complete yet.',
 ACTIVE_DELETION_VERIFIED:'Deletion has been verified for the required active data categories.',
 LEGACY_COMPLETION_UNVERIFIED:'An earlier cleanup was recorded. Full data coverage has not yet been verified.'};
function fail(message,status=409){const e=new Error(message);e.status=status;throw e;}
async function ordinary(p,directory){const s=await fs.lstat(p);if(s.isSymbolicLink()||(directory?!s.isDirectory():!s.isFile()))fail('Private deletion report storage is unavailable.',503);return s;}
function createProgressStore(dataDir,requests){
 if(typeof dataDir!=='string'||!path.isAbsolute(dataDir))throw new Error('Absolute private data directory required.');
 const root=path.join(dataDir,'profile-deletion-progress');
 async function location(member,profile,requestId,create=false){
  if(!text(member)||!text(profile)||!UUID.test(requestId||''))fail('Invalid deletion report identity.',400);
  // Do not traverse a linked component, even if the final JSON is ordinary.
  let ancestor=path.resolve(dataDir);for(;;){await ordinary(ancestor,true);const parent=path.dirname(ancestor);if(parent===ancestor)break;ancestor=parent;}
  const dirs=[root,path.join(root,sha(member))];
  for(const dir of dirs){if(create)await fs.mkdir(dir,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});await ordinary(dir,true);}
  return path.join(dirs[1],sha(profile+'\0'+requestId)+'.json');
 }
 async function exact(member,profile,requestId,customer){
  const r=await requests.read(member,profile);
  if(!r||r.request_id!==requestId||(customer!==undefined&&r.customer_id!==customer))fail('Deletion request not found for this account.',404);
  return r;
 }
 async function read(member,profile,requestId){
  await exact(member,profile,requestId);
  try{
   const file=await location(member,profile,requestId);const s=await ordinary(file,false);
   if(s.size>65536)fail('Deletion report is too large.',503);
   const report=JSON.parse(await fs.readFile(file,'utf8'));
   if(report.owner_member_id!==member||report.profile_id!==profile||report.request_id!==requestId)fail('Deletion report identity differs.');
   return report;
  }catch(e){if(e.code==='ENOENT')return null;throw e;}
 }
 function validate(b){
  const keys=['schema_version','customer_id','member_id','profile_id','request_id','operation_id','revision','state','removed_count','remaining_categories','evidence_sha256'];
  if(!b||Object.keys(b).sort().join()!==keys.sort().join()||b.schema_version!=='PX-PROFILE-DELETION-PROGRESS-2.0'
   ||!/^PXC-\d{6}$/.test(b.customer_id||'')||!text(b.member_id)||!text(b.profile_id)||!UUID.test(b.request_id||'')||!UUID.test(b.operation_id||'')
   ||!Number.isSafeInteger(b.revision)||b.revision<1||!STATES.has(b.state)||!Number.isSafeInteger(b.removed_count)||b.removed_count<0
   ||!Array.isArray(b.remaining_categories)||b.remaining_categories.length>9||new Set(b.remaining_categories).size!==b.remaining_categories.length
   ||b.remaining_categories.some(v=>!CATEGORIES.has(v))||!/^[a-f0-9]{64}$/.test(b.evidence_sha256||''))fail('Invalid deletion progress report.',400);
  if(b.state==='ACTIVE_DELETION_VERIFIED'&&b.remaining_categories.length)fail('Incomplete coverage cannot be reported as verified.',400);
 }
 async function publish(body){
  validate(body);await exact(body.member_id,body.profile_id,body.request_id,body.customer_id);
  return requests.exclusive(body.member_id,async()=>{
   // Recheck after acquiring the same lock used for the withdrawal record.
   await exact(body.member_id,body.profile_id,body.request_id,body.customer_id);
   const old=await read(body.member_id,body.profile_id,body.request_id);
   const incoming=sha(JSON.stringify(body));
   if(old){
    if(old.payload_sha256===incoming)return old;
    if(old.operation_id!==body.operation_id)fail('A different operation already owns this request report.');
    if(body.revision<=old.revision)fail('An older progress report cannot overwrite newer evidence.');
    if(old.state==='ACTIVE_DELETION_VERIFIED')fail('A verified result cannot be overwritten by a later unreviewed report.');
   }
   const file=await location(body.member_id,body.profile_id,body.request_id,true);
   const next={...body,owner_member_id:body.member_id,payload_sha256:incoming,received_at:new Date().toISOString()};
   const temp=file+'.'+crypto.randomUUID()+'.tmp';
   try{const f=await fs.open(temp,'wx',0o600);try{await f.writeFile(JSON.stringify(next));await f.sync();}finally{await f.close();}await fs.rename(temp,file);}
   finally{await fs.unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
   return next;
  });
 }
 function publicView(request,report){
  const state=report?.state||(request.status==='DELETED'?'LEGACY_COMPLETION_UNVERIFIED':'REQUESTED');
  return {ok:true,request_id:request.request_id,voice_profile_id:request.voice_profile_id,state,message:SUMMARY[state],
    removed_count:report?.removed_count??0,remaining_categories:report?.remaining_categories??[],
    updated_at:report?.received_at||request.updated_at||request.requested_at,
    active_deletion_verified:state==='ACTIVE_DELETION_VERIFIED',backup_purge_verified:false,
    consent_record_retention:'Minimal consent and deletion evidence is retained under the applicable record-retention policy.'};
 }
 return{read,publish,exact,publicView};
}
function attachDeletionProgress(app,c,requests){
 const reports=createProgressStore(c.dataDir,requests);
 app.post('/api/wix/profile-deletion-progress',async(req,res,next)=>{try{
  if(!req.body||Object.keys(req.body).join()!=='ticket')fail('Signed account authorization is required.',400);
  const t=c.verifySigned(req.body.ticket),now=Math.floor(Date.now()/1000);
  if(!t||t.iss!=='wix'||t.aud!=='project-x-catalog'||t.purpose!=='profile-deletion-progress'||!text(t.sub)||!text(t.voice_profile_id)
   ||(t.request_id!==undefined&&!UUID.test(t.request_id))||!Number.isInteger(t.iat)||!Number.isInteger(t.exp)||t.iat>now+60||t.iat<now-180||t.exp<=now||t.exp>now+180||t.exp<=t.iat
   ||!/^[a-f0-9]{48}$/.test(t.jti||''))fail('Profile deletion progress authorization failed.',401);
  if(!await c.consumeTicket(t.jti))fail('Profile deletion progress authorization was already used.',401);
  const selected=await requests.read(t.sub,t.voice_profile_id);
  if(!selected)fail('Deletion request not found for this account.',404);
  const r=await reports.exact(t.sub,t.voice_profile_id,t.request_id||selected.request_id);
  const report=await reports.read(t.sub,t.voice_profile_id,r.request_id);
  res.set('Cache-Control','no-store');res.json(reports.publicView(r,report));
 }catch(e){next(e);}});
 app.post('/api/transfer/profile-deletion-progress',c.transferAuth,async(req,res,next)=>{try{
  const r=await reports.publish(req.body);res.set('Cache-Control','no-store');
  res.json({ok:true,request_id:r.request_id,profile_id:r.profile_id,operation_id:r.operation_id,revision:r.revision,state:r.state});
 }catch(e){next(e);}});
 return reports;
}
module.exports={createProgressStore,attachDeletionProgress};
