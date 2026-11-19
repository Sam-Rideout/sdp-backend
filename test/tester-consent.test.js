'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const testers=require('../song-testers'),{createStore}=require('../song-commerce');
const owner='test-member-one',email='invited@example.invalid';
function fixture(){const state={};const invitation=testers.invite(state,{email,actor:'Synthetic test'});return {state,invitation};}
function acceptance(p){return {accepted:true,typed_name:'Synthetic Tester',challenge:p.challenge,agreement_sha256:p.agreement.sha256,agreement_version:p.agreement.version};}
test('regular customers receive no agreement or acceptance fields',()=>{
 const s={};assert.equal(testers.presentForAccount(s,owner,'regular@example.invalid').required,false);
 assert.equal(testers.presentForAccount(s,owner,'regular@example.invalid').agreement,undefined);
 assert.throws(()=>testers.acceptForAccount(s,owner,'regular@example.invalid',{}),e=>e.status===403);
});
test('an invitation alone is pending and presents the complete approved agreement',()=>{
 const {state}=fixture(),p=testers.presentForAccount(state,owner,email);
 assert.equal(p.required,true);assert.equal(p.active,false);assert.equal(p.agreement.html,testers.agreement.html);assert.equal(testers.active(state,owner),false);
});
test('explicit acceptance persists identity, name, presentation, version and timestamp',()=>{
 const {state}=fixture(),p=testers.presentForAccount(state,owner,email);
 const result=testers.acceptForAccount(state,owner,email,acceptance(p));
 assert.equal(result.tester.active,true);assert.equal(result.acceptance.typed_name,'Synthetic Tester');assert.equal(result.acceptance.email,email);assert.equal(result.acceptance.owner,owner);assert(result.acceptance.presented_at);assert(result.acceptance.accepted_at);
 assert.equal(result.acceptance.agreement_sha256,testers.agreement.sha256);assert.equal(result.acceptance.agreement_version,testers.agreement.version);
 assert.equal(testers.presentForAccount(state,owner,email).required,false);
});
test('checkbox, typed name and current agreement are each mandatory',()=>{
 for(const change of [{accepted:false},{typed_name:''},{agreement_version:'old'},{agreement_sha256:'0'.repeat(64)}]){
  const {state}=fixture(),p=testers.presentForAccount(state,owner,email);
  assert.throws(()=>testers.acceptForAccount(state,owner,email,{...acceptance(p),...change}));assert.equal(testers.active(state,owner),false);
 }
});
test('presentation challenge is bound to its member and cannot cross accounts',()=>{
 const {state}=fixture(),p=testers.presentForAccount(state,owner,email);
 assert.throws(()=>testers.acceptForAccount(state,'another-member',email,acceptance(p)));
 assert.equal(testers.presentForAccount(state,'another-member','other@example.invalid').required,false);
});
test('expired presentation is rejected without enrollment',()=>{
 const {state}=fixture(),p=testers.presentForAccount(state,owner,email);
 Object.values(state.testers.invitations)[0].presentation.at='2000-01-01T00:00:00Z';
 assert.throws(()=>testers.acceptForAccount(state,owner,email,acceptance(p)));assert.equal(testers.active(state,owner),false);
});
test('revoked invitation cannot be presented or accepted',()=>{
 const {state,invitation}=fixture(),p=testers.presentForAccount(state,owner,email);
 testers.revoke(state,{invitation_id:invitation.invitation_id,actor:'Synthetic test',reason:'Synthetic revocation'});
 assert.equal(testers.presentForAccount(state,owner,email).required,false);assert.throws(()=>testers.acceptForAccount(state,owner,email,acceptance(p)));
});
test('original invitation-token acceptance remains supported',()=>{
 const {state,invitation}=fixture(),token=invitation.invitation_url.split('#invite=')[1];
 const p=testers.present(state,owner,email,token);assert(testers.accept(state,owner,email,{...acceptance(p),token}).tester.active);
});
test('acceptance survives persistent store reload and does not activate another member',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'px-tester-consent-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 await createStore(dir).inviteTester({email,actor:'Synthetic test'});
 const p=await createStore(dir).presentTesterForAccount(owner,email);
 await createStore(dir).acceptTesterForAccount(owner,email,acceptance(p));
 assert((await createStore(dir).testerStatus(owner)).active);assert.equal((await createStore(dir).testerStatus('another-member')).active,false);
});
test('acceptance route uses authenticated identity rather than submitted identity',async()=>{
 const routes=new Map(),calls=[];
 const app={get:(p,...h)=>routes.set('GET '+p,h),post:(p,...h)=>routes.set('POST '+p,h)};
 require('../tester-consent-routes').attach(app,{root:'/synthetic',authenticatedMember:()=>{},requireSameOrigin:()=>{},store:{acceptTesterForAccount:async(...args)=>{calls.push(args);return {tester:{active:true},acceptance:{accepted_at:'synthetic'}};}}});
 const handler=routes.get('POST /api/session/tester-agreement').at(-1);
 const res={set(){return this;},json(v){this.body=v;}};
 await handler({memberId:owner,memberEmail:email,body:{owner:'attacker',email:'other@example.invalid',accepted:true,typed_name:'Synthetic Tester'}},res,e=>{throw e;});
 assert.equal(calls[0][0],owner);assert.equal(calls[0][1],email);assert.equal(calls[0][2].owner,undefined);assert.equal(res.body.active,true);
});
async function clientFixture(view){
 const ids=['testerAgreementPanel','testerAgreementTitle','testerAgreementEmail','testerAgreementText','testerAgreementFields','testerAgreementStatus','testerTypedName','testerAgree','testerPendingNotice'];
 const elements=Object.fromEntries(ids.map(id=>[id,{hidden:true,value:'',checked:false,textContent:'',innerHTML:'',addEventListener(){}}]));
 const requests=[];const context={document:{getElementById:id=>elements[id]||null},window:{},fetch:async(url,options)=>{requests.push(options);return {ok:true,json:async()=>options.method==='POST'?{ok:true,active:true,accepted_at:'synthetic'}:{ok:true,...structuredClone(view)}};}};
 vm.createContext(context);vm.runInContext(await fs.readFile(path.join(__dirname,'../public/voice-capture-assets/tester-consent.js'),'utf8'),context);
 return {api:context.window.PXTesterConsent,elements,requests};
}
test('regular-customer browser keeps tester fields hidden and sends no acceptance',async()=>{
 const {api,elements,requests}=await clientFixture({required:false,active:false,status:'NOT_ENROLLED'});await api.load();assert(api.ready());assert(elements.testerAgreementPanel.hidden);await api.ensure();assert.equal(requests.length,1);
});
test('tester browser shows full agreement with unchecked consent and waits for a name',async()=>{
 const {state}=fixture(),view=testers.presentForAccount(state,owner,email),{api,elements,requests}=await clientFixture(view);
 await api.load();assert.equal(elements.testerAgreementPanel.hidden,false);assert.doesNotMatch(elements.testerAgreementText.innerHTML,/<td>Tester name<\/td>|Typed name: _+/);
 for(const paragraph of testers.agreement.html.match(/<p>[\s\S]*?<\/p>/g)||[]){
  if(!paragraph.startsWith('<p>Typed name:'))assert(elements.testerAgreementText.innerHTML.includes(paragraph));
 }
 assert(elements.testerTypedName);assert.equal(elements.testerAgree.checked,false);assert.equal(api.ready(),false);
 await assert.rejects(api.ensure());assert.equal(requests.length,1);
 elements.testerTypedName.value='Synthetic Tester';elements.testerAgree.checked=true;assert(api.ready());await api.ensure();
 const payload=JSON.parse(requests[1].body);assert.equal(payload.accepted,true);assert.equal(payload.agreement_version,testers.agreement.version);assert.equal(payload.typed_name,'Synthetic Tester');assert.equal(payload.owner,undefined);assert.equal(elements.testerAgreementFields.hidden,true);
});
test('recording creation rejects a pending tester even if the browser claims acceptance',async()=>{
 const {requireAcceptance}=require('../tester-consent-routes');let called=false,checked;
 const store={testerConsentStatus:async(...args)=>{checked=args;return {required:true};}};
 const res={status(n){this.statusCode=n;return this;},json(body){this.body=body;}};
 await requireAcceptance(store)({captureProgram:'CUSTOMER',memberId:owner,memberEmail:email,body:{accepted:true,tester:true}},res,()=>{called=true;});
 assert.equal(called,false);assert.equal(res.statusCode,403);assert.equal(res.body.code,'TESTER_AGREEMENT_REQUIRED');assert.deepEqual(checked,[owner,email]);
});
test('regular and already accepted customers can continue recording creation',async()=>{
 const {requireAcceptance}=require('../tester-consent-routes');
 for(const status of [{required:false,active:false},{required:false,active:true}]){
  let called=false;await requireAcceptance({testerConsentStatus:async()=>status})({captureProgram:'CUSTOMER',memberId:owner,memberEmail:email},{},()=>{called=true;});assert(called);
 }
});
test('tester status failures stop creation instead of skipping the check',async()=>{
 const {requireAcceptance}=require('../tester-consent-routes');let result;
 await requireAcceptance({testerConsentStatus:async()=>{throw new Error('synthetic unavailable');}})({captureProgram:'CUSTOMER',memberId:owner,memberEmail:email},{},error=>{result=error;});
 assert.equal(result.message,'synthetic unavailable');
});
