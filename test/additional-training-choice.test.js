'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..');
function captureFixture(search='?training=additional', profiles=[{voice_profile_id:'owned',label:'Profile A',setup:'USB mic',created_at:'2026-01-01T09:00:00Z'},{voice_profile_id:'second',label:'Profile B',setup:'Phone',created_at:'2026-01-02T10:00:00Z'}]){
 const nodes=new Map(),events={},requests=[],nav=[];let selected;
 function node(id){if(nodes.has(id))return nodes.get(id);const n={id,value:'',checked:false,disabled:false,hidden:true,textContent:'',options:[],querySelector:()=>node(id+'-p'),appendChild(o){this.options.push(o);if(!this.value)this.value=o.value;},addEventListener:(name,fn)=>events[id+':'+name]=fn};n.parentElement={querySelector:()=>node(id+'-parent-p')};Object.defineProperty(n,'innerHTML',{set(){n.options=[];n.value=''}});nodes.set(id,n);return n;}
 const ctx={MutationObserver:class {observe(){}},console,URLSearchParams,URL,location:{search,hash:'#ticket=synthetic',pathname:'/voice-capture'},history:{replaceState:(a,b,u)=>nav.push(u)},document:{getElementById:node,addEventListener(){},querySelectorAll:()=>[],createElement:()=>({})},window:{addEventListener(){},PXTesterConsent:{load:async()=>{},ready:()=>true},PXShowConsentReminder(){}},setInterval(){},clearInterval(){},setTimeout(){},fetch:()=>{throw Error('unexpected raw fetch')},guidedMicPassed:true,guidedMicBusy:false,guidedCreating:false,guidedUpdate(){}};
 vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(root,'public/voice-capture-assets/capture-engine.js'),'utf8'),ctx);
 ctx.api=async(url,opts={})=>{requests.push({url,opts});if(url==='/api/session/exchange')return {ok:true};if(url==='/api/config')return {capture_enabled:true,sections:[],consent_choices:{},recording_setup_enabled:false};if(url==='/api/additional-training')return {ok:true,notice_text:'Current update notice',profiles};if(url==='/api/sessions'&&opts.method==='POST')return {session:{session_id:'new-session',consent:{retention_choice:'DELETE_AFTER_ORDER'}}};if(url==='/api/sessions')return {sessions:[]};throw Error(url);};
 return {ctx,node,requests,nav,events,run:()=>vm.runInContext('initialize()',ctx),selected:()=>selected,overrideSelect(){ctx.selectSession=async id=>selected=id}};
}
function choose(f,id){f.node('additionalProfile').value=id;f.events['additionalProfile:change']();}
function otherConsent(f){f.node('deleteAfterOrder').checked=true;f.node('ageOwnVoice').checked=true;}
test('multiple profiles require a deliberate choice; no default or checked agreement',async()=>{
 const f=captureFixture();await f.run();otherConsent(f);assert.equal(f.node('additionalProfile').value,'');assert.equal(f.node('additionalAgree').checked,false);assert.equal(f.node('additionalAgree').disabled,true);assert.equal(vm.runInContext('customerConsentAccepted()',f.ctx),false);
 assert.equal(f.node('additionalProfile').options.length,3);assert.match(f.node('additionalProfile').options[1].textContent,/Profile A/);assert.match(f.node('additionalProfile').options[2].textContent,/Profile B/);
});
test('even one eligible profile is never silently preselected',async()=>{
 const f=captureFixture('?training=additional',[{voice_profile_id:'owned',label:'Only profile',setup:'Phone',created_at:'2026-01-01'}]);await f.run();assert.equal(f.node('additionalProfile').value,'');assert.equal(f.node('additionalAgree').disabled,true);
});
test('choosing another profile clears previous agreement',async()=>{
 const f=captureFixture();await f.run();otherConsent(f);choose(f,'owned');assert.equal(f.node('additionalAgree').disabled,false);f.node('additionalAgree').checked=true;assert.equal(vm.runInContext('customerConsentAccepted()',f.ctx),true);
 choose(f,'second');assert.equal(f.node('additionalAgree').checked,false);assert.equal(vm.runInContext('customerConsentAccepted()',f.ctx),false);
});
test('unknown selection cannot enable the combine agreement',async()=>{
 const f=captureFixture();await f.run();choose(f,'foreign');assert.equal(f.node('additionalAgree').disabled,true);
});
test('create handler binds the chosen second profile, never the first default',async()=>{
 const f=captureFixture();await f.run();f.overrideSelect();otherConsent(f);choose(f,'second');f.node('additionalAgree').checked=true;await f.events['create:click']();
 const request=f.requests.find(r=>r.url==='/api/sessions'&&r.opts.method==='POST');assert.equal(JSON.parse(request.opts.body).additional_training.parent_voice_profile_id,'second');
});
test('visible recording target uses frozen session identity, not the current dropdown',async()=>{
 const f=captureFixture();await f.run();choose(f,'owned');
 vm.runInContext("showAdditionalTrainingTarget({additional_training:{parent_voice_profile_id:'second'}})",f.ctx);
 assert.equal(f.node('capturePageIntroduction').hidden,false);assert.match(f.node('capturePageIntroduction').textContent,/Profile B/);assert.doesNotMatch(f.node('capturePageIntroduction').textContent,/Profile A/);
});
test('ordinary new-profile capture keeps the existing flow',async()=>{
 const f=captureFixture('');await f.run();f.overrideSelect();otherConsent(f);assert.equal(vm.runInContext('customerConsentAccepted()',f.ctx),true);await f.events['create:click']();assert.equal(JSON.parse(f.requests.find(r=>r.opts.method==='POST'&&r.url==='/api/sessions').opts.body).additional_training,undefined);
});
