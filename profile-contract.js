'use strict';
// Server-issued Tier 2 protocol and immutable consent/account binding.
const crypto=require('node:crypto');
const policy=require('./config/profile-contract.json');
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const hash=v=>crypto.createHash('sha256').update(typeof v==='string'?v:JSON.stringify(canonical(v))).digest('hex');
function requireValue(ok,message){if(!ok)throw new Error(message);}
function email(value){requireValue(typeof value==='string'&&value===value.trim().toLowerCase()&&value.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),'A normalized account email is required.');return value;}
function config(value){
 requireValue(value.schema_version==='PX-TIER2-CAPTURE-PROMPTS-1.0.0'&&value.training_tier==='02'&&value.capture_protocol_id===policy.capture_protocol_id&&value.prompts_approved===true,'Only the approved Tier 2 capture protocol is enabled.');
 const protocol=Object.fromEntries(['training_tier','capture_protocol_id','sections','finish_standard','recording_setup_enabled'].map(k=>[k,value[k]]));
 requireValue(hash(protocol)===policy.capture_protocol_sha256,'Tier 2 exercise protocol differs from the reviewed version.');
 requireValue(value.consent_version===policy.consent_version&&value.consent_notice===policy.consent_notice&&hash(value.consent_choices)===hash(policy.consent_choices),'Consent wording differs from the reviewed Tier 2 contract.');
 const current=require('node:fs').readFileSync(require('node:path').join(__dirname,'public/consent.html'));
 requireValue(crypto.createHash('sha256').update(current).digest('hex')===policy.consent_document_sha256,'Full consent document differs from the reviewed contract.');
 return {...fields(),consent_document_sha256:policy.consent_document_sha256,consent_document_version:policy.consent_document_version};
}
function policyFor(value){
 const id=value?.profile_contract_sha256;requireValue(typeof id==='string'&&/^[a-f0-9]{64}$/.test(id),'Exact profile contract fingerprint is required.');
 const p=id===hash(policy)?policy:JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname,'config/profile-contracts',id+'.json'),'utf8'));
 requireValue(hash(p)===id&&p.schema_version===policy.schema_version&&p.training_tier==='02','Archived Tier 2 contract differs.');return p;
}
function fields(p=policy){return {contract_version:p.schema_version,profile_contract_sha256:hash(p),training_tier:'02',capture_protocol_id:p.capture_protocol_id,capture_protocol_sha256:p.capture_protocol_sha256};}
function acceptanceTime(value,now){
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value))return false;
 const y=Number(value.slice(0,4)),mo=Number(value.slice(5,7)),d=Number(value.slice(8,10));
 return y>=1&&mo>=1&&mo<=12&&d>=1&&d<=new Date(Date.UTC(y,mo,0)).getUTCDate()&&Number(value.slice(11,13))<=23&&Number(value.slice(14,16))<=59&&Number(value.slice(17,19))<=59&&Number.isFinite(Date.parse(value))&&Date.parse(value)<=now+60000;
}
function consent(value,now=Date.now(),p=policy){
 requireValue(value&&value.accepted===true&&value.current_order===true&&value.adult_confirmed===true&&value.own_voice_confirmed===true&&typeof value.development_use==='boolean','Explicit current-order, adult and own-voice consent is required.');
 requireValue(value.version===p.consent_version&&['DELETE_AFTER_ORDER','FUTURE_PURCHASES'].includes(value.retention_choice)&&value.future_purchase_storage===(value.retention_choice==='FUTURE_PURCHASES'),'Current consent version and one consistent retention choice are required.');
 requireValue(value.notice_text===p.consent_notice&&value.eligibility_notice===p.eligibility_notice,'The consent notice/eligibility evidence differs.');
 const retention=p.consent_choices[value.retention_choice==='FUTURE_PURCHASES'?'future_purchases':'delete_after_order'];
 requireValue(value.choice_text?.retention===retention&&value.choice_text?.development_use===p.consent_choices.development_use,'The selected consent wording differs.');
 const expected=hash(JSON.stringify({notice:p.consent_notice,choices:p.consent_choices,eligibility_notice:p.eligibility_notice}));
 requireValue(value.consent_evidence_sha256===expected,'Consent notice evidence hash differs.');
 requireValue(acceptanceTime(value.accepted_at,now),'Consent acceptance time is invalid.');
 requireValue(value.consent_document_sha256===p.consent_document_sha256&&value.consent_document_version===p.consent_document_version,'The full consent document reference differs.');
 return hash(value);
}
function manifest(value,owner){
 const p=policyFor(value);
 requireValue(value?.program==='CUSTOMER'&&value.schema_version===p.capture_schema&&value.training_tier==='02'&&value.contract_version===p.schema_version&&value.capture_protocol_id===p.capture_protocol_id&&value.capture_protocol_sha256===p.capture_protocol_sha256,'A new server-issued Tier 2 capture is required. Older sessions cannot be relabelled.');
 requireValue(typeof owner==='string'&&/^[A-Za-z0-9_-]{3,200}$/.test(owner)&&(!value.owner_member_id||value.owner_member_id===owner),'Capture owner differs.');
 requireValue(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.session_id||''),'Exact capture session identity is required.');
 const identity=value.customer_identity;
 requireValue(identity?.schema_version==='PX-WIX-CUSTOMER-IDENTITY-1.0'&&identity.member_id===owner,'The capture needs its signed account identity snapshot.');
 return {...fields(p),account_email:email(identity.email),consent_session_id:value.session_id,consent_version:value.consent.version,consent_sha256:consent(value.consent,Date.now(),p),consent_document_sha256:p.consent_document_sha256,consent_document_version:p.consent_document_version};
}
function binding(record,value){
 const expected=manifest(value,record.owner_member_id);
 for(const [key,v] of Object.entries(expected))requireValue(record[key]===v,'Profile '+key+' differs from the captured consent/account.');
 requireValue(/^PXC-\d{6}$/.test(record.customer_id||'')&&/^RVC_Train_[A-Za-z0-9_-]+_Tier_02_Epoch_300_[CS]_[a-f0-9]{16}$/.test(record.voice_model_id||'')&&record.voice_profile_id==='PXPITCH-'+record.voice_model_id,'A new exact Tier 2 customer profile identity is required.');
 return expected;
}
function certificate(body,value){
 requireValue(typeof body.certificate_json==='string'&&Buffer.byteLength(body.certificate_json)<=32768,'Exact certificate bytes are required for READY.');
 const checksum=hash(body.certificate_json);
 requireValue(checksum===body.certification_sha256&&body.certification_id==='PXCERT-'+checksum.slice(0,32).toUpperCase(),'Certificate fingerprint differs.');
 let c;try{c=JSON.parse(body.certificate_json);}catch{throw new Error('Invalid certificate JSON.');}
 requireValue(c.schema_version==='PX-CUSTOMER-VOICE-CERTIFICATION-1.0'&&c.status==='CERTIFIED'&&c.wix_member_id===value.owner_member_id&&c.session_id===value.session_id,'Certificate ownership/session differs.');
 for(const key of ['voice_profile_id','voice_model_id','customer_id','model_sha256','index_sha256'])requireValue(c[key]===body[key],'Certificate '+key+' differs from READY publication.');
 requireValue(consent(c.consent,Date.now(),policyFor(value))===consent(value.consent,Date.now(),policyFor(value)),'Certificate consent snapshot differs.');
 const result=binding({...c,owner_member_id:c.wix_member_id},value);
 return result;
}
module.exports={policy,policyFor,canonical,hash,email,config,fields,consent,manifest,binding,certificate};
