'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const local=path.join(__dirname,'capture-engine.js');
const source=fs.readFileSync(fs.existsSync(local)?local:path.join(__dirname,'../public/voice-capture-assets/capture-engine.js'),'utf8');
const begin=source.indexOf('async function resumeOpenRecordingAfterConflict(');
const end=source.indexOf('function retentionChoice()',begin);
const helper=source.slice(begin,end);
function setup(sessions){
 const calls=[];
 const context={refreshSessions:async()=>{calls.push(['list']);return sessions;},selectSession:async id=>calls.push(['select',id]),setStatus:(...a)=>calls.push(['status',...a]),guidedShow:(...a)=>calls.push(['show',...a])};
 vm.createContext(context);vm.runInContext(helper,context);
 return {context,calls};
}
test('opens the single server-listed recording and preserves existing session identity',async()=>{
 const {context,calls}=setup([{session_id:'owned-open',status:'RECORDING'},{session_id:'submitted',status:'READY_FOR_TRANSFER'}]);
 assert.equal(await context.resumeOpenRecordingAfterConflict({status:409}),true);
 assert.deepEqual(calls.filter(c=>c[0]==='select'),[['select','owned-open']]);
 assert(calls.some(c=>c[0]==='status'&&c[1].includes('preserved')));
});
test('does not resume on authentication, access or network failure',async()=>{
 for(const status of [401,403,500,undefined]){
  const {context,calls}=setup([{session_id:'owned-open',status:'RECORDING'}]);
  assert.equal(await context.resumeOpenRecordingAfterConflict({status}),false);assert.equal(calls.length,0);
 }
});
test('does not resume submitted sessions or invent a recording',async()=>{
 const {context,calls}=setup([{session_id:'submitted',status:'READY_FOR_TRANSFER'}]);
 assert.equal(await context.resumeOpenRecordingAfterConflict({status:409}),false);assert(!calls.some(c=>c[0]==='select'));
});
test('multiple recordings require an explicit choice on the saved-recording screen',async()=>{
 const {context,calls}=setup([{session_id:'one',status:'RECORDING'},{session_id:'two',status:'RECORDING'}]);
 assert.equal(await context.resumeOpenRecordingAfterConflict({status:409}),true);assert(!calls.some(c=>c[0]==='select'));
 assert.deepEqual(calls.find(c=>c[0]==='show'),['show','guidedIntro',true]);
});
test('a session-list failure is propagated instead of claiming success',async()=>{
 const {context}=setup([]);context.refreshSessions=async()=>{throw new Error('unavailable');};
 await assert.rejects(context.resumeOpenRecordingAfterConflict({status:409}),/unavailable/);
});
test('start handler invokes recovery and always unlocks its controls',()=>{
 assert(source.includes('if(!await resumeOpenRecordingAfterConflict(error))'));
 assert(source.includes('finally{guidedCreating=false;syncConsentControls();guidedUpdate();}'));
});
