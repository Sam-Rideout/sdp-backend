'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {requireNewCaptureNames} = require('../customer-name-gate');

async function check(identity, changes={}) {
  let next=0, body, status;
  await requireNewCaptureNames({forTransfer:async()=>identity})(
    {captureProgram:'CUSTOMER',memberId:'member-001',memberEmail:'test@example.com',...changes},
    {status(value){status=value;return this;},json(value){body=value;}},
    error=>{if(error)throw error;next++;});
  return {next,body,status};
}
const identity={member_id:'member-001',email:'test@example.com',first_name:'Élodie',last_name:"O'Neil-Smith"};
test('new customer recording requires both valid names',async()=>{
  for(const value of [undefined,null,'',' ', 'x'.repeat(101),'Jo\nAnn']) {
    assert.equal((await check({...identity,first_name:value})).status,409);
    assert.equal((await check({...identity,last_name:value})).body.code,'CUSTOMER_NAME_REQUIRED');
    assert.equal((await check({...identity,last_name:value})).body.profileUrl,'https://www.sdpsongs.ca/start-here');
  }
  assert.equal((await check(identity)).next,1);
});
test('name requirement cannot accept a different member or email',async()=>{
  for(const value of [null,{...identity,member_id:'other-member'},{...identity,email:'other@example.com'}]) {
    assert.equal((await check(value)).status,403);
  }
});
test('pilot workflow stays separate and metadata read errors fail closed',async()=>{
  assert.equal((await check(null,{captureProgram:'LIMITED_HELPER_PILOT'})).next,1);
  let received;
  await requireNewCaptureNames({forTransfer:async()=>{throw new Error('offline');}})(
    {captureProgram:'CUSTOMER'}, {}, error=>{received=error;});
  assert.equal(received.message,'offline');
});
test('the gate applies only to new session creation, after authentication',()=>{
  const source=require('node:fs').readFileSync(require.resolve('../server.js'),'utf8');
  assert.equal(source.split("require('./customer-name-gate').requireNewCaptureNames(customerIdentities)").length-1,1);
  assert.match(source,/app\.post\('\/api\/sessions', authenticatedMember, requireSameOrigin, requireCaptureAccess, require\('\.\/customer-name-gate'\)/);
});
test('operator identity lookup is protected, owner-specific and read-only',async()=>{
  const auth=()=>{}, routes=[];
  require('../customer-name-gate').attachIdentityRead({get:(...args)=>routes.push(args)},auth,
    {forTransfer:async member=>({...identity,member_id:member})});
  assert.equal(routes.length,1); assert.equal(routes[0][1],auth);
  let result,header;
  await routes[0][2]({params:{memberId:'member-001'}},{set:(...v)=>{header=v;},json:v=>{result=v;}},e=>{throw e;});
  assert.equal(result.customer_identity.member_id,'member-001');
  assert.deepEqual(header,['Cache-Control','no-store']);
});
