'use strict';
// Physical cleanup for an already requested exact profile. Shared consent,
// account/orders, and all retained profiles stay in place.
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const audio=new Set(['.wav','.webm','.m4a','.mp3','.ogg','.flac','.mp4','.audio']);
function fail(message,status=409){const e=new Error(message);e.status=status;throw e;}
function createProfileErasure({dataDir,profiles,store}){
 const root=path.resolve(dataDir),jobDir=path.join(root,'profile-erasure-jobs'),hold=path.join(jobDir,'Maintenance.json');let active=0,busy=false;
 const jobFile=id=>{if(!/^[a-f0-9-]{36}$/.test(id||''))fail('Invalid erasure request ID.',400);return path.join(jobDir,id+'.json');};
 async function read(p){try{return JSON.parse(await fsp.readFile(p,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
 async function save(p,b){await fsp.mkdir(path.dirname(p),{recursive:true,mode:0o700});const t=p+'.'+crypto.randomUUID()+'.tmp';try{const f=await fsp.open(t,'wx',0o600);try{await f.writeFile(JSON.stringify(b,null,2));await f.sync();}finally{await f.close();}await fsp.rename(t,p);}finally{await fsp.unlink(t).catch(e=>{if(e.code!=='ENOENT')throw e;});}}
 function middleware(req,res,next){if(req.path==='/health'||req.path.startsWith('/api/transfer/profile-erasure/')||req.path==='/api/transfer/profile-deletions'||req.path.startsWith('/api/transfer/profile-deletions/'))return next();
  if(fs.existsSync(hold))return res.status(503).json({error:'Voice-data maintenance is in progress. Please try again later.'});
  active++;res.once('finish',()=>active--);next();}
 async function safe(relative){if(typeof relative!=='string'||relative.includes('\\')||relative.split('/').some(v=>!v||v==='.'||v==='..'))fail('Invalid managed audio path.');
  let p=root;for(const part of relative.split('/')){p=path.join(p,part);try{if((await fsp.lstat(p)).isSymbolicLink())fail('Redirected audio requires review.');}catch(e){if(e.code==='ENOENT')break;throw e;}}
  const full=path.resolve(root,relative);if(!full.startsWith(root+path.sep))fail('Managed audio path escapes storage.');return full;}
 async function collect(relative,out){const full=await safe(relative);let s;try{s=await fsp.lstat(full);}catch(e){if(e.code==='ENOENT')return;throw e;}
  if(s.isDirectory()){for(const name of (await fsp.readdir(full)).sort())await collect(relative+'/'+name,out);}
  else if(audio.has(path.extname(relative).toLowerCase())){if(!s.isFile()||s.nlink!==1)fail('Shared/nonregular audio requires review.');
   if(out.length>=10000)fail('Profile audio inventory exceeds its limit.');const b=await fsp.readFile(full);out.push({relative_path:relative,bytes:b.length,sha256:hash(b)});}}
 async function identity(b){if(!b||typeof b.member_id!=='string'||!/^PXC-\d{6}$/.test(b.customer_id||''))fail('Invalid customer identity.',400);
  jobFile(b.request_id);const req=await store.read(b.member_id,b.profile_id);
  if(!req||req.request_id!==b.request_id||req.customer_id!==b.customer_id)fail('An exact customer-requested profile deletion is required.',404);
  const all=await profiles(b.member_id),found=all.filter(x=>x.record.voice_profile_id===b.profile_id);
  if(found.length!==1||found[0].record.voice_model_id!==req.voice_model_id||found[0].record.customer_id!==b.customer_id)fail('Current profile ownership differs.');
  return {req,record:found[0].record,all};}
 async function preview(b){const {req,record,all}=await identity(b);const retained=all.filter(x=>x.record.voice_profile_id!==b.profile_id&&x.record.deletion_status!=='DELETED');
  const roots=[];
  if(req.profile_origin!=='EXISTING_OWNER_TEST'){
   const sharedRaw=retained.some(x=>x.record.session_id===req.session_id&&x.record.profile_origin!=='EXISTING_OWNER_TEST');
   if(!sharedRaw)roots.push('sessions/'+req.session_id);
   const state=await read(await safe('phone-training/'+req.session_id+'/state.json'));
   if(state&&state.model_id===req.voice_model_id&&!retained.some(x=>x.record.voice_model_id===req.voice_model_id))roots.push('phone-training/'+req.session_id);
  }
  const files=[];for(const r of roots)await collect(r,files);
  // An order-message file is keyed by selection. Require both the signed
  // selection's profile identity and the message's exact owner before cleanup.
  let selections=[];try{selections=await fsp.readdir(path.join(root,'song-selections'));}catch(e){if(e.code!=='ENOENT')throw e;}
  for(const name of selections){if(!/^[a-f0-9]{64}\.json$/.test(name))continue;const s=await read(await safe('song-selections/'+name));
   if(s?.owner_member_id!==b.member_id||s.voice_profile_id!==b.profile_id)continue;
   if(!/^[a-f0-9-]{36}$/.test(s.selection_id||''))fail('Invalid owned selection identity.');
   const m=await read(await safe('order-messages/'+s.selection_id+'/State.json'));
   if(m&&(m.owner_member_id!==b.member_id||m.selection_id!==s.selection_id))fail('Order-message ownership differs.');
   if(m){roots.push('order-messages/'+s.selection_id);await collect('order-messages/'+s.selection_id,files);}
  }
  files.sort((a,b)=>a.relative_path.localeCompare(b.relative_path));
  const p={member_id:b.member_id,customer_id:b.customer_id,profile_id:b.profile_id,request_id:b.request_id,
    voice_model_id:req.voice_model_id,session_id:req.session_id,certification_sha256:req.certification_sha256,
    retained_profile_ids:retained.map(x=>x.record.voice_profile_id).sort(),
    retained_models:retained.map(x=>({profile_id:x.record.voice_profile_id,voice_model_id:x.record.voice_model_id,session_id:x.record.session_id,profile_origin:x.record.profile_origin||'CAPTURE_TRAINING',model_sha256:x.record.model_sha256,index_sha256:x.record.index_sha256})),
    roots,files,consent_records_preserved:true,customer_account_preserved:true};
  return {...p,plan_sha256:hash(JSON.stringify(p))};}
 async function exclusive(fn){if(busy)fail('Profile erasure is already active.');busy=true;try{return await fn();}finally{busy=false;}}
 async function freeze(b){return exclusive(async()=>{await identity(b);const old=await read(hold);
  const finished=await read(jobFile(b.request_id));
  if(finished?.phase==='REMOTE_PURGED'){
   if(finished.plan.plan_sha256!==b.plan_sha256||finished.plan.member_id!==b.member_id||finished.plan.profile_id!==b.profile_id)fail('Completed remote erasure identity differs.');
   return finished.plan;
  }
  if(old&&(old.request_id!==b.request_id||old.member_id!==b.member_id||old.profile_id!==b.profile_id))fail('Another profile erasure holds maintenance.');
  if(!old)await save(hold,{request_id:b.request_id,member_id:b.member_id,profile_id:b.profile_id});
  if(active!==0)fail('Regular requests are still draining. Retry the same request.');
  const existing=await read(jobFile(b.request_id));if(existing){if(existing.plan.plan_sha256!==b.plan_sha256)fail('Frozen profile preview differs.');return existing.plan;}
  const p=await preview(b);if(p.plan_sha256!==b.plan_sha256)fail('Profile dependencies or audio changed; refresh its preview.');
  await save(jobFile(b.request_id),{schema_version:'PX-REMOTE-PROFILE-ERASURE-1.0',phase:'FROZEN',plan:p,removed:[]});
  await store.setStatus(b.member_id,b.profile_id,b.request_id,'CLAIMED');return p;});}
 async function purge(b){return exclusive(async()=>{await identity(b);const job=await read(jobFile(b.request_id));
  if(!job||job.plan.plan_sha256!==b.plan_sha256||job.plan.member_id!==b.member_id||job.plan.profile_id!==b.profile_id)fail('Exact frozen profile preview is required.');
  if(job.phase==='REMOTE_PURGED')return {status:'REMOTE_PURGED',request_id:b.request_id,profile_id:b.profile_id,removed_count:job.removed.length,customer_account_preserved:true};
  const holding=await read(hold);if(!holding||holding.request_id!==b.request_id||active!==0)fail('Quiescent profile maintenance is required.');
  for(const f of job.plan.files){const full=await safe(f.relative_path);try{const s=await fsp.lstat(full);if(!s.isFile()||s.nlink!==1)fail('Remote audio became shared/nonregular.');const bytes=await fsp.readFile(full);if(bytes.length!==f.bytes||hash(bytes)!==f.sha256)fail('Remote profile audio changed.');}catch(e){if(e.code==='ENOENT'&&['DELETING','PARTIAL'].includes(job.phase))continue;throw e;}}
  job.phase='DELETING';await save(jobFile(b.request_id),job);
  try{for(const f of job.plan.files){const full=await safe(f.relative_path);let bytes;try{bytes=await fsp.readFile(full);}catch(e){if(e.code!=='ENOENT')throw e;}
    if(bytes&&hash(bytes)!==f.sha256)fail('Audio changed immediately before unlink.');await fsp.unlink(full).catch(e=>{if(e.code!=='ENOENT')throw e;});
    try{await fsp.lstat(full);fail('Audio unlink could not be verified.');}catch(e){if(e.code!=='ENOENT')throw e;}
    if(!job.removed.includes(f.relative_path)){job.removed.push(f.relative_path);(job.removal_events ||= []).push({relative_path:f.relative_path,expected_sha256:f.sha256,observed_at_utc:new Date().toISOString(),outcome:'ABSENCE_VERIFIED'});await save(jobFile(b.request_id),job);}}
   if((await preview(b)).files.length)fail('Unexpected profile audio remains.');
   job.phase='REMOTE_PURGED';job.purged_at=new Date().toISOString();await save(jobFile(b.request_id),job);await fsp.unlink(hold);
   return {status:'REMOTE_PURGED',request_id:b.request_id,profile_id:b.profile_id,removed_count:job.removed.length,customer_account_preserved:true,consent_records_preserved:true};
  }catch(e){job.phase='PARTIAL';await save(jobFile(b.request_id),job);throw e;}});}
 async function complete(b){return exclusive(async()=>{await identity(b);const job=await read(jobFile(b.request_id));
  if(!job||job.phase!=='REMOTE_PURGED'||job.plan.profile_id!==b.profile_id||job.plan.member_id!==b.member_id)fail('Remote erasure has not been verified.');
  if(!/^[a-f0-9]{64}$/.test(b.local_receipt_sha256||'')||!Number.isInteger(b.residual_count)||b.residual_count<0)fail('Verified local receipt evidence is required.');
  const r=await store.setStatus(b.member_id,b.profile_id,b.request_id,b.residual_count?'PARTIAL':'DELETED',
   {local_receipt_sha256:b.local_receipt_sha256,remote_audio_deleted:true,physical_deletion_verified:b.residual_count===0,residual_count:b.residual_count,snapshot_purge_verified:false});
  return {status:r.status,profile_id:r.voice_profile_id,request_id:r.request_id,customer_account_preserved:true,physical_deletion_verified:r.physical_deletion_verified};});}
 async function abort(b){return exclusive(async()=>{await identity(b);const h=await read(hold);
  if(!h)return {ok:true};if(h.request_id!==b.request_id||h.profile_id!==b.profile_id||h.member_id!==b.member_id||await read(jobFile(b.request_id)))fail('Frozen erasure must be resumed.');
  await fsp.unlink(hold);return {ok:true};});}
 function attach(app,auth){for(const [action,fn] of Object.entries({preview,freeze,purge,complete,abort}))app.post('/api/transfer/profile-erasure/'+action,auth,async(req,res,next)=>{try{res.json(await fn(req.body));}catch(e){next(e);}});}
 return {middleware,attach,preview,freeze,purge,complete,abort};
}
module.exports={createProfileErasure};
