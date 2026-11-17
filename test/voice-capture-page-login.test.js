'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const source=fs.readFileSync(path.join(root,'server.js'),'utf8');
function section(start,end){return source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));}
const context={Buffer,crypto,process:{env:{WIX_HANDOFF_SECRET:'test-secret-for-member-entry-at-least-32-characters'}},ROOT:root,path,COOKIE_NAME:'px_voice_session',URIError,decodeURIComponent};
vm.createContext(context);
vm.runInContext([
 section('function secret()', 'async function consumeTicket'),
 section('function cookieValue(', 'function requireSameOrigin'),
 "function normalizeEmail(v){return typeof v==='string'?v.trim().toLowerCase():'';}"
].join('\n'),context);
function request(cookie='',route='/voice-capture'){
 const req={headers:{cookie},path:route};
 const res={statusCode:200,vary(){return this;},status(code){this.statusCode=code;return this;},sendFile(file){this.file=file;return this;},json(value){this.body=value;return this;}};
 let next=false,error;
 context.authenticatedMember(req,res,e=>{if(e)error=e;else next=true;});
 return {req,res,next,error};
}
const member={iss:'project-x-voice-capture',sub:'member-123',email:'sam@example.com',exp:Math.floor(Date.now()/1000)+3600};
const cookie=value=>'px_voice_session='+encodeURIComponent(value);
test('anonymous, expired, forged and malformed cookies cannot open the recorder',()=>{
 for(const value of ['',cookie(context.sign({...member,exp:1})),cookie(context.sign(member)+'x'),'px_voice_session=%E0%A4%A']){
  const r=request(value);assert.equal(r.next,false);assert.equal(r.error,undefined);assert.equal(r.res.statusCode,401);assert.equal(r.res.file,path.join(root,'public','voice-capture-sign-in.html'));
 }
});
test('a valid signed member cookie grants access and binds the member',()=>{
 const r=request(cookie(context.sign(member)));assert.equal(r.next,true);assert.equal(r.req.memberId,member.sub);assert.equal(r.req.memberEmail,member.email);
});
test('API clients keep their JSON 401 response',()=>{
 const r=request('','/api/sessions');assert.equal(r.res.statusCode,401);assert.match(r.res.body.error,/Sign in/);assert.equal(r.res.file,undefined);
});
test('the recorder route requires the authentication middleware',()=>{
 assert.match(source,/app.get\('\/voice-capture', authenticatedMember,/);
 const html=fs.readFileSync(path.join(root,'public','voice-capture-sign-in.html'),'utf8');
 assert.doesNotMatch(html,/capture-engine|<audio|<input|guidedBegin/);
});
const entry=fs.readFileSync(path.join(root,'public','voice-capture-assets','member-entry.js'),'utf8');
async function entryRun(hash,response={ok:true}){
 const state={fetches:[],history:[],redirects:[],status:{textContent:''},panel:{hidden:true},entryStatus:{hidden:false}};
 const globals={URLSearchParams,location:{hash,pathname:'/voice-capture',search:'',replace:url=>state.redirects.push(url)},
  history:{replaceState:(_a,_b,url)=>state.history.push(url)},document:{getElementById:id=>({'signInStatus':state.status,'signInPanel':state.panel,'entryStatus':state.entryStatus})[id]},
  fetch:async(url,options)=>{state.fetches.push({url,options});if(response instanceof Error)throw response;return response;}};
 await vm.runInNewContext(entry,globals);return state;
}
test('no ticket leaves an anonymous visitor on the sign-in screen',async()=>{
 const r=await entryRun('');assert.equal(r.fetches.length,0);assert.equal(r.redirects.length,0);assert.equal(r.panel.hidden,false);
});
test('Wix handoff exchanges the ticket and preserves progress without retaining the token',async()=>{
 const r=await entryRun('#ticket=one-use-ticket&view=progress');
 assert.equal(r.fetches.length,1);assert.equal(r.fetches[0].url,'/api/session/exchange');
 assert.equal(r.fetches[0].options.credentials,'same-origin');
 assert.equal(JSON.parse(r.fetches[0].options.body).ticket,'one-use-ticket');
 assert.deepEqual(r.history,['/voice-capture?view=progress']);
 assert.deepEqual(r.redirects,['/voice-capture?view=progress']);
 assert.equal(r.panel.hidden,true);assert.equal(r.entryStatus.hidden,false);
});
test('rejected and unavailable exchanges do not redirect or expose the ticket',async()=>{
 for(const response of [{ok:false},new Error('offline')]){
  const r=await entryRun('#ticket=private-ticket',response);
  assert.equal(r.redirects.length,0);assert.match(r.status.textContent,/could not be confirmed/);
  assert.equal(r.panel.hidden,false);assert.equal(r.entryStatus.hidden,true);
  assert.doesNotMatch(r.status.textContent,/private-ticket/);
 }
});

test('the initial document hides the sign-in panel until the handoff is checked',()=>{
 const html=fs.readFileSync(path.join(root,'public','voice-capture-sign-in.html'),'utf8');
 assert.match(html,/<main id="signInPanel" hidden>/);
 assert.match(html,/<noscript><style>#signInPanel\[hidden\]/);
});
