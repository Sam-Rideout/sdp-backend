'use strict';
// Renewable storage permission. Consent history is separate from model/capture bytes.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const contract=require('./profile-contract');
const ZONE='America/Halifax',DAYS=90,NOTICE=3,FINAL_NOTICE=1,BASIS='ACCEPTED_RENEWABLE_PROFILE_CONSENT';
const sha=contract.hash;
function fail(message,status=409){const e=new Error(message);e.status=status;throw e;}
function parts(ms){return Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:ZONE,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(ms)).filter(x=>x.type!=='literal').map(x=>[x.type,Number(x.value)]));}
function addDays(value,days){
 const n=Date.parse(value);if(!Number.isFinite(n)||!Number.isInteger(days))fail('Invalid retention clock.');
 const p=parts(n),target=new Date(Date.UTC(p.year,p.month-1,p.day+days,p.hour,p.minute,p.second,n%1000));
 const wall=target.getTime();let guess=wall;
 for(let i=0;i<4;i++){const q=parts(guess),offset=Date.UTC(q.year,q.month-1,q.day,q.hour,q.minute,q.second)-Math.floor(guess/1000)*1000;const next=wall-offset;if(next===guess)break;guess=next;}
 // In a spring-forward gap, move to the first representable later local time.
 const q=parts(guess),actual=Date.UTC(q.year,q.month-1,q.day,q.hour,q.minute,q.second);
 if(actual<Math.floor(wall/1000)*1000)guess+=Math.floor(wall/1000)*1000-actual;
 return new Date(guess).toISOString();
}
const localDate=v=>{const p=parts(Date.parse(v));return `${p.year}-${String(p.month).padStart(2,'0')}-${String(p.day).padStart(2,'0')}`;};
function identity(record){return {owner_member_id:record.owner_member_id,customer_id:record.customer_id,voice_profile_id:record.voice_profile_id,voice_model_id:record.voice_model_id,session_id:record.session_id,certification_sha256:record.certification_sha256};}
function same(a,b){return Object.entries(identity(b)).every(([k,v])=>a[k]===v);}
function createProfileConsent(c){
 const {dataDir,store}=c,clock=c.clock||Date.now;
 if(contract.policy.profile_storage_days!==DAYS||contract.policy.profile_reminder_days!==NOTICE||contract.policy.profile_final_reminder_days!==FINAL_NOTICE||contract.policy.business_timezone!==ZONE)throw new Error('Renewable storage rules differ from the reviewed policy.');
 const secret=c.secret; if(typeof secret!=='string'||Buffer.byteLength(secret)<32)throw new Error('Profile consent signing key is unavailable.');
 const key=crypto.createHmac('sha256',secret).update('PX-PROFILE-CONSENT-EMAIL-1.0').digest();
 const root=path.join(dataDir,'profile-consent-history');
 function dir(record){return path.join(root,sha(record.owner_member_id),sha(record.voice_profile_id));}
 async function read(file){try{const s=await fs.lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.size>100000)fail('Consent evidence requires review.');return JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
 async function atomic(file,value,immutable=false){await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});const temp=file+'.'+crypto.randomUUID()+'.tmp';try{const f=await fs.open(temp,'wx',0o600);try{await f.writeFile(JSON.stringify(value,null,2)+'\n');await f.sync();}finally{await f.close();}if(immutable)await fs.link(temp,file);else await fs.rename(temp,file);}finally{await fs.unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}}
 function initial(record,manifest){
  contract.binding(record,manifest);const policy=contract.policyFor(manifest);
  if(manifest.consent.retention_choice!=='FUTURE_PURCHASES')return null;
  if(policy.profile_storage_days!==DAYS||policy.profile_reminder_days!==NOTICE||policy.profile_final_reminder_days!==FINAL_NOTICE||policy.business_timezone!==ZONE)fail('No reviewed renewable storage policy for this profile.');
  const e={schema_version:'PX-PROFILE-CONSENT-EVENT-1.0',...identity(record),revision:1,kind:'INITIAL',previous_sha256:null,accepted_at:manifest.consent.accepted_at,
   expires_at:addDays(manifest.consent.accepted_at,DAYS),profile_contract_sha256:sha(policy),consent_document_sha256:policy.consent_document_sha256,consent_version:policy.consent_version,
   account_email:record.account_email,development_use:manifest.consent.development_use,consent:manifest.consent,authorization:'SIGNED_ACCOUNT_CAPTURE'};
  return {...e,event_sha256:sha(e)};
 }
 async function current(record,manifest){
  const first=initial(record,manifest);if(!first)return null;
  let names=[];try{names=(await fs.readdir(dir(record))).filter(x=>/^event-\d{6}-[a-f0-9]{64}\.json$/.test(x)).sort();}catch(e){if(e.code!=='ENOENT')throw e;}
  if(names.length>1000)fail('Consent history requires maintenance.');let prior=null;
  for(const name of names){const e=await read(path.join(dir(record),name)),{event_sha256,...body}=e||{};
   if(sha(body)!==event_sha256||name!==`event-${String(e.revision).padStart(6,'0')}-${event_sha256}.json`||!same(e,record)||e.revision!==(prior?prior.revision+1:1)||e.previous_sha256!==(prior?prior.event_sha256:null))fail('Consent history integrity differs.');
   if(!prior&&e.event_sha256!==first.event_sha256)fail('Original capture consent differs.');
   prior=e;
  }
  return prior||first;
 }
 async function persist(e,record){await atomic(path.join(dir(record),`event-${String(e.revision).padStart(6,'0')}-${e.event_sha256}.json`),e,true);}
 async function selected(member,id){const matches=(await c.profiles(member)).filter(x=>x.record.voice_profile_id===id);if(matches.length!==1)fail('The exact owned voice profile is unavailable.',404);return matches[0];}
 async function usable(record,manifest){if(record.status!=='READY'||await store.read(record.owner_member_id,record.voice_profile_id))fail('This profile is withdrawn or unavailable.');return current(record,manifest);}
 function token(e){const body=Buffer.from(JSON.stringify({purpose:'renew-profile-consent',member:e.owner_member_id,profile:e.voice_profile_id,event:e.event_sha256,expires_at:e.expires_at})).toString('base64url');return body+'.'+crypto.createHmac('sha256',key).update(body).digest('base64url');}
 function decode(value){if(typeof value!=='string'||value.length>4000)fail('This renewal link is invalid.',401);const [body,sig,...extra]=value.split('.'),expected=crypto.createHmac('sha256',key).update(body||'').digest();let actual;try{actual=Buffer.from(sig||'','base64url');}catch{fail('This renewal link is invalid.',401);}if(extra.length||actual.length!==expected.length||!crypto.timingSafeEqual(actual,expected))fail('This renewal link is invalid.',401);let t;try{t=JSON.parse(Buffer.from(body,'base64url').toString());}catch{fail('This renewal link is invalid.',401);}if(t.purpose!=='renew-profile-consent'||typeof t.member!=='string'||typeof t.profile!=='string'||Date.parse(t.expires_at)<=clock())fail('This renewal link has expired.',410);return t;}
 function publicView(e){return {voice_profile_id:e.voice_profile_id,revision:e.revision,event_sha256:e.event_sha256,expires_at:e.expires_at,reminder_at:addDays(e.expires_at,-NOTICE),final_reminder_at:addDays(e.expires_at,-FINAL_NOTICE),business_timezone:ZONE,development_use:e.development_use,consent_version:contract.policy.consent_version,consent_document_sha256:contract.policy.consent_document_sha256,expired:Date.parse(e.expires_at)<=clock()};}
 async function inspectLink(value){const t=decode(value),{record,manifest}=await selected(t.member,t.profile),e=await usable(record,manifest);if(!e||e.event_sha256!==t.event)fail('This consent was already renewed. Use the latest link.');return publicView(e);}
 async function renew({member,profile,token:link,body}){
  const t=link?decode(link):null;if(t){member=t.member;profile=t.profile;}
  return store.exclusive(member,async()=>{
   const {record,manifest}=await selected(member,profile),e=await usable(record,manifest);
   if(!e||Date.parse(e.expires_at)<=clock())fail('The renewal deadline has passed.',410);
   if((t&&e.event_sha256!==t.event)||body?.expected_event_sha256!==e.event_sha256)fail('Consent changed. Refresh before signing.');
   const p=contract.policy;
   if(body.agree!==true||body.adult_confirmed!==true||body.own_voice_confirmed!==true||typeof body.development_use!=='boolean'||body.consent_version!==p.consent_version||body.consent_document_sha256!==p.consent_document_sha256)fail('Explicit acceptance of the current consent terms is required.',400);
   const now=new Date(clock()).toISOString();
   const next={schema_version:e.schema_version,...identity(record),revision:e.revision+1,kind:'RENEWAL',previous_sha256:e.event_sha256,accepted_at:now,expires_at:addDays(now,DAYS),profile_contract_sha256:sha(p),consent_document_sha256:p.consent_document_sha256,consent_version:p.consent_version,account_email:e.account_email,development_use:body.development_use,
    consent:{agree:true,adult_confirmed:true,own_voice_confirmed:true,development_use:body.development_use,notice_text:p.consent_notice,retention_text:p.consent_choices.future_purchases,improvement_text:p.consent_choices.development_use},authorization:t?'EMAIL_POSSESSION_LINK':'SIGNED_IN_ACCOUNT'};
   // Save original evidence once. Neither the original manifest nor certificate changes.
   if(e.revision===1){const f=path.join(dir(record),`event-000001-${e.event_sha256}.json`);if(!await read(f))await persist(e,record);}
   const event={...next,event_sha256:sha(next)};await persist(event,record);return publicView(event);
  });
 }
 async function state(record,manifest){const e=await current(record,manifest);return e?publicView(e):null;}
 function noticeKind(b){if(!['THREE_DAY','ONE_DAY'].includes(b.notice_kind))fail('Explicit reminder stage is required.',400);return b.notice_kind;}
 function noticeFile(record,e,kind){return path.join(dir(record),'notice-'+e.event_sha256+'-'+kind+'.json');}
 async function notification(record,e,kind='THREE_DAY'){return read(noticeFile(record,e,kind));}
 async function candidates(){
  const base=path.join(dataDir,'voice-profile-records'),members=new Set();let dirs=[];try{dirs=await fs.readdir(base,{withFileTypes:true});}catch(e){if(e.code==='ENOENT')return [];throw e;}
  for(const d of dirs){if(!d.isDirectory()||!/^[a-f0-9]{64}$/.test(d.name))continue;for(const f of await fs.readdir(path.join(base,d.name))){if(!/^[a-f0-9-]{36}\.json$/.test(f))continue;const r=await read(path.join(base,d.name,f));if(r?.owner_member_id&&sha(r.owner_member_id)===d.name)members.add(r.owner_member_id);}}
  const result=[];for(const member of members)for(const row of await c.profiles(member))if(row.record.status==='READY'&&row.manifest.consent?.retention_choice==='FUTURE_PURCHASES')result.push(row);return result;
 }
 async function work(){const result=[];for(const {record,manifest} of await candidates()){
  if(await store.read(record.owner_member_id,record.voice_profile_id))continue;const e=await current(record,manifest),view=publicView(e),kind=clock()>=Date.parse(view.final_reminder_at)?'ONE_DAY':'THREE_DAY',n=await notification(record,e,kind);
  if(clock()<Date.parse(view.reminder_at))continue;
  result.push({...identity(record),event_sha256:e.event_sha256,revision:e.revision,expires_at:e.expires_at,notice_kind:kind,action:view.expired?'EXPIRE':(n?.status==='SENT'||Date.parse(n?.next_attempt_at)>clock()||(n?.status==='CLAIMED'&&Date.parse(n.lease_until)>clock()))?'WAIT':'REMIND',notice_status:n?.status||'NOT_SENT'});
 }return result;}
 async function exact(b){const row=await selected(b.owner_member_id,b.voice_profile_id),e=await usable(row.record,row.manifest);if(!e||b.event_sha256!==e.event_sha256||!same(b,row.record))fail('Stale retention work was refused.');return {...row,e};}
 async function claim(b){return store.exclusive(b.owner_member_id,async()=>{
  const {record,e}=await exact(b),now=clock(),kind=noticeKind(b),at=addDays(e.expires_at,kind==='ONE_DAY'?-FINAL_NOTICE:-NOTICE);
  if(now<Date.parse(at)||now>=Date.parse(e.expires_at)||localDate(new Date(now).toISOString())>localDate(at)||(kind==='THREE_DAY'&&now>=Date.parse(addDays(e.expires_at,-FINAL_NOTICE))))fail('Reminder is outside its sending window.');
  const old=await notification(record,e,kind);if(old?.status==='SENT')return {already_sent:true};
  if(old?.next_attempt_at&&Date.parse(old.next_attempt_at)>now)fail('Reminder retry is not due.');
  if(old?.status==='CLAIMED'&&Date.parse(old.lease_until)>now)fail('Reminder is being sent.');
  const n={event_sha256:e.event_sha256,notice_kind:kind,status:'CLAIMED',claim_id:crypto.randomUUID(),lease_until:new Date(now+300000).toISOString(),attempts:(old?.attempts||0)+1};
  await atomic(noticeFile(record,e,kind),n);
  return {...n,to:e.account_email,renewal_token:token(e),expires_at:e.expires_at,reminder_at:at,message_id:'<px-consent-'+e.event_sha256+'-'+kind.toLowerCase()+'@sdpsongs.ca>'};
 });}
 async function acknowledge(b){return store.exclusive(b.owner_member_id,async()=>{
  const {record,e}=await exact(b),kind=noticeKind(b),old=await notification(record,e,kind);
  if(!old||old.claim_id!==b.claim_id||old.status!=='CLAIMED'||Date.parse(old.lease_until)<clock())fail('Reminder claim is stale.');
  if(typeof b.sent!=='boolean')fail('Explicit reminder result is required.',400);
  const n={...old,status:b.sent?'SENT':'FAILED',...(b.sent?{sent_at:new Date(clock()).toISOString()}:{next_attempt_at:new Date(clock()+1800000).toISOString()})};
  await atomic(noticeFile(record,e,kind),n);return {ok:true,status:n.status};
 });}
 async function expire(b){
  const row=await selected(b.owner_member_id,b.voice_profile_id);
  return store.requestChecked(b.owner_member_id,row.record,async()=>{
   const {record,e}=await exact(b);if(clock()<Date.parse(e.expires_at))fail('Profile retention has not expired.');
   const n=await notification(record,e);
   // A missed notice is an operational hold, never fabricated delivery evidence.
   if(n?.status!=='SENT'||localDate(n.sent_at)>localDate(addDays(e.expires_at,-NOTICE)))fail('Deletion held: the three-day reminder was not sent on time.');
   const final=await notification(record,e,'ONE_DAY');
   if(final?.status!=='SENT'||localDate(final.sent_at)>localDate(addDays(e.expires_at,-FINAL_NOTICE)))fail('Deletion held: the one-day last-chance reminder was not sent on time.');
   return {basis:BASIS,last_chance_sent_at:final.sent_at,revision:e.revision,consent_event_sha256:e.event_sha256,consent_version:e.consent_version,expires_at:e.expires_at,reminder_sent_at:n.sent_at,authorized_at:new Date(clock()).toISOString()};
  });
 }
 return {current,state,renew,inspectLink,work,claim,acknowledge,expire};
}
function attachProfileConsent(app,c){
 const service=createProfileConsent(c),wrap=fn=>async(req,res,next)=>{try{res.set('Cache-Control','no-store');res.json(await fn(req));}catch(e){next(e);}};
 app.post('/api/profile-consent/link',c.requireSameOrigin,wrap(req=>service.inspectLink(req.body?.token)));
 app.post('/api/profile-consent/renew-link',c.requireSameOrigin,wrap(req=>{if(typeof req.body?.token!=='string')fail('A private renewal link is required.',401);return service.renew({token:req.body.token,body:req.body});}));
 app.post('/api/profile-consent/renew',c.authenticatedMember,c.requireSameOrigin,wrap(req=>service.renew({member:req.memberId,profile:req.body?.voice_profile_id,body:req.body})));
 app.post('/api/transfer/profile-consent/capabilities',c.transferAuth,wrap(()=>({ok:true,protocol:'PX-RENEWABLE-CONSENT-1.0',storage_days:DAYS,reminder_days:[NOTICE,FINAL_NOTICE],business_timezone:ZONE})));
 app.post('/api/transfer/profile-consent/work',c.transferAuth,wrap(()=>service.work()));
 for(const [route,method] of [['claim-reminder','claim'],['ack-reminder','acknowledge'],['expire','expire']])app.post('/api/transfer/profile-consent/'+route,c.transferAuth,wrap(req=>service[method](req.body)));
 return service;
}
module.exports={createProfileConsent,attachProfileConsent,addDays,localDate,BASIS,DAYS,NOTICE,FINAL_NOTICE,ZONE};
