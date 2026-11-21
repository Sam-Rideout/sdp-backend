'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createAdditionalTraining,attachAdditionalTraining,NOTICE,SCHEMA}=require('../additional-training');
const owner='member-one',sid='00000000-0000-4000-8000-000000000001',child='00000000-0000-4000-8000-000000000002',id='PXPITCH-model';
function row(){return {record:{owner_member_id:owner,session_id:sid,status:'READY',voice_profile_id:id,voice_model_id:'model',certification_sha256:'a'.repeat(64)},manifest:{session_id:sid,owner_member_id:owner,status:'TRANSFERRED_AUDIO_DELETED',consent:{retention_choice:'FUTURE_PURCHASES'}},selectable:true};}
function fixture(rows=[row()],sessions=[]){const c={profiles:async member=>member===owner?rows:[],ownedSessions:async()=>sessions,recordFor:async(_,m)=>m.record};return {c,service:createAdditionalTraining(c)};}
process.env.PX_ADDITIONAL_TRAINING_ENABLED='true';
const request={parent_voice_profile_id:id,accepted:true,notice_text:NOTICE};
test('freezes the exact owned certified parent; caller cannot supply model or certificate',async()=>{
 const {service}=fixture();const a=await service.evidence(owner,{...request,parent_model_id:'other'},'now');
 assert.equal(a.parent_model_id,'model');assert.equal(a.parent_session_id,sid);assert.equal(a.accepted_at,'now');
 const m={owner_member_id:owner,session_id:child,consent:{accepted_at:'now'},additional_training:a};assert.equal((await service.validateManifest(m)).voice_profile_id,id);
 a.parent_certification_sha256='b'.repeat(64);await assert.rejects(service.validateManifest(m));
});
for(const [label,change] of [
 ['withdrawal',r=>r.record.status='REVOKED'],['expired consent',r=>r.record.consent_expired=true],
 ['pending deletion',r=>r.record.deletion_requested=true],['one-order consent',r=>r.manifest.consent.retention_choice='DELETE_AFTER_ORDER'],
 ['not selectable',r=>r.selectable=false],['untransferred',r=>r.manifest.status='READY_FOR_TRANSFER'],
 ['external owner-test profile',r=>r.record.profile_origin='EXISTING_OWNER_TEST'],['foreign manifest',r=>r.manifest.owner_member_id='another']]){
 test('rejects '+label,async()=>{const r=row();change(r);await assert.rejects(fixture([r]).service.evidence(owner,request,'now'));});
}
test('does not expose or accept another account profile',async()=>{const {service}=fixture();assert.deepEqual(await service.parents('another'),[]);await assert.rejects(service.evidence('another',request,'now'));});
test('requires explicit current notice and enablement',async()=>{
 const {service}=fixture();for(const r of [{...request,accepted:false},{...request,notice_text:'old'},null])await assert.rejects(service.evidence(owner,r,'now'));
 delete process.env.PX_ADDITIONAL_TRAINING_ENABLED;try{await assert.rejects(service.evidence(owner,request,'now'));}finally{process.env.PX_ADDITIONAL_TRAINING_ENABLED='true';}
});
test('blocks a second recording and unverified processing; completed and failed sessions do not block',async()=>{
 for(const m of [{status:'RECORDING'},{status:'READY_FOR_TRANSFER'},{status:'TRANSFERRED_AUDIO_DELETED',record:{status:'PROCESSING'}}])await assert.rejects(fixture([row()],[m]).service.assertIdle(owner));
 for(const status of ['READY','FAILED','REVOKED'])await fixture([row()],[{status:'TRANSFERRED_AUDIO_DELETED',record:{status}}]).service.assertIdle(owner);
});
test('rechecks consent and withdrawal at publication, while parent stays intact',async()=>{
 const r=row(),before=structuredClone(r),{service}=fixture([r]);const a=await service.evidence(owner,request,'now');
 assert.deepEqual(r,before);const m={owner_member_id:owner,session_id:child,consent:{accepted_at:'now'},additional_training:a};
 r.record.deletion_requested=true;await assert.rejects(service.validateManifest(m));assert.equal(r.record.status,'READY');
});
test('creation lock serializes tabs and releases after response',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'px-capture-lock-'));const {c}=fixture();const service=createAdditionalTraining({...c,dataDir:dir});
 const events={};const res={once:(n,f)=>events[n]=f,status(){return this},json(){this.blocked=true}};
 try{let admitted=0;await service.creationLock({memberId:owner},res,()=>admitted++);await service.creationLock({memberId:owner},res,()=>admitted++);assert.equal(admitted,1);assert(res.blocked);events.finish();await new Promise(r=>setTimeout(r,20));await service.creationLock({memberId:owner},res,()=>admitted++);assert.equal(admitted,2);events.finish();}
 finally{await new Promise(r=>setTimeout(r,20));await fs.rm(dir,{recursive:true,force:true});}
});
test('transfer authority requires transfer authentication and exact verified child',async()=>{
 const r=row(),routes=new Map(),auth=()=>{},a={schema_version:SCHEMA,parent_session_id:sid,parent_voice_profile_id:id,parent_model_id:'model',parent_certification_sha256:'a'.repeat(64),accepted:true,accepted_at:'now',notice_text:NOTICE};
 const {c}=fixture([r]);let manifest={owner_member_id:owner,session_id:child,status:'TRANSFERRED_AUDIO_DELETED',consent:{accepted_at:'now'},additional_training:a};
 attachAdditionalTraining({get:(p,...h)=>routes.set(p,h)},{...c,authenticatedMember:()=>{},transferAuth:auth,safeSessionId:x=>x===child,readManifest:async()=>manifest});
 const h=routes.get('/api/transfer/additional-training/:sessionId');assert.equal(h[0],auth);let result,error;const res={set(){},json:x=>result=x};
 await h[1]({params:{sessionId:child}},res,e=>error=e);assert.equal(result.parent.voice_profile_id,id);assert(!error);
 manifest.status='RECORDING';await h[1]({params:{sessionId:child}},res,e=>error=e);assert(error);
});
test('old PC or wrong-parent certification cannot release an additional profile',async()=>{
 const {service}=fixture(),a=await service.evidence(owner,request,'now'),m={owner_member_id:owner,session_id:child,consent:{accepted_at:'now'},additional_training:a};
 for(const certificate of [{},{additional_training_source:{}},{additional_training_source:{authorization:{...a,parent_model_id:'other'}}}])await assert.rejects(service.validatePublication(m,{certificate_json:JSON.stringify(certificate)}));
 const proof={schema_version:'PX-ADDITIONAL-TRAINING-SOURCE-1.0',authorization:a,parent_frames:3000,parent_enrollment_id:'PXTRAIN-'+'A'.repeat(32),parent_source_sha256:'a'.repeat(64),parent_intake_sha256:'b'.repeat(64)};
 const certificate=JSON.stringify({additional_training_source:{...proof,authorization:Object.fromEntries(Object.entries(a).reverse())}});
 assert.equal((await service.validatePublication(m,{certificate_json:certificate})).voice_profile_id,id);
});
