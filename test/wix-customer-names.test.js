'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const crypto=require('node:crypto');
const source=fs.readFileSync(require('node:path').join(__dirname,'../wix/voiceCapture.web.js'),'utf8')
  .replace(/^import .*;\r?\n/gm,'').replace(/export const /g,'const ');
function fixture(contact={}) {
  let member={_id:'member-001',loginEmail:'test@example.com',contact:{...contact}};
  const writes=[], secrets=[];
  const context=vm.createContext({Buffer,Date,createHmac:crypto.createHmac,randomBytes:crypto.randomBytes,
    Permissions:{SiteMember:'SiteMember'},webMethod:(permission,fn)=>{assert.equal(permission,'SiteMember');return fn;},
    elevate:fn=>fn,
    currentMember:{getMember:async()=>({_id:member?._id,loginEmail:member?.loginEmail})},
    members:{getMember:async id=>{assert.equal(id,member._id);return structuredClone(member);},
      updateMember:async(id,patch)=>{assert.equal(id,member._id);writes.push(structuredClone(patch));Object.assign(member.contact,patch.contact);}},
    getSecret:async key=>{secrets.push(key);return 'x'.repeat(32);}});
  vm.runInContext(source+'\nglobalThis.methods={getCustomerNameStatus,saveCustomerNames,issueVoiceCaptureTicket};',context);
  return {methods:context.methods,writes,secrets,setMember:value=>{member=value;}};
}
test('empty Wix names require completion before new-capture handoff; read access remains',async()=>{
  const f=fixture();
  assert.equal((await f.methods.getCustomerNameStatus()).complete,false);
  assert.equal((await f.methods.issueVoiceCaptureTicket({requireNames:true})).nameRequired,true);
  assert.equal(f.secrets.length,0);
  const handoff=await f.methods.issueVoiceCaptureTicket();
  const claims=JSON.parse(Buffer.from(handoff.ticket.split('.')[0],'base64url'));
  assert.equal(claims.sub,'member-001'); assert.equal(claims.customer_identity.first_name,'');
});
test('saving Unicode names signs the fresh saved account fields',async()=>{
  const f=fixture();
  assert.equal((await f.methods.saveCustomerNames({firstName:' Élodie ',lastName:"O'Neil-Smith"})).complete,true);
  assert.deepEqual(f.writes,[{contact:{firstName:'Élodie',lastName:"O'Neil-Smith"}}]);
  const {ticket}=await f.methods.issueVoiceCaptureTicket({requireNames:true});
  const [body,sig]=ticket.split('.');
  assert.equal(sig,crypto.createHmac('sha256','x'.repeat(32)).update(body).digest('base64url'));
  assert.equal(JSON.parse(Buffer.from(body,'base64url')).customer_identity.first_name,'Élodie');
  await f.methods.saveCustomerNames({firstName:'Élodie',lastName:"O'Neil-Smith"});
  assert.equal(f.writes.length,1);
});
test('invalid names, foreign IDs and extra fields never write',async()=>{
  const f=fixture();
  for(const input of [null,{}, {firstName:' ',lastName:'Doe'},{firstName:'Joe\n',lastName:'D\u0000oe'},
    {firstName:'x'.repeat(101),lastName:'Doe'},{firstName:'Jane',lastName:'Doe',memberId:'foreign'}]) {
    await assert.rejects(f.methods.saveCustomerNames(input));
  }
  assert.equal(f.writes.length,0);
});
test('established names are preserved and only the missing field is patched',async()=>{
  const f=fixture({firstName:'Jane'});
  await assert.rejects(f.methods.saveCustomerNames({firstName:'Other',lastName:'Doe'}));
  await f.methods.saveCustomerNames({firstName:'Jane',lastName:'Doe'});
  assert.deepEqual(f.writes,[{contact:{lastName:'Doe'}}]);
});
test('anonymous requests cannot read names, save names or obtain a ticket',async()=>{
  const f=fixture(); f.setMember(null);
  for(const run of [()=>f.methods.getCustomerNameStatus(),()=>f.methods.saveCustomerNames({firstName:'Jane',lastName:'Doe'}),()=>f.methods.issueVoiceCaptureTicket()]) await assert.rejects(run());
  assert.equal(f.writes.length,0); assert.equal(f.secrets.length,0);
});
