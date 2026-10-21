'use strict';
// Order-specific spoken input only. Never creates training sessions or starts production.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {validateRecord, matchesProfile} = require('./song-selection-transfer');
const hash = v => crypto.createHash('sha256').update(v).digest('hex');
const uuid = v => typeof v==='string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const TYPES = new Set(['audio/webm','audio/mp4','audio/ogg','audio/wav']);
const VERSION = 'PX-ORDER-MESSAGE-1.0';
const CONSENT = 'order-message-only-2026-10-15-v1';
function fail(message, status=409){ const e=new Error(message);e.status=status;throw e; }
async function read(file){try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function write(file,body){const t=file+'.'+crypto.randomUUID()+'.tmp';try{await fs.writeFile(t,JSON.stringify(body),{flag:'wx',mode:0o600});await fs.rename(t,file);}finally{await fs.unlink(t).catch(e=>{if(e.code!=='ENOENT')throw e;});}}
function attachBirthdayMessage(app,c){
 const root=path.join(c.dataDir,'order-messages');
 const folder=id=>{if(!uuid(id))fail('Invalid song selection.',400);return path.join(root,id);};
 const statePath=id=>path.join(folder(id),'State.json');
 async function selection(id,owner){
  if(!uuid(id))fail('Invalid song selection.',400);
  let entries=[];try{entries=await fs.readdir(path.join(c.dataDir,'song-selections'),{withFileTypes:true});}catch(e){if(e.code!=='ENOENT')throw e;}
  if(entries.length>5000)fail('Song selection lookup requires maintenance.',503);
  for(const e of entries){
   if(!/^[a-f0-9]{64}\.json$/.test(e.name))continue;
   if(!e.isFile())fail('Invalid song selection storage.',503);
   const p=path.join(c.dataDir,'song-selections',e.name);if((await fs.stat(p)).size>16384)fail('Invalid song selection storage.',503);
   const r=await read(p);validateRecord(r,e.name);
   if(r.selection_id===id && r.owner_member_id===owner)return {record:r,sha256:hash(await fs.readFile(p))};
  }
  fail('This song selection is unavailable for your account.',404);
 }
 async function linkedOrders(owner,id){
  const s=await read(path.join(c.dataDir,'order-status',hash(owner)+'.json'));
  if(!s)return [];
  if(s.owner_member_id!==owner || !Array.isArray(s.orders))fail('Order ownership could not be checked.',503);
  return s.orders.filter(o=>o.selection_id===id);
 }
 async function withdrawn(owner,id,orders){
  const {readCancel}=require('./wix-cancel');
  const all=[await readCancel(c.dataDir,owner,'SELECTION',id)];
  for(const o of orders)all.push(await readCancel(c.dataDir,owner,'ORDER',o.order_id));
  return all.some(r=>r && r.status!=='TOO_LATE');
 }
 async function lock(id,fn){
  const d=folder(id);await fs.mkdir(d,{recursive:true,mode:0o700});const p=path.join(d,'.lock');
  try{await fs.mkdir(p);}catch(e){if(e.code==='EEXIST')fail('Your message is being saved. Please try again.');throw e;}
  try{return await fn();}finally{await fs.rmdir(p);}
 }
 async function state(id,sel){
  const s=await read(statePath(id));
  if(s && (s.schema_version!==VERSION || s.selection_id!==id || s.owner_member_id!==sel.record.owner_member_id || s.selection_sha256!==sel.sha256 || s.px_song_id!==sel.record.px_song_id))fail('Message ownership evidence changed.');
  return s || {schema_version:VERSION,selection_id:id,owner_member_id:sel.record.owner_member_id,
    selection_sha256:sel.sha256,px_song_id:sel.record.px_song_id,choice:'NONE',claim_id:null,audio:null,updated_at:new Date().toISOString()};
 }
 async function purgeAudio(id,s){
  if(s.audio && uuid(s.audio.clip_id))await fs.unlink(path.join(folder(id),s.audio.clip_id+'.audio')).catch(e=>{if(e.code!=='ENOENT')throw e;});
 }
 async function available(id,owner,editing=false,held=false){
  const sel=await selection(id,owner);const orders=await linkedOrders(owner,id);const s=await state(id,sel);
  if(await withdrawn(owner,id,orders)){
   const cleanup=async()=>{const latest=await state(id,sel);if(!latest.claim_id && latest.audio){await purgeAudio(id,latest);latest.audio=null;latest.choice='WITHDRAWN';await write(statePath(id),latest);}};
   if(held)await cleanup();else await lock(id,cleanup);
   fail('This song request has been withdrawn.');
  }
  if(editing){
   if(s.commit_id || s.claim_id || orders.length)fail('This message is locked for its order. Choose a new song request to record another message.');
   if(sel.record.product_type!=='ORIGINAL_MESSAGE'&&!matchesProfile(sel.record,await c.readyProfile(owner,sel.record.voice_profile_id)))fail('Your saved voice profile must be READY for this song selection.');
  }
  return {sel,s,orders};
 }
 function publicState(s,orders=[]){return {selection_id:s.selection_id,song_id:s.px_song_id,choice:s.choice,
   locked:Boolean(s.commit_id||s.claim_id||orders.length),committed:Boolean(s.commit_id),clip_id:s.audio?.clip_id||'',duration_seconds:s.audio?.duration_seconds||0,
   audio_available:Boolean(s.audio&&!s.audio.deleted_at),updated_at:s.updated_at};}
 const browser=[c.authenticatedMember,c.requireCaptureAccess];
 const modify=[...browser,c.requireSameOrigin,(req,res,next)=>req.get('X-PX-Message')==='1'?next():res.status(403).json({error:'Message request could not be verified.'})];
 app.get('/birthday-message',(req,res)=>res.sendFile(path.join(c.root,'public','birthday-message.html')));
 app.get('/api/birthday-message/:selectionId',...browser,async(req,res,next)=>{try{
  const result=await available(req.params.selectionId,req.memberId);res.json({ok:true,...publicState(result.s,result.orders),consent_version:CONSENT});
 }catch(e){next(e);}});
 const upload=c.multer({storage:c.multer.memoryStorage(),limits:{fileSize:2*1024*1024,files:1,fields:4,fieldSize:256}}).single('audio');
 app.post('/api/birthday-message/:selectionId/audio',...modify,upload,async(req,res,next)=>{try{
  const id=req.params.selectionId;
  await lock(id,async()=>{
   const {s}=await available(id,req.memberId,true,true);
   const duration=Number(req.body.duration_seconds);const mime=String(req.file?.mimetype||'').split(';')[0];
   if(!req.file || req.file.size<256 || req.file.size>2*1024*1024 || !TYPES.has(mime) || !Number.isFinite(duration)||duration<.1||duration>8.25 || req.body.consent_version!==CONSENT)fail('Record a message of up to eight seconds and approve its use for this song.',400);
   if((await c.directoryBytes(c.dataDir))+req.file.size>c.maxStoreBytes)fail('Recording storage is full. Contact Project X.',507);
   const clip=crypto.randomUUID();const audio={clip_id:clip,mime_type:mime,sha256:hash(req.file.buffer),size_bytes:req.file.size,duration_seconds:duration,
    consent_version:CONSENT,consent_accepted_at:new Date().toISOString(),excluded_from_training:true};
   const file=path.join(folder(id),clip+'.audio');await fs.writeFile(file,req.file.buffer,{flag:'wx',mode:0o600});
   const old={...s};s.choice='RECORDED';s.audio=audio;s.updated_at=new Date().toISOString();
   try{await write(statePath(id),s);}catch(e){await fs.unlink(file);throw e;}
   if(old.audio)await purgeAudio(id,old);
   res.json({ok:true,...publicState(s)});
  });
 }catch(e){next(e);}});
 app.post('/api/birthday-message/:selectionId/skip',...modify,async(req,res,next)=>{try{
  await lock(req.params.selectionId,async()=>{
   const {s}=await available(req.params.selectionId,req.memberId,true,true);const old={...s};
   s.audio=null;s.choice='SKIPPED';s.updated_at=new Date().toISOString();await write(statePath(s.selection_id),s);await purgeAudio(s.selection_id,old);
   res.json({ok:true,...publicState(s)});
  });
 }catch(e){next(e);}});
 app.get('/api/birthday-message/:selectionId/audio/:clipId',...browser,async(req,res,next)=>{try{
  const {s}=await available(req.params.selectionId,req.memberId);
  if(!s.audio||s.audio.clip_id!==req.params.clipId||s.audio.deleted_at)fail('This message audio is unavailable.',404);
  res.type(s.audio.mime_type).sendFile(path.join(folder(s.selection_id),s.audio.clip_id+'.audio'));
 }catch(e){next(e);}});
 app.post('/api/transfer/song-messages/:selectionId/claim',c.transferAuth,async(req,res,next)=>{try{
  const id=req.params.selectionId;const {owner_member_id:owner,claim_id:claim}=req.body||{};
  if(!uuid(claim))fail('Invalid message claim.',400);
  await lock(id,async()=>{
   const {sel,s,orders}=await available(id,owner,false,true);
   if(s.claim_id && s.claim_id!==claim)fail('This message is already locked by another processing request.');
   if(!s.claim_id && orders.length)fail('An order already exists for this selection.');
   if(!s.claim_id){
    if(sel.record.product_type!=='ORIGINAL_MESSAGE'&&!matchesProfile(sel.record,await c.readyProfile(owner,sel.record.voice_profile_id)))fail('The selection no longer matches the READY profile.');
    s.claim_id=claim;if(s.choice==='NONE')s.choice='SKIPPED';s.claimed_at=new Date().toISOString();s.updated_at=s.claimed_at;await write(statePath(id),s);
   }
   res.json({ok:true,message:s});
  });
 }catch(e){next(e);}});
 app.get('/api/transfer/song-messages/:selectionId/audio/:clipId',c.transferAuth,async(req,res,next)=>{try{
  const s=await read(statePath(req.params.selectionId));
  if(!s||!s.claim_id||s.claim_id!==req.query.claim||s.audio?.clip_id!==req.params.clipId||s.audio.deleted_at)fail('Claimed message audio is unavailable.',404);
  await available(s.selection_id,s.owner_member_id);
  const f=path.join(folder(s.selection_id),s.audio.clip_id+'.audio');
  if(hash(await fs.readFile(f))!==s.audio.sha256)fail('Message audio failed its integrity check.');
  res.set('X-Content-SHA256',s.audio.sha256).type(s.audio.mime_type).sendFile(f);
 }catch(e){next(e);}});
 app.post('/api/transfer/song-messages/:selectionId/receipt',c.transferAuth,async(req,res,next)=>{try{
  await lock(req.params.selectionId,async()=>{
   const s=await read(statePath(req.params.selectionId));const b=req.body||{};
   if(!s||s.claim_id!==b.claim_id||s.owner_member_id!==b.owner_member_id||s.audio?.clip_id!==b.clip_id||s.audio.sha256!==b.source_sha256
     || !/^[a-f0-9]{64}$/.test(b.wav_sha256)||!Number.isFinite(b.decoded_seconds)||b.decoded_seconds<.1||b.decoded_seconds>8.25)fail('Message transfer receipt does not match.');
   // Save the verification receipt before deletion. A retry completes any interrupted unlink.
   if(s.transfer && (s.transfer.wav_sha256!==b.wav_sha256||s.transfer.source_sha256!==b.source_sha256))fail('Message transfer receipt changed.');
   s.transfer={source_sha256:b.source_sha256,wav_sha256:b.wav_sha256,decoded_seconds:b.decoded_seconds};await write(statePath(s.selection_id),s);
   await purgeAudio(s.selection_id,s);s.audio.deleted_at=s.audio.deleted_at||new Date().toISOString();s.updated_at=new Date().toISOString();await write(statePath(s.selection_id),s);
   res.json({ok:true,status:'TRANSFERRED_AUDIO_DELETED',selection_id:s.selection_id,clip_id:s.audio.clip_id});
  });
 }catch(e){next(e);}});
 return {async freezeForCommit(owner,id,expectedCustomerId){
  return lock(id,async()=>{
   if(expectedCustomerId!==undefined){const checked=await selection(id,owner);if(checked.record.customer_id!==expectedCustomerId)fail('Song selection ownership differs from the approved customer.');}
   const {sel,s,orders}=await available(id,owner,false,true);
   if(s.commit_id===id)return {selection:sel.record,selection_sha256:sel.sha256,message:{choice:s.choice,clip_id:s.audio?.clip_id||'',sha256:s.audio?.sha256||''}};
   if(s.claim_id||orders.length)fail('This song selection already has an order.');
   if(sel.record.product_type!=='ORIGINAL_MESSAGE'&&!matchesProfile(sel.record,await c.readyProfile(owner,sel.record.voice_profile_id)))fail('Your voice profile must be READY.');
   if(!['RECORDED','SKIPPED'].includes(s.choice))fail('Record your message or choose Continue without a message first.');
   s.commit_id=id;s.committed_at=new Date().toISOString();await write(statePath(id),s);
   return {selection:sel.record,selection_sha256:sel.sha256,message:{choice:s.choice,clip_id:s.audio?.clip_id||'',sha256:s.audio?.sha256||''}};
  });
 },async summaryFor(owner,id){
  if(!uuid(id))return null;
  try{const {s,orders}=await available(id,owner);return {...publicState(s,orders),can_record:!s.commit_id&&!s.claim_id&&!orders.length};}
  catch(e){if([404,409].includes(e.status))return {choice:'UNAVAILABLE',locked:true,can_record:false};throw e;}
 }};
}
module.exports={attachBirthdayMessage,uuid,CONSENT};
