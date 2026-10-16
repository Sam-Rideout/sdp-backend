'use strict';
// Profile withdrawal is permanent for this exact profile, never for the account.
// REQUESTED is not a physical-deletion receipt. Cleanup is a separate worker step.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const bounded=v=>typeof v==='string'&&v.trim()===v&&v.length>=3&&v.length<=200&&!/[\x00-\x1f\x7f]/.test(v);
const STATES=new Set(['REQUESTED','CLAIMED','PARTIAL','DELETED']);
function fail(message,status=409){const e=new Error(message);e.status=status;throw e;}
function createProfileDeletionStore(dataDir){
 const root=path.join(dataDir,'profile-deletion-requests');
 const folder=member=>{if(!bounded(member))fail('Invalid profile owner.',400);return path.join(root,hash(member));};
 const filename=(member,id)=>{if(!bounded(id))fail('Invalid voice profile.',400);return path.join(folder(member),hash(id)+'.json');};
 function validate(r,member,id){
  if(!r||r.schema_version!=='PX-PROFILE-DELETION-REQUEST-1.0'||r.owner_member_id!==member||r.voice_profile_id!==id
    ||!bounded(r.voice_model_id)||!/^PXC-\d{6}$/.test(r.customer_id||'')||!STATES.has(r.status)
    ||!bounded(r.session_id)||!bounded(r.request_id)||r.account_deletion!==false)fail('Profile deletion ownership evidence is invalid.');
  return r;
 }
 async function read(member,id){
  const file=filename(member,id);
  try{const s=await fs.lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.size>16384)fail('Invalid profile deletion storage.');
   return validate(JSON.parse(await fs.readFile(file,'utf8')),member,id);
  }catch(e){if(e.code==='ENOENT')return null;throw e;}
 }
 async function assertPublishable(member,record,manifest){
  const id=record.voice_profile_id;
  if(bounded(id)&&await read(member,id))fail('This voice profile has a deletion request.');
  for(const r of await list(member)){
   if(r.session_id===manifest.session_id&&r.profile_origin!=='EXISTING_OWNER_TEST'
      &&record.profile_origin!=='EXISTING_OWNER_TEST'
      &&(!record.voice_model_id||r.voice_model_id===record.voice_model_id))fail('Withdrawn training cannot be republished.');
  }
 }
 async function view(member,record){
  if(!bounded(record.voice_profile_id))return record;
  const r=await read(member,record.voice_profile_id);
  if(!r)return record;
  if(r.voice_model_id!==record.voice_model_id||r.session_id!==record.session_id||r.customer_id!==record.customer_id)fail('Profile deletion no longer matches the published identity.');
  return {...record,status:'REVOKED',deletion_requested:true,deletion_status:r.status};
 }
 async function list(member){
  let names=[];try{names=await fs.readdir(folder(member));}catch(e){if(e.code==='ENOENT')return [];throw e;}
  if(names.length>1000)fail('Profile deletion history requires maintenance.',503);
  const result=[];
  for(const name of names){if(!/^[a-f0-9]{64}\.json$/.test(name))continue;
   const file=path.join(folder(member),name),s=await fs.lstat(file);
   if(!s.isFile()||s.isSymbolicLink()||s.size>16384)fail('Invalid profile deletion history.');
   const r=JSON.parse(await fs.readFile(file,'utf8'));validate(r,member,r.voice_profile_id);
   if(name!==hash(r.voice_profile_id)+'.json')fail('Profile deletion filename identity differs.');result.push(r);
  }
  return result;
 }
 async function exclusive(member,fn){
  const dir=path.join(dataDir,'voice-profile-records',hash(member));await fs.mkdir(dir,{recursive:true,mode:0o700});
  const lock=path.join(dir,'.publish.lock');
  try{await fs.mkdir(lock);}catch(e){if(e.code==='EEXIST')fail('Your voice profiles are being updated. Please retry.');throw e;}
  try{return await fn();}finally{await fs.rmdir(lock);}
 }
 async function requestUnlocked(member,profile){
  const r=profile;
  if(!r||r.owner_member_id!==member||!bounded(r.voice_profile_id)||!bounded(r.voice_model_id)
    ||!/^PXC-\d{6}$/.test(r.customer_id||'')||!bounded(r.session_id)||!bounded(r.certification_id)
    ||!/^[a-f0-9]{64}$/.test(r.certification_sha256||''))fail('An exact owned certified profile is required.',404);
  const existing=await read(member,r.voice_profile_id);
  if(existing){if(existing.voice_model_id!==r.voice_model_id||existing.session_id!==r.session_id||existing.customer_id!==r.customer_id)fail('Existing deletion identity differs.');return existing;}
  if(r.status!=='READY')fail('Only an owned certified profile can be requested for deletion.');
  const entry={schema_version:'PX-PROFILE-DELETION-REQUEST-1.0',request_id:crypto.randomUUID(),
   owner_member_id:member,customer_id:r.customer_id,voice_profile_id:r.voice_profile_id,voice_model_id:r.voice_model_id,
   session_id:r.session_id,profile_origin:r.profile_origin||'CAPTURE_TRAINING',
   certification_id:r.certification_id,certification_sha256:r.certification_sha256,
   status:'REQUESTED',requested_at:new Date().toISOString(),account_deletion:false,physical_deletion_verified:false};
  await fs.mkdir(folder(member),{recursive:true,mode:0o700});
  // Atomic link publishes a complete durable record without overwriting a
  // competing request. A crash cannot expose a partially written JSON record.
  const temp=filename(member,r.voice_profile_id)+'.'+crypto.randomUUID()+'.tmp';
  try{const f=await fs.open(temp,'wx',0o600);try{await f.writeFile(JSON.stringify(entry,null,2)+'\n');await f.sync();}finally{await f.close();}
   try{await fs.link(temp,filename(member,r.voice_profile_id));}catch(e){if(e.code!=='EEXIST')throw e;const prior=await read(member,r.voice_profile_id);if(!prior)throw e;
    if(prior.voice_model_id!==r.voice_model_id||prior.session_id!==r.session_id||prior.customer_id!==r.customer_id)fail('Concurrent deletion identity differs.');return prior;}
  }finally{await fs.unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
  return entry;
 }
 async function pending(){
  let owners=[];try{owners=await fs.readdir(root);}catch(e){if(e.code==='ENOENT')return [];throw e;}
  if(owners.length>10000)fail('Deletion queue requires maintenance.',503);
  const result=[];
  for(const owner of owners){if(!/^[a-f0-9]{64}$/.test(owner))continue;const dir=path.join(root,owner),s=await fs.lstat(dir);if(!s.isDirectory()||s.isSymbolicLink())fail('Invalid deletion owner folder.');
   for(const name of await fs.readdir(dir)){if(!/^[a-f0-9]{64}\.json$/.test(name))continue;
    const file=path.join(dir,name),info=await fs.lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size>16384)fail('Invalid deletion queue file.');
    const r=JSON.parse(await fs.readFile(file,'utf8'));validate(r,r.owner_member_id,r.voice_profile_id);
    if(hash(r.owner_member_id)!==owner||hash(r.voice_profile_id)+'.json'!==name)fail('Deletion queue ownership path differs.');
    if(r.status!=='DELETED')result.push(r);
   }
  }
  if(result.length>1000)fail('Deletion queue needs batching.',503);
  return result.sort((a,b)=>a.requested_at.localeCompare(b.requested_at));
 }
 async function setStatus(member,id,requestId,status,verification={}){
  if(!STATES.has(status))fail('Invalid deletion status.');
  return exclusive(member,async()=>{const r=await read(member,id);
   if(!r||r.request_id!==requestId)fail('Exact profile deletion request is required.');
   if(r.status==='DELETED'&&status!=='DELETED')fail('Completed erasure cannot be reversed.');
   const next={...r,status,updated_at:new Date().toISOString(),...verification};validate(next,member,id);
   const file=filename(member,id),tmp=file+'.'+crypto.randomUUID()+'.tmp';
   try{const f=await fs.open(tmp,'wx',0o600);try{await f.writeFile(JSON.stringify(next,null,2)+'\n');await f.sync();}finally{await f.close();}await fs.rename(tmp,file);}
   finally{await fs.unlink(tmp).catch(e=>{if(e.code!=='ENOENT')throw e;});}return next;});
 }
 const request=(member,profile)=>exclusive(member,()=>requestUnlocked(member,profile));
 return {read,list,view,request,assertPublishable,pending,exclusive,setStatus};
}
function attachProfileDeletion(app,c){
 const store=createProfileDeletionStore(c.dataDir);
 app.post('/api/wix/request-profile-deletion',async(req,res,next)=>{try{
  const t=c.verifySigned(req.body?.ticket),now=Math.floor(Date.now()/1000);
  if(!t||t.iss!=='wix'||t.aud!=='project-x-catalog'||t.purpose!=='profile-deletion-request'
    ||!bounded(t.sub)||!bounded(t.voice_profile_id)||t.confirm_profile_deletion!==true
    ||!Number.isInteger(t.iat)||!Number.isInteger(t.exp)||t.iat>now+60||t.iat<now-180||t.exp<=now
    ||t.exp>now+180||t.exp<=t.iat||!/^[a-f0-9]{48}$/.test(t.jti||''))return res.status(401).json({error:'Profile deletion authorization failed.'});
  if(!await c.consumeTicket(t.jti))return res.status(401).json({error:'Profile deletion authorization was already used.'});
  await c.pruneOldReplayMarkers();
  const matches=(await c.profiles(t.sub)).filter(x=>x.record.voice_profile_id===t.voice_profile_id);
  if(matches.length!==1)return res.status(404).json({error:'This voice profile is unavailable for your account.'});
  const r=await store.request(t.sub,matches[0].record);
  res.set('Cache-Control','no-store');res.json({ok:true,status:r.status,request_id:r.request_id,
    voice_profile_id:r.voice_profile_id,account_deleted:false,physical_deletion_verified:false});
 }catch(e){next(e);}});
 app.get('/api/transfer/profile-deletions',c.transferAuth,async(req,res,next)=>{try{res.json({requests:await store.pending()});}catch(e){next(e);}});
 return store;
}
module.exports={createProfileDeletionStore,attachProfileDeletion};
