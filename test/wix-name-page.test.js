'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
function fixture({firstName='',lastName='',loggedIn=true,saveError=false}={}){
  const nodes={},navigations=[],writes=[];
  let logout, memberId='member-001', signedIn=loggedIn, ticketHook, pendingSave;
  const account={firstName,lastName};
  for(const id of ['firstNameInput','lastNameInput','button5','nameStatusText']){
    nodes['#'+id]={value:'',text:'',disabled:false,collapsed:false,
      collapse(){this.collapsed=true;},expand(){this.collapsed=false;},
      disable(){this.disabled=true;},enable(){this.disabled=false;},onClick(fn){this.click=fn;}};
  }
  const context=vm.createContext({setTimeout,clearTimeout,
    authentication:{loggedIn:()=>signedIn,onLogout:fn=>{logout=fn;},promptLogin:async()=>{signedIn=true;}},
    currentMember:{getMember:async()=>({_id:memberId})},
    wixLocationFrontend:{to:url=>navigations.push(url)},
    getCustomerNameStatus:async()=>({memberId,...account,complete:!!(account.firstName&&account.lastName)}),
    saveCustomerNames:async(input,expectedMemberId)=>{
      assert.equal(expectedMemberId,memberId);
      writes.push({...input});
      if(saveError)throw new Error('Save failed; please try again.');
      if(pendingSave)await pendingSave;
      Object.assign(account,input);
      return {...account,memberId,complete:true};
    },
    issueVoiceCaptureTicket:async options=>{
      assert.equal(options.requireNames,true);
      if(ticketHook)await ticketHook();
      return account.firstName&&account.lastName?{ticket:'test.ticket'}:{nameRequired:true};
    },
    $w:Object.assign(id=>nodes[id],{onReady:fn=>fn()})});
  const source=fs.readFileSync(path.join(__dirname,'../wix/Start_Here_Page.js'),'utf8').replace(/^import .*;\r?\n/gm,'');
  vm.runInContext(source,context);
  return {nodes,navigations,writes,account,click:()=>nodes['#button5'].click(),
    logout:()=>{signedIn=false;logout();},setMember:id=>{memberId=id;},
    onTicket:fn=>{ticketHook=fn;},pendingSave:promise=>{pendingSave=promise;}};
}
const url='https://sdp-backend-6xt7.onrender.com/voice-capture#ticket=test.ticket';
test('missing names are collected on Start Here with no extra page or premature handoff',async()=>{
  const f=fixture();
  assert.equal(f.nodes['#firstNameInput'].collapsed,true);
  await f.click();
  assert.equal(f.nodes['#firstNameInput'].collapsed,false);
  assert.equal(f.nodes['#lastNameInput'].collapsed,false);
  assert.equal(f.nodes['#button5'].label,'Save and Go To Voice Capture');
  assert.equal(f.navigations.length,0);assert.equal(f.writes.length,0);
  f.nodes['#firstNameInput'].value='Jane';f.nodes['#lastNameInput'].value='Doe';
  await f.click();
  assert.deepEqual(f.writes,[{firstName:'Jane',lastName:'Doe'}]);
  assert.deepEqual(f.navigations,[url]);
});
test('a complete account goes straight to capture without re-entering names',async()=>{
  const f=fixture({firstName:'Jane',lastName:'Doe'});await f.click();
  assert.deepEqual(f.navigations,[url]);assert.equal(f.writes.length,0);
  assert.equal(f.nodes['#firstNameInput'].collapsed,true);
});
test('only a missing name field appears, and saved names are preserved',async()=>{
  const f=fixture({firstName:'Jane'});await f.click();
  assert.equal(f.nodes['#firstNameInput'].collapsed,true);
  assert.equal(f.nodes['#firstNameInput'].disabled,true);
  assert.equal(f.nodes['#lastNameInput'].collapsed,false);
  f.nodes['#lastNameInput'].value='Doe';await f.click();
  assert.deepEqual(f.writes,[{firstName:'Jane',lastName:'Doe'}]);
});
test('a failed save leaves the entered names available for retry',async()=>{
  const f=fixture({saveError:true});await f.click();
  f.nodes['#firstNameInput'].value='Jane';f.nodes['#lastNameInput'].value='Doe';
  await f.click();
  assert.equal(f.nodes['#button5'].disabled,false);
  assert.equal(f.nodes['#firstNameInput'].value,'Jane');
  assert.match(f.nodes['#nameStatusText'].text,/Save failed/);
  assert.equal(f.navigations.length,0);
});
test('logout clears names; changed accounts cannot save the prior account form',async()=>{
  const f=fixture();await f.click();f.nodes['#firstNameInput'].value='Jane';
  f.setMember('member-002');await f.click();
  assert.equal(f.writes.length,0);assert.equal(f.nodes['#firstNameInput'].value,'');
  await f.click();f.nodes['#firstNameInput'].value='Other';f.logout();
  assert.equal(f.nodes['#firstNameInput'].value,'');
  assert.equal(f.nodes['#firstNameInput'].collapsed,true);
});
test('account switch while a handoff is pending prevents navigation',async()=>{
  const f=fixture({firstName:'Jane',lastName:'Doe'});
  f.onTicket(async()=>f.setMember('member-002'));await f.click();
  assert.equal(f.navigations.length,0);assert.equal(f.nodes['#button5'].disabled,false);
});
test('a double click cannot issue two simultaneous saves',async()=>{
  const f=fixture();await f.click();
  f.nodes['#firstNameInput'].value='Jane';f.nodes['#lastNameInput'].value='Doe';
  let release;f.pendingSave(new Promise(resolve=>{release=resolve;}));
  const first=f.click();await new Promise(resolve=>setImmediate(resolve));
  await f.click();assert.equal(f.writes.length,1);
  release();await first;assert.deepEqual(f.navigations,[url]);
});
test('signing in from Start Here continues the same button action',async()=>{
  const f=fixture({firstName:'Jane',lastName:'Doe',loggedIn:false});await f.click();
  assert.deepEqual(f.navigations,[url]);
});
