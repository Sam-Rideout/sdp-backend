'use strict';
// Explicit account-test commits only; never launches local audio processing.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {uuid}=require('./birthday-message');
const songAccess=require('./complimentary-song-access');
const member=s=>typeof s==='string'&&s.length>=3&&s.length<=200&&!/[\x00-\x1f\x7f]/.test(s)&&s.trim()===s;
function error(message,status=409){const e=new Error(message);e.status=status;throw e;}
async function read(p){try{return JSON.parse(await fs.readFile(p,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function write(p,v){await fs.mkdir(path.dirname(p),{recursive:true,mode:0o700});const tmp=p+'.'+crypto.randomUUID()+'.tmp';try{await fs.writeFile(tmp,JSON.stringify(v),{flag:'wx',mode:0o600});await fs.rename(tmp,p);}finally{await fs.unlink(tmp).catch(e=>{if(e.code!=='ENOENT')throw e;});}}
const publicState=r=>r?{selection_id:r.selection_id,state:r.state,order_id:r.order_id||'',updated_at:r.updated_at}:null;
function authorized(c,now){return Boolean(c&&c.iss==='wix'&&c.aud==='project-x-orders'&&c.purpose==='create-song'&&member(c.sub)&&uuid(c.selection_id)&&typeof c.email==='string'&&c.email.length<=254&&Number.isInteger(c.iat)&&Number.isInteger(c.exp)&&c.iat<=now+60&&c.iat>=now-180&&c.exp>now&&c.exp<=now+180&&c.exp>c.iat&&/^[a-f0-9]{48}$/.test(c.jti||''));}
function attachCreateSong(app,c){
 const root=path.join(c.dataDir,'song-commits');
 const access=c.songAccess || songAccess.createAccess();
 const accountGate=require('./account-song-limit').createAccountSongGate(c.dataDir);
 const file=id=>{if(!uuid(id))error('Invalid selection.',400);return path.join(root,id+'.json');};
 async function lock(id,fn){await fs.mkdir(root,{recursive:true,mode:0o700});const p=file(id)+'.lock';try{await fs.mkdir(p);}catch(e){if(e.code==='EEXIST')error('Song request is being saved. Refresh shortly.');throw e;}try{return await fn();}finally{await fs.rmdir(p);}}
 async function owned(id,owner){const r=await read(file(id));if(r&&(r.schema_version!=='PX-CREATE-SONG-1.0'||r.selection_id!==id||r.owner_member_id!==owner))error('Song request is unavailable.',404);return r;}
 async function withdrawn(r){const {readCancel}=require('./wix-cancel');const s=await readCancel(c.dataDir,r.owner_member_id,'SELECTION',r.selection_id);const o=r.order_id?await readCancel(c.dataDir,r.owner_member_id,'ORDER',r.order_id):null;return [s,o].some(v=>v&&v.status!=='TOO_LATE');}
 app.post('/api/wix/create-song',async(req,res,next)=>{try{
  const a=c.verifySigned(req.body?.ticket);if(!authorized(a,Math.floor(Date.now()/1000)))return res.status(401).json({error:'Song creation authorization failed.'});
  const approved=access.account(a.sub,a.email);
  if(!approved)return res.status(403).json({code:'SONG_CREATION_NOT_AUTHORIZED',error:'Song creation is not enabled for this account yet. Please contact Project X.'});
  if(!await c.consumeTicket(a.jti))return res.status(401).json({error:'Authorization already used. Refresh your orders.'});
  await accountGate.exclusive(a.sub,()=>lock(a.selection_id,async()=>{
   let r=await owned(a.selection_id,a.sub);
   if(r){
    if(await withdrawn(r))error('This song request has been withdrawn.');
    const auth=r.test_authorization,expected=songAccess.evidence(approved);
    if(r.frozen?.selection?.customer_id!==approved.customer_id ||
       (auth ? JSON.stringify(Object.keys(auth).sort().map(k=>[k,auth[k]]))!==JSON.stringify(Object.keys(expected).sort().map(k=>[k,expected[k]])) : !approved.allow_legacy_commands))error('Saved song authorization differs from the approved customer.');
    return res.json({ok:true,creation:publicState(r)});
   }
   await accountGate.assertAvailable(a.sub,a.selection_id);
   // Freeze uses the recorder's own file lock. If publication is interrupted,
   // repeating the same selection recovers the already frozen message choice.
   const frozen=await c.freezeMessage(a.sub,a.selection_id,approved.customer_id);
   if(frozen.selection?.customer_id!==approved.customer_id || frozen.selection?.owner_member_id!==approved.wix_member_id)error('Song selection ownership differs from the approved customer.');
   const currentApproval=access.account(a.sub,a.email);
   if(!currentApproval || JSON.stringify(songAccess.evidence(currentApproval))!==JSON.stringify(songAccess.evidence(approved)))error('Song test authorization changed. Please refresh your orders.');
   r={schema_version:'PX-CREATE-SONG-1.0',selection_id:a.selection_id,owner_member_id:a.sub,
    mode:'ACCOUNT_TEST',authorize_comped:true,authorize_test_email:true,state:'REQUESTED',
    test_authorization:songAccess.evidence(approved),
    frozen,requested_at:new Date().toISOString(),updated_at:new Date().toISOString(),claim_id:null,order_id:'',run_id:''};
   await write(file(r.selection_id),r);res.json({ok:true,creation:publicState(r)});
  }));
 }catch(e){
  if(['ACTIVE_SONG_LIMIT','SONG_REQUEST_IN_PROGRESS','SONG_STATUS_UNAVAILABLE'].includes(e.code))return res.status(e.status||409).json({ok:false,code:e.code,error:e.message});
  next(e);
 }});
 app.get('/api/transfer/song-commits/:memberId',c.transferAuth,async(req,res,next)=>{try{
  const owner=req.params.memberId;if(!member(owner))error('Invalid owner.',400);
  let files=[];try{files=await fs.readdir(root);}catch(e){if(e.code!=='ENOENT')throw e;}
  files=files.filter(n=>/^[a-f0-9-]{36}\.json$/.test(n));if(files.length>5000)error('Song commit archive needs maintenance.',503);
  const commands=[];for(const n of files){const r=await read(path.join(root,n));if(r.owner_member_id===owner&&['REQUESTED','WORKING'].includes(r.state))commands.push(r);}
  commands.sort((a,b)=>a.requested_at.localeCompare(b.requested_at));if(commands.length>100)error('Song commit queue requires pagination.',503);
  res.json({ok:true,owner_member_id:owner,commands});
 }catch(e){next(e);}});
 app.post('/api/transfer/song-commits/:selectionId/claim',c.transferAuth,async(req,res,next)=>{try{
  await lock(req.params.selectionId,async()=>{
   const b=req.body||{};if(!uuid(b.claim_id)||!member(b.owner_member_id))error('Invalid claim.',400);
   const r=await owned(req.params.selectionId,b.owner_member_id);if(!r)error('Song commit not found.',404);
   if(r.claim_id&&r.claim_id!==b.claim_id)error('Another worker owns this song request.');
   r.claim_id=b.claim_id;if(['REQUESTED','WORKING'].includes(r.state))r.state='WORKING';r.updated_at=new Date().toISOString();await write(file(r.selection_id),r);
   res.json({ok:true,command:{...r,withdrawn:await withdrawn(r)}});
  });
 }catch(e){next(e);}});
 // Explicit operator recovery for the missing-launcher failure of PXO-000034 only.
 // Normal receipts retain their terminal-state and identity protections.
 app.post('/api/transfer/song-commits/:selectionId/recover-pxo-000034',c.transferAuth,async(req,res,next)=>{try{
  const b=req.body||{}, id=req.params.selectionId;
  if(id!=='ff3d22e9-9d6a-4340-a394-1686cad8082d'||b.order_id!=='PXO-000034'
    ||b.source_run_id!=='PXR-000036'||b.claim_id!=='c8472fb1-65ae-4cab-8d87-62701d25b7cf'
    ||b.recovery_id!=='PXO-000034-MISSING-LAUNCHER-1'||!/^PXR-\d{6}$/.test(b.run_id||'')
    ||b.run_id===b.source_run_id||!member(b.owner_member_id))error('Recovery identity rejected.');
  await accountGate.exclusive(b.owner_member_id,()=>lock(id,async()=>{
   const r=await owned(id,b.owner_member_id);
   if(!r||r.claim_id!==b.claim_id||r.order_id!==b.order_id||r.mode!=='ACCOUNT_TEST'
     ||r.authorize_comped!==true||r.authorize_test_email!==true
     ||r.frozen?.selection?.px_song_id!=='PX000311'
     ||r.frozen?.selection?.customer_id!=='PXC-000004')error('Recovery authority rejected.');
   const approved=access.account(b.owner_member_id,b.email);
   if(!approved||approved.customer_id!=='PXC-000004')error('Recovery account is not approved.',403);
   const expected=songAccess.evidence(approved),auth=r.test_authorization;
   if(auth ? JSON.stringify(Object.keys(auth).sort().map(k=>[k,auth[k]]))!==JSON.stringify(Object.keys(expected).sort().map(k=>[k,expected[k]])) : !approved.allow_legacy_commands)error('Recovery approval changed.');
   if(await withdrawn(r))error('Request was withdrawn.');
   const prior=r.operator_recoveries||[];
   if(!Array.isArray(prior))error('Recovery history requires review.');
   const existing=prior.find(x=>x.recovery_id===b.recovery_id);
   if(existing){
    if(prior.length!==1||existing.run_id!==b.run_id||r.run_id!==b.run_id)error('Recovery was already bound to another run.');
    return res.json({ok:true,already_recovered:true,creation:publicState(r)});
   }
   if(prior.length||r.state!=='NEEDS_ATTENTION'||r.run_id!==b.source_run_id)error('Only the original technical failure can be recovered.');
   await accountGate.assertAvailable(b.owner_member_id,id);
   r.operator_recoveries=[{recovery_id:b.recovery_id,source_run_id:r.run_id,run_id:b.run_id,
     previous_state:r.state,previous_updated_at:r.updated_at,authorized_by:'Sam Rideout',
     reason:'Missing Executive Office launcher script restored; administrator-authorized rerun.',at:new Date().toISOString()}];
   r.run_id=b.run_id;r.state='WORKING';r.updated_at=new Date().toISOString();
   await write(file(id),r);res.json({ok:true,creation:publicState(r)});
  }));
 }catch(e){next(e);}});
 app.post('/api/transfer/song-commits/:selectionId/receipt',c.transferAuth,async(req,res,next)=>{try{
  await lock(req.params.selectionId,async()=>{
   const b=req.body||{};const r=await owned(req.params.selectionId,b.owner_member_id);
   if(!r||!uuid(b.claim_id)||r.claim_id!==b.claim_id||!['WORKING','DONE','CANCELLED','NEEDS_ATTENTION'].includes(b.state)
    || !(b.order_id===''||/^PXO-\d{6}$/.test(b.order_id))||!(b.run_id===''||/^PXR-\d{6}$/.test(b.run_id)))error('Invalid song receipt.');
   if((r.order_id&&r.order_id!==b.order_id)||(r.run_id&&r.run_id!==b.run_id))error('Song receipt identity changed.');
   if(['DONE','CANCELLED','NEEDS_ATTENTION'].includes(r.state)&&r.state!==b.state)error('Song commit is already terminal.');
   r.state=b.state;r.order_id=b.order_id;r.run_id=b.run_id;r.updated_at=new Date().toISOString();await write(file(r.selection_id),r);
   res.json({ok:true,creation:publicState(r)});
  });
 }catch(e){next(e);}});
 return {async summaryFor(owner,id){return publicState(await owned(id,owner));}};
}
module.exports={attachCreateSong,authorized};
