'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {attachProfileStatus}=require('../voice-profile-status');
const {attachSongSelection}=require('../song-selection');
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const sid1='10000000-0000-4000-8000-000000000001',sid2='10000000-0000-4000-8000-000000000002';
const ready=(sid,model)=>({schema_version:'PX-VOICE-PROFILE-STATUS-1.0',status:'READY',owner_member_id:'member-one',session_id:sid,voice_profile_id:'PXPITCH-'+model,voice_model_id:model,customer_id:'PXC-000001',model_sha256:'a'.repeat(64),index_sha256:'b'.repeat(64),certification_id:'PXCERT-'+model,certification_sha256:'c'.repeat(64),updated_at:new Date().toISOString()});
async function fixture(t){
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'px-job20-'));t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
 const sessionDir=path.join(dataDir,'sessions');await fs.mkdir(sessionDir);
 const manifests=new Map();const routes=new Map();
 const app={post:(url,...handlers)=>routes.set(url,handlers)};
 const context={dataDir,sessionDir,safeSessionId:v=>/^[a-f0-9-]{36}$/.test(v),readManifest:async id=>manifests.get(id),verifySigned:ticket=>ticket,consumeTicket:async()=>true,pruneOldReplayMarkers:async()=>{},transferAuth:(req,res,next)=>next()};
 const bridge=attachProfileStatus(app,context);
 attachSongSelection(app,{...context,readyProfile:bridge.selectableProfile});
 async function add(id,date,retention='FUTURE_PURCHASES',owner='member-one'){
  const m={session_id:id,owner_member_id:owner,program:'CUSTOMER',status:'TRANSFERRED_AUDIO_DELETED',created_at:date,consent:{retention_choice:retention}};
  manifests.set(id,m);await fs.mkdir(path.join(sessionDir,id));return m;
 }
 async function call(url,{body={},params={}}={}){
  let result={status:200};const res={status(n){result.status=n;return this;},set(){return this;},json(v){result.body=v;return this;}};
  const hs=routes.get(url);assert.ok(hs,'route exists');
  async function run(i){if(i>=hs.length)return;let nextPromise;await hs[i]({body,params},res,e=>{nextPromise=e?Promise.reject(e):run(i+1);});if(nextPromise)await nextPromise;}
  await run(0);return result;
 }
 const publish=(id,record)=>call('/api/transfer/sessions/:sessionId/profile-status',{params:{sessionId:id},body:record});
 const claims=(extra={})=>{const now=Math.floor(Date.now()/1000);return {iss:'wix',aud:'project-x-catalog',purpose:'song-selection',sub:'member-one',iat:now,exp:now+120,jti:crypto.randomBytes(24).toString('hex'),request_id:crypto.randomBytes(24).toString('hex'),catalog_item_id:'catalog-one',px_song_id:'PX000320',...extra};};
 return {dataDir,add,call,publish,bridge,claims,manifests};
}
test('existing member status is available before any migration',async t=>{
 const f=await fixture(t);await f.add(sid1,'2026-10-01');await fs.mkdir(path.join(f.dataDir,'voice-profile-status'));
 await fs.writeFile(path.join(f.dataDir,'voice-profile-status',hash('member-one')+'.json'),JSON.stringify(ready(sid1,'One')));
 assert.equal((await f.bridge.readyProfile('member-one')).voice_model_id,'One');
 assert.equal(await f.bridge.readyProfile('member-two','PXPITCH-One'),null);
});
test('older and newer profiles remain selectable, with per-session readiness',async t=>{
 const f=await fixture(t);await f.add(sid1,'2026-10-01');await f.publish(sid1,ready(sid1,'One'));
 await f.add(sid2,'2026-10-02');await f.publish(sid2,ready(sid2,'Two'));
 assert.equal((await f.bridge.readyProfile('member-one','PXPITCH-One')).voice_model_id,'One');
 assert.equal((await f.bridge.readyProfile('member-one')).voice_model_id,'Two');
 assert.equal((await f.bridge.snapshot('member-one',true,sid1)).profile.voice_model_id,'One');
 const c=f.claims({purpose:'voice-profile-status'});const r=await f.call('/api/wix/voice-profile-status',{body:{ticket:c}});
 assert.equal(r.body.profiles.length,2);assert.ok(r.body.profiles.every(x=>x.selectable));
 assert.ok(r.body.profiles.every(x=>!('model_sha256' in x)&&!('customer_id' in x)&&!('voice_model_id' in x)));
});
test('an older certified session may publish without replacing the latest status',async t=>{
 const f=await fixture(t);await f.add(sid1,'2026-10-01');await f.add(sid2,'2026-10-02');
 await f.publish(sid2,ready(sid2,'Two'));assert.equal((await f.publish(sid1,ready(sid1,'One'))).status,200);
 assert.equal((await f.bridge.snapshot('member-one',true)).profile.voice_model_id,'Two');
});
test('legacy record is archived when a newer profile is published',async t=>{
 const f=await fixture(t);await f.add(sid1,'2026-10-01');await fs.mkdir(path.join(f.dataDir,'voice-profile-status'));
 await fs.writeFile(path.join(f.dataDir,'voice-profile-status',hash('member-one')+'.json'),JSON.stringify(ready(sid1,'One')));
 await f.add(sid2,'2026-10-02');await f.publish(sid2,ready(sid2,'Two'));
 assert.equal((await f.bridge.readyProfile('member-one','PXPITCH-One')).voice_model_id,'One');
});
test('revoking one profile preserves another and rejects new use of the revoked profile',async t=>{
 const f=await fixture(t);await f.add(sid1,'2026-10-01');await f.publish(sid1,ready(sid1,'One'));await f.add(sid2,'2026-10-02');await f.publish(sid2,ready(sid2,'Two'));
 await f.publish(sid1,{status:'REVOKED'});
 assert.equal(await f.bridge.readyProfile('member-one','PXPITCH-One'),null);
 assert.equal((await f.bridge.readyProfile('member-one')).voice_model_id,'Two');
 const r=await f.call('/api/wix/song-selection',{body:{ticket:f.claims({voice_profile_id:'PXPITCH-One'})}});assert.equal(r.status,409);
});
test('new recording in progress does not hide an earlier retained profile',async t=>{
 const f=await fixture(t);await f.add(sid1,'2026-10-01');await f.publish(sid1,ready(sid1,'One'));await f.add(sid2,'2026-10-02');
 assert.equal((await f.bridge.snapshot('member-one')).status,'PROCESSING');
 assert.equal((await f.bridge.readyProfile('member-one')).voice_model_id,'One');
});
test('one-order consent cannot become reusable through the profile picker',async t=>{
 const f=await fixture(t);await f.add(sid1,'2026-10-01','DELETE_AFTER_ORDER');await f.publish(sid1,ready(sid1,'One'));await f.add(sid2,'2026-10-02');
 assert.equal(await f.bridge.selectableProfile('member-one','PXPITCH-One'),null);
 // Existing pinned requests can still validate the exact READY evidence.
 assert.equal((await f.bridge.readyProfile('member-one','PXPITCH-One')).voice_model_id,'One');
});
test('song choice uses the signed profile and preserves the exact selected model',async t=>{
 const f=await fixture(t);await f.add(sid1,'2026-10-01');await f.publish(sid1,ready(sid1,'One'));await f.add(sid2,'2026-10-02');await f.publish(sid2,ready(sid2,'Two'));
 const claims=f.claims({voice_profile_id:'PXPITCH-One'});
 const r=await f.call('/api/wix/song-selection',{body:{ticket:claims,voice_profile_id:'PXPITCH-Two'}});assert.equal(r.status,200);
 const files=await fs.readdir(path.join(f.dataDir,'song-selections'));assert.equal(files.length,1);
 const saved=JSON.parse(await fs.readFile(path.join(f.dataDir,'song-selections',files[0]),'utf8'));
 assert.equal(saved.voice_model_id,'One');assert.equal(saved.session_id,sid1);
 const again=await f.call('/api/wix/song-selection',{body:{ticket:{...claims,jti:crypto.randomBytes(24).toString('hex')}}});assert.equal(again.body.selection_id,r.body.selection_id);
 const changed=await f.call('/api/wix/song-selection',{body:{ticket:{...claims,voice_profile_id:'PXPITCH-Two'}}});assert.equal(changed.status,409);
});
test('cross-owner profile IDs and malformed signed IDs fail closed',async t=>{
 const f=await fixture(t);await f.add(sid1,'2026-10-01');await f.publish(sid1,ready(sid1,'One'));
 const other=await f.call('/api/wix/song-selection',{body:{ticket:f.claims({sub:'member-two',voice_profile_id:'PXPITCH-One'})}});assert.equal(other.status,409);
 const malformed=await f.call('/api/wix/song-selection',{body:{ticket:f.claims({voice_profile_id:{model:'One'}})}});assert.equal(malformed.status,401);
});
test('tampered per-session ownership is rejected',async t=>{
 const f=await fixture(t);await f.add(sid1,'2026-10-01');await f.publish(sid1,ready(sid1,'One'));
 const file=path.join(f.dataDir,'voice-profile-records',hash('member-one'),sid1+'.json');
 await fs.writeFile(file,JSON.stringify({...ready(sid1,'One'),owner_member_id:'member-two'}));
 await assert.rejects(()=>f.bridge.readyProfile('member-one'),/verified customer transfer/);
});
