'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture({complete=false}={}){
  const nodes={},navigations=[],writes=[];let logout;
  for(const id of ['firstNameInput','lastNameInput','saveNamesButton','nameStatusText']){
    nodes['#'+id]={value:'',text:'',disabled:false,disable(){this.disabled=true;},enable(){this.disabled=false;},onClick(fn){this.click=fn;}};
  }
  const nameStatus={memberId:'member-001',firstName:complete?'Jane':'',lastName:complete?'Doe':'',complete};
  const context=vm.createContext({setTimeout,clearTimeout,
    authentication:{loggedIn:()=>true,onLogout:fn=>{logout=fn;},promptLogin:async()=>{}},
    currentMember:{getMember:async()=>({_id:'member-001'})},
    wixLocationFrontend:{to:url=>navigations.push(url)},
    getCustomerNameStatus:async()=>({...nameStatus}),
    saveCustomerNames:async input=>{writes.push(input);return {...input,memberId:'member-001',complete:true};},
    issueVoiceCaptureTicket:async options=>{assert.equal(options.requireNames,true);return {ticket:'test.ticket'};},
    $w:Object.assign(id=>nodes[id],{onReady:fn=>fn()})});
  const source=fs.readFileSync(path.join(__dirname,'../wix/Complete_Profile_Page.js'),'utf8').replace(/^import .*;\r?\n/gm,'');
  vm.runInContext(source,context);
  return {nodes,navigations,writes,logout:()=>logout()};
}
test('completion page loads missing names without accepting agreements or starting recording',async()=>{
  const f=fixture();await tick();
  assert.equal(f.nodes['#saveNamesButton'].disabled,false);
  assert.equal(f.nodes['#firstNameInput'].disabled,false);
  assert.equal(f.navigations.length,0);assert.equal(f.writes.length,0);
  f.nodes['#firstNameInput'].value='Jane';f.nodes['#lastNameInput'].value='Doe';
  await f.nodes['#saveNamesButton'].click();
  assert.equal(f.writes.length,1);
  assert.equal(f.navigations[0],'https://sdp-backend-6xt7.onrender.com/voice-capture#ticket=test.ticket');
});
test('saved names remain locked; logging out clears them and disables submit',async()=>{
  const f=fixture({complete:true});await tick();
  assert.equal(f.nodes['#firstNameInput'].disabled,true);
  f.logout();
  assert.equal(f.nodes['#firstNameInput'].value,'');
  assert.equal(f.nodes['#saveNamesButton'].disabled,true);
  await f.nodes['#saveNamesButton'].click();assert.equal(f.writes.length,0);
});
