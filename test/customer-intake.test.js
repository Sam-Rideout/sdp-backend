'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {linkedCustomerAccess,suppliedEvidence}=require('../customer-capture-access'),{wavInfo}=require('../supplied-recording');
function wav(seconds=2){const bytes=Buffer.alloc(44+32000*seconds);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(16000,24);bytes.writeUInt32LE(32000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(bytes.length-44,40);return bytes;}
test('linked-customer access requires deliberate scope, release and exact member',()=>{const c={customer_capture_scope:'LINKED_CUSTOMERS',customer_intake_release_approved:true,linked_customer_member_ids:['member-a']};assert.equal(linkedCustomerAccess({memberId:'member-a'},c),true);for(const config of [{...c,customer_intake_release_approved:false},{...c,customer_capture_scope:'ACCOUNT_TEST'},{...c,linked_customer_member_ids:['member-b']},{...c,linked_customer_member_ids:['member-a','../bad']}])assert.equal(linkedCustomerAccess({memberId:'member-a'},config),false);});
test('PCM source parser rejects truncation, misleading headers, compression and duplicate chunks',()=>{assert.equal(wavInfo(wav()).duration_seconds,2);for(const corrupt of [b=>b.subarray(0,b.length-1),b=>{b.writeUInt16LE(3,20);return b;},b=>{b.writeUInt32LE(1,28);return b;},b=>{b.writeUInt32LE(9999999,40);return b;},b=>{b.writeUInt16LE(5,32);return b;}])assert.throws(()=>wavInfo(corrupt(wav())));});
const root=fs.mkdtempSync(path.join(os.tmpdir(),'px-customer-intake-'));
Object.assign(process.env,{VOICE_DATA_DIR:path.join(root,'data'),WIX_HANDOFF_SECRET:'synthetic-secret-over-thirty-two-characters',VOICE_TRANSFER_TOKEN:'synthetic-transfer-over-thirty-two-characters',VOICE_CAPTURE_MODE:'CUSTOMER',VOICE_CUSTOMER_CAPTURE_APPROVED:'true',VOICE_CONSENT_APPROVED:'true',VOICE_CONSENT_VERSION:'fixture-intake-v1'});
const config=JSON.parse(fs.readFileSync(path.join(__dirname,'../config/capture-sections.json'),'utf8'));
Object.assign(config,{customer_capture_scope:'LINKED_CUSTOMERS',customer_intake_release_approved:false,linked_customer_member_ids:['member-a','member-b'],supplied_recordings_enabled:true,consent_notice:'Synthetic fixture consent, not production wording.'});
process.env.VOICE_SECTION_CONFIG=path.join(root,'config.json');function saveConfig(){fs.writeFileSync(process.env.VOICE_SECTION_CONFIG,JSON.stringify(config));}saveConfig();
const {app,sign}=require('../server');
test('two account capture routes preserve exact source approval and publish only owned profiles',async t=>{
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(async()=>{await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+server.address().port;
 const cookie=member=>'px_voice_session='+sign({iss:'project-x-voice-capture',sub:member,email:member+'@example.test',exp:Math.floor(Date.now()/1000)+600});
 const trusted={authorization:'Bearer '+process.env.VOICE_TRANSFER_TOKEN};
 async function request(route,body,headers={},method='POST'){const r=await fetch(base+route,{method,headers:{'content-type':'application/json',...headers},...(method==='GET'?{}:{body:JSON.stringify(body)})});return {status:r.status,body:await r.json()};}
 const consent={accepted:true,version:'fixture-intake-v1',retention_choice:'FUTURE_PURCHASES',development_use:false,adult_confirmed:true,own_voice_confirmed:true};
 const create=(member,mode='SUPPLIED_RECORDING')=>request('/api/sessions',{training_source:mode,consent},{cookie:cookie(member)});
 assert.equal((await create('member-a')).status,403);config.customer_intake_release_approved=true;saveConfig();assert.equal((await create('member-c')).status,403);
 const created=await create('member-a');assert.equal(created.status,201);const sid=created.body.session.session_id;
 assert.equal((await create('member-b')).status,201);
 const url='/api/transfer/sessions/'+sid+'/supplied-recording';
 async function upload(headers){const r=await fetch(base+url,{method:'POST',headers:{'content-type':'audio/wav',...headers},body:wav()});return {status:r.status,body:await r.json()};}
 assert.equal((await upload({})).status,401);assert.equal((await upload({...trusted,'X-PX-Expected-Owner':'member-b'})).status,404);
 const uploaded=await upload({...trusted,'X-PX-Expected-Owner':'member-a'});assert.equal(uploaded.status,200);
 const m=uploaded.body.session,clip=m.sections['1'].takes[0],complete='/api/sessions/'+sid+'/complete';
 assert.equal((await request('/api/sessions/'+sid,null,{cookie:cookie('member-b')},'GET')).status,404);
 assert.equal((await request(complete,{start_training:true,approve_supplied_recording:true,source_sha256:'0'.repeat(64)},{cookie:cookie('member-a')})).status,400);
 assert.equal((await request(complete,{start_training:true,approve_supplied_recording:true,source_sha256:clip.sha256},{cookie:cookie('member-b')})).status,404);
 const done=await request(complete,{start_training:true,approve_supplied_recording:true,source_sha256:clip.sha256},{cookie:cookie('member-a')});assert.equal(done.status,200);assert.equal(done.body.session.phone_training.accepted,true);
 const evidence={...done.body.session,owner_member_id:'member-a'};assert.equal(suppliedEvidence(evidence).length,1);evidence.supplied_recording_approval.member_id='member-b';assert.throws(()=>suppliedEvidence(evidence));
 const metadata=await request('/api/transfer/sessions/'+sid,null,trusted,'GET');assert.equal(metadata.status,200);
 assert.equal((await request('/api/transfer/sessions/'+sid+'/confirm',{manifest_sha256:metadata.body.manifest_sha256,files:[{clip_id:clip.clip_id,sha256:clip.sha256}]},trusted)).status,200);
 assert.equal((await request('/api/transfer/phone-jobs',null,trusted,'GET')).body.sessions.some(s=>s.session_id===sid),true);
 assert.equal((await request('/api/sessions/'+sid+'/phone-flow',null,{cookie:cookie('member-a')},'GET')).body.phase,'SOURCE_REVIEW');
 const publish=await request('/api/transfer/sessions/'+sid+'/profile-status',{status:'READY',voice_profile_id:'PXPITCH-Fixture',voice_model_id:'Fixture',customer_id:'PXC-000101',model_sha256:'a'.repeat(64),index_sha256:'b'.repeat(64),certification_id:'PXCERT-'+'C'.repeat(32),certification_sha256:'c'.repeat(64)},trusted);assert.equal(publish.status,200);
 async function profiles(member){const now=Math.floor(Date.now()/1000);return request('/api/wix/voice-profile-status',{ticket:sign({iss:'wix',aud:'project-x-catalog',sub:member,purpose:'voice-profile-status',iat:now,exp:now+120,jti:crypto.randomBytes(24).toString('hex')})});}
 assert.equal((await profiles('member-a')).body.profiles.length,1);assert.equal((await profiles('member-b')).body.profiles.length,0);
 // New guided capture remains an eight-section request and does not inherit supplied-source approval.
 const guided=await create('member-a','GUIDED_RECORDING');assert.equal(guided.status,201);const gid=guided.body.session.session_id;
 assert.equal((await request('/api/sessions/'+gid+'/complete',{start_training:true},{cookie:cookie('member-a')})).status,400);
 for(let section=1;section<=8;section++){const form=new FormData();form.set('section',String(section));form.set('duration_seconds','2');form.set('audio',new Blob([wav()],{type:'audio/wav'}),'take.wav');const r=await fetch(base+'/api/sessions/'+gid+'/clips',{method:'POST',headers:{cookie:cookie('member-a')},body:form});assert.equal(r.status,201);}
 assert.equal((await request('/api/sessions/'+gid+'/complete',{start_training:true},{cookie:cookie('member-a')})).status,200);
});
