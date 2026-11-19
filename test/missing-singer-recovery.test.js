'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),Module=require('node:module');
const sid='109ed390-1164-4b76-b916-25c82a9a862e',owner='synthetic-member';
const claim='00000000-0000-4000-8000-000000000001';
const payload={operation:'APPLY',order_id:'PXO-000071',owner_member_id:owner,email:'synthetic@example.test',claim_id:claim,before_sha256:'a'.repeat(64),after_sha256:'b'.repeat(64)};
function record(){return {schema_version:'PX-CREATE-SONG-1.0',selection_id:sid,owner_member_id:owner,email:payload.email,mode:'CUSTOMER',authorize_preview:true,authorize_comped:false,authorize_test_email:false,state:'NEEDS_ATTENTION',claim_id:claim,order_id:'',run_id:'',frozen:{selection:{selection_id:sid,owner_member_id:owner,customer_id:'PXC-000005',px_song_id:'PX000041'},message:{choice:'SKIPPED'}},updated_at:'2026-11-19T23:35:32Z'};}
async function fixture(fn,{mutate=()=>{},cancel=null,allowed=true,blocked=false}={}){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'px-singer-'));await fs.mkdir(path.join(dir,'song-commits'));
 const file=path.join(dir,'song-commits',sid+'.json'),r=record();mutate(r);await fs.writeFile(file,JSON.stringify(r));
 const original=Module._load,routes=new Map(),auth=()=>{};
 Module._load=function(name,...rest){
  if(name==='./birthday-message')return {uuid:x=>typeof x==='string'&&/^[a-f0-9-]{36}$/.test(x)};
  if(name==='./complimentary-song-access')return {createAccess:()=>({})};
  if(name==='./account-song-limit')return {createAccountSongGate:()=>({exclusive:async(o,f)=>f(),assertAvailable:async()=>{if(blocked)throw Error('Other active request');}})};
  if(name==='./wix-cancel')return {readCancel:async()=>cancel};
  return original.call(this,name,...rest);
 };
 try{
  delete require.cache[require.resolve('../create-song')];
  require('../create-song').attachCreateSong({get(){},post:(url,...handlers)=>routes.set(url,handlers)},
   {dataDir:dir,transferAuth:auth,songAccess:{},customerCommerce:{memberAllowed:async()=>allowed}});
  const handlers=routes.get('/api/transfer/song-commits/:selectionId/recover-missing-singer');assert.equal(handlers[0],auth);
  async function call(changes={}){let result,error;await handlers[1]({params:{selectionId:sid},body:{...payload,...changes}}, {json:x=>{result=x;}},e=>{error=e;});return {result,error};}
  await fn({call,read:async()=>JSON.parse(await fs.readFile(file,'utf8')),file});
 }finally{Module._load=original;await fs.rm(dir,{recursive:true,force:true});}
}
test('CHECK does not change the request; APPLY requeues once and preserves frozen facts',async()=>fixture(async({call,read})=>{
 const before=await read();assert((await call({operation:'CHECK'})).result.recoverable);assert.deepEqual(await read(),before);
 assert((await call()).result.recovered);const after=await read();assert.equal(after.state,'WORKING');assert.equal(after.order_id,'PXO-000071');assert.deepEqual(after.frozen,before.frozen);assert.equal(after.operator_recoveries.length,1);
 assert((await call()).result.already_recovered);assert.deepEqual(await read(),after);
 assert((await call({after_sha256:'c'.repeat(64)})).error);
}));
for(const [label,mutate] of [
 ['other customer',r=>r.frozen.selection.customer_id='PXC-000006'],
 ['other song',r=>r.frozen.selection.px_song_id='PX000042'],
 ['produced run',r=>r.run_id='PXR-000075'],
 ['cancelled',r=>r.state='CANCELLED'],
 ['completed',r=>r.state='DONE'],
 ['QA rejection',r=>r.outcome='PRODUCTION_REJECTED'],
 ['different order',r=>r.order_id='PXO-000072'],
 ['test authorization',r=>r.authorize_test_email=true]]){
 test('rejects '+label,async()=>fixture(async({call,read})=>{const before=await read();assert((await call()).error);assert.deepEqual(await read(),before);},{mutate}));
}
test('rejects changed claim and account',async()=>fixture(async({call})=>{assert((await call({claim_id:'00000000-0000-4000-8000-000000000002'})).error);assert((await call({owner_member_id:'another-member'})).error);}));
for(const [label,options] of [['pending cancellation',{cancel:{status:'REQUESTED'}}],['confirmed cancellation',{cancel:{status:'CANCELLED'}}],['revoked access',{allowed:false}],['other active request',{blocked:true}]]){
 test('blocks '+label,async()=>fixture(async({call,read})=>{const before=await read();assert((await call()).error);assert.deepEqual(await read(),before);},options));
}
