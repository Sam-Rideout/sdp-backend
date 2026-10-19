'use strict';
// Authenticated PC bridge: revoke only an exact profile whose accepted deadline is due.
const crypto=require('node:crypto');
const hash=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
function fail(message,status=409){const e=new Error(message);e.status=status;throw e;}
function localParts(value){const p=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Halifax',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(value));return Object.fromEntries(p.filter(x=>x.type!=='literal').map(x=>[x.type,Number(x.value)]));}
function validateAuthority(b,manifest,profile,policy,now=Date.now()){
 if(policy.schema_version!=='PX-VOICE-RETENTION-POLICY-1.0'||policy.enabled!==true)fail('Automatic retention is not enabled.',503);
 if(!b||!/^PXO-\d{6}$/.test(b.order_id||'')||!/^PXC-\d{6}$/.test(b.customer_id||'')||!/^[a-f0-9]{64}$/.test(b.order_evidence_sha256||''))fail('Exact completed order authority is required.');
 if(manifest.session_id!==b.session_id||manifest.owner_member_id!==b.member_id||profile.owner_member_id!==b.member_id||profile.customer_id!==b.customer_id||profile.voice_profile_id!==b.profile_id||profile.voice_model_id!==b.model_id||profile.session_id!==b.session_id)fail('Retention profile ownership differs.');
 const consent=manifest.consent;
 if(!consent||consent.accepted!==true||consent.retention_choice!=='DELETE_AFTER_ORDER'||consent.version!==b.consent_version)fail('This consent does not authorize after-order deletion.');
 const rules=policy.consent_rules.filter(r=>r.version===consent.version&&r.choice_text_sha256===hash(consent.choice_text?.retention));
 if(rules.length!==1||![3,7].includes(rules[0].days)||rules[0].days!==b.accepted_days)fail('Accepted retention wording differs.');
 const start=Date.parse(b.completed_at),due=Date.parse(b.due_at),accepted=Date.parse(consent.accepted_at);
 const lead=policy.cleanup_lead_seconds===undefined?3600:policy.cleanup_lead_seconds;
 if(!Number.isInteger(lead)||lead<0||lead>3600)fail('Invalid retention cleanup lead time.');
 if(!Number.isFinite(start)||!Number.isFinite(due)||!Number.isFinite(accepted)||start<accepted||due>now+lead*1000||due<=start)fail('Retention cleanup window is not due or is invalid.');
 const a=localParts(start),z=localParts(due),expected=new Date(Date.UTC(a.year,a.month-1,a.day+b.accepted_days));
 if(z.year!==expected.getUTCFullYear()||z.month!==expected.getUTCMonth()+1||z.day!==expected.getUTCDate()||z.hour!==a.hour||z.minute!==a.minute||z.second!==a.second||Math.abs((due-start)/3600000-b.accepted_days*24)>1.01)fail('Retention deadline does not match accepted calendar days.');
 return {basis:'ACCEPTED_DELETE_AFTER_ORDER',order_id:b.order_id,completed_at:b.completed_at,due_at:b.due_at,accepted_days:b.accepted_days,consent_version:consent.version,choice_text_sha256:rules[0].choice_text_sha256,order_evidence_sha256:b.order_evidence_sha256};
}
function attachRetentionDeletion(app,c,store,policy){
 app.get('/api/transfer/profile-deletions/capabilities',c.transferAuth,(req,res)=>res.json({ok:true,protocol:'PX-AUTOMATIC-DELETION-1.0',enabled:policy.enabled===true,consent_rules:policy.consent_rules,cleanup_lead_seconds:policy.cleanup_lead_seconds??3600}));
 app.post('/api/transfer/profile-deletions/lookup',c.transferAuth,async(req,res,next)=>{try{
  const b=req.body,r=await store.read(b.member_id,b.profile_id);
  if(!r||r.customer_id!==b.customer_id||r.request_id!==b.request_id)fail('Exact deletion request was not found.',404);
  res.json({ok:true,request:r});
 }catch(e){next(e);}});
 app.post('/api/transfer/profile-deletions/retention',c.transferAuth,async(req,res,next)=>{try{
  const b=req.body;c.safeSessionId(b.session_id);
  const manifest=await c.readManifest(b.session_id);
  const matches=(await c.profiles(b.member_id)).filter(x=>x.record.voice_profile_id===b.profile_id);
  if(matches.length!==1)fail('One exact current owned profile is required.');
  const authority=validateAuthority(b,manifest,matches[0].record,policy);
  const r=await store.request(b.member_id,matches[0].record,authority);
  res.json({ok:true,request:r});
 }catch(e){next(e);}});
}
module.exports={validateAuthority,attachRetentionDeletion};
