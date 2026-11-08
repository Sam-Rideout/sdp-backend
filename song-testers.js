'use strict';
// All functions run inside the commerce store transaction. No browser-provided identity is trusted.
const crypto=require('node:crypto');
const agreement=require('./tester-agreement.json');
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const now=()=>new Date().toISOString();
function demand(ok,message,status=409){if(!ok){const e=new Error(message);e.status=status;throw e;}}
const email=x=>typeof x==='string'&&x.length<=254&&x===x.trim().toLowerCase()&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x);
const text=(x,max)=>typeof x==='string'&&x.trim()===x&&x.length>0&&x.length<=max&&!/[\x00-\x1f\x7f]/.test(x);
function db(s){if(!s.testers)s.testers={schema:'PX-SONG-TESTERS-1.0',invitations:{},enrollments:{},agreements:{}};demand(s.testers.schema==='PX-SONG-TESTERS-1.0','Tester records need review.',503);return s.testers;}
function enrollment(s,owner){return Object.values(db(s).enrollments).find(x=>x.owner===owner&&x.status==='ACTIVE');}
function active(s,owner){const e=enrollment(s,owner);return !!e&&e.agreement_sha256===agreement.sha256&&e.agreement_version===agreement.version;}
function known(s,owner){return Object.values(db(s).enrollments).some(x=>x.owner===owner);}
function evidence(e){return {enrollment_id:e.enrollment_id,invitation_id:e.invitation_id,owner:e.owner,email:e.email,
  agreement_version:e.agreement_version,agreement_sha256:e.agreement_sha256,accepted_at:e.accepted_at};}
function status(s,owner){const entries=Object.values(db(s).enrollments).filter(x=>x.owner===owner).sort((a,b)=>b.accepted_at.localeCompare(a.accepted_at));const e=enrollment(s,owner)||entries[0];
  return e?{active:active(s,owner),status:e.status,accepted_at:e.accepted_at,revoked_at:e.revoked_at||'',agreement_version:e.agreement_version,enrollment_id:e.enrollment_id}:{active:false,status:'NOT_ENROLLED'};}
function invite(s,body){demand(email(body.email)&&text(body.actor,160),'Enter the exact account email and operator name.',400);
  const d=db(s);demand(!Object.values(d.invitations).some(x=>x.email===body.email&&x.status==='INVITED')&&!Object.values(d.enrollments).some(x=>x.email===body.email&&x.status==='ACTIVE'),'This email already has an invitation or active enrollment.');
  const token=crypto.randomBytes(32).toString('hex'),id=crypto.randomUUID();
  d.invitations[id]={invitation_id:id,email:body.email,token_sha256:hash(token),status:'INVITED',created_at:now(),created_by:body.actor};
  return {invitation_id:id,email:body.email,invitation_url:'https://www.sdpsongs.ca/tester-invitation#invite='+token};
}
function invitation(s,owner,accountEmail,token){demand(text(owner,200)&&email(accountEmail)&&/^[a-f0-9]{64}$/.test(token||''),'Sign in using your invited account.',403);
  const i=Object.values(db(s).invitations).find(x=>x.token_sha256===hash(token));
  demand(i&&i.email===accountEmail&&['INVITED','ACCEPTED'].includes(i.status)&&(!i.owner||i.owner===owner),'This invitation is not available for this account.',403);return i;}
function present(s,owner,accountEmail,token){const i=invitation(s,owner,accountEmail,token);
  if(i.status==='ACCEPTED'){const e=db(s).enrollments[i.enrollment_id];return {tester:status(s,owner),accepted:true,email:accountEmail,acceptance:e,agreement:db(s).agreements[e.agreement_sha256]};}
  // A separate one-time presentation challenge binds the exact agreement sent by the server.
  const challenge=crypto.randomBytes(32).toString('hex');i.presentation={owner,challenge_sha256:hash(challenge),at:now(),agreement_sha256:agreement.sha256};
  return {accepted:false,email:accountEmail,invitation_id:i.invitation_id,challenge,agreement};}
function accept(s,owner,accountEmail,body){const i=invitation(s,owner,accountEmail,body.token);
  demand(body.accepted===true&&text(body.typed_name,160)&&body.agreement_sha256===agreement.sha256&&body.agreement_version===agreement.version,'Read the agreement, enter your name, and select the agreement checkbox.',400);
  if(i.status==='ACCEPTED'){const e=db(s).enrollments[i.enrollment_id];demand(e&&e.owner===owner&&e.status==='ACTIVE'&&e.typed_name===body.typed_name,'This invitation was already used or revoked.');return {tester:status(s,owner),acceptance:e,agreement:db(s).agreements[e.agreement_sha256]};}
  const p=i.presentation;demand(p&&p.owner===owner&&p.agreement_sha256===agreement.sha256&&/^[a-f0-9]{64}$/.test(body.challenge||'')&&p.challenge_sha256===hash(body.challenge)&&Date.now()-Date.parse(p.at)<=7200000,'Open the invitation and read the current agreement again.');
  demand(!enrollment(s,owner),'This member is already enrolled.');
  const e={...evidence({enrollment_id:crypto.randomUUID(),invitation_id:i.invitation_id,owner,email:accountEmail,agreement_version:agreement.version,agreement_sha256:agreement.sha256,accepted_at:now()}),typed_name:body.typed_name,accepted:true,status:'ACTIVE',email_source:'WIX_SIGNED_IN_ACCOUNT_MATCHED_INVITATION',presented_at:p.at};
  db(s).agreements[agreement.sha256]=structuredClone(agreement);db(s).enrollments[e.enrollment_id]=e;i.status='ACCEPTED';i.owner=owner;i.enrollment_id=e.enrollment_id;delete i.presentation;
  return {tester:status(s,owner),acceptance:e,agreement:db(s).agreements[e.agreement_sha256]};}
function revoke(s,body,owner){demand(text(body.reason,300)&&text(body.actor,160),'A revocation reason and actor are required.',400);const d=db(s);
  const e=owner?enrollment(s,owner):d.enrollments[body.enrollment_id];const i=body.invitation_id?d.invitations[body.invitation_id]:null;
  demand(e||i,'Tester invitation or enrollment not found.',404);const at=now();
  if(e&&e.status!=='REVOKED'){e.status='REVOKED';e.revoked_at=at;e.revoked_by=body.actor;e.revocation_reason=body.reason;const invitation=d.invitations[e.invitation_id];if(invitation)invitation.status='REVOKED';}
  if(i){i.status='REVOKED';i.revoked_at=at;i.revoked_by=body.actor;i.revocation_reason=body.reason;delete i.presentation;}
  return {ok:true,status:'REVOKED',revoked_at:e?.revoked_at||i.revoked_at};}
function authority(s,owner,promotion,accountEmail){const e=enrollment(s,owner);demand(e&&active(s,owner)&&(!accountEmail||e.email===accountEmail),'Promotional tester status is not active. Contact Project X or cancel this sample.');
  const expected=evidence(e);demand(promotion&&JSON.stringify(expected)===JSON.stringify(Object.fromEntries(Object.keys(expected).map(k=>[k,promotion[k]]))),'Promotional enrollment differs from this request.');return expected;}
module.exports={agreement,db,active,known,status,invite,present,accept,revoke,enrollment,evidence,authority};
