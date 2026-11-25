'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const contract=require('./profile-contract');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function fail(message){throw new Error(message);}
const LEGACY_VERSIONS=new Set(['customer-voice-capture-2026-10-16-v1','customer-phone-sequence-test-2026-10-09-v2']);
function legacyRecord(manifest){
  const consent=manifest.consent;
  if(manifest.program!=='CUSTOMER'||manifest.training_tier!=null||manifest.profile_contract_sha256!=null||
    consent.consent_document_sha256!=null||consent.accepted!==true||!LEGACY_VERSIONS.has(consent.version)||
    typeof consent.accepted_at!=='string'||!Number.isFinite(Date.parse(consent.accepted_at)))return null;
  const fields=['version','accepted','accepted_at','current_order','retention_choice','retention_policy',
    'future_purchase_storage','development_use','adult_confirmed','own_voice_confirmed',
    'notice_text','choice_text','eligibility_notice','consent_evidence_sha256'];
  const saved=Object.fromEntries(fields.filter(key=>Object.hasOwn(consent,key)).map(key=>[key,consent[key]]));
  return {kind:'LEGACY_VOICE_RECORDING',reference:manifest.session_id,title:'Historical Voice Recording Consent',
    accepted_at:consent.accepted_at,version:consent.version,evidence_status:'HISTORICAL_SNAPSHOT',saved_consent:saved,
    evidence_note:'This historical record predates versioned full-document archives. The fields below are the consent details saved with this recording session. An exact archived full agreement is not available, so full-document verification is not claimed. This display grants no new permission.'};
}
async function documentReference(root,fingerprint){
  if(!/^[a-f0-9]{64}$/.test(fingerprint||''))fail('Saved agreement document reference is invalid.');
  const bytes=await fs.readFile(path.join(root,'public/consent-archive',fingerprint+'.html'));
  if(hash(bytes)!==fingerprint)fail('Saved agreement document differs.');
  return '/consent?version='+fingerprint;
}
async function voiceAgreements(c,member){
  const records=[],issues=[];
  for(const manifest of await c.ownedSessions(member)){
    if(manifest.owner_member_id!==member)fail('Recording agreement owner differs.');
    if(!manifest.consent?.accepted)continue;
    try{
      const legacy=legacyRecord(manifest);
      if(legacy){records.push(legacy);continue;}
      contract.manifest(manifest,member);
      const consent=manifest.consent;
      records.push({kind:'VOICE_RECORDING',reference:manifest.session_id,title:'Voice Recording Consent',
        accepted_at:consent.accepted_at,version:consent.version,document_sha256:consent.consent_document_sha256,
        document_url:await documentReference(c.root,consent.consent_document_sha256),
        choices:{retention:consent.retention_choice,retention_text:consent.choice_text.retention,
          improvement:consent.development_use,improvement_text:consent.choice_text.development_use},
        notice:consent.notice_text,eligibility:consent.eligibility_notice});
    }catch{issues.push({kind:'VOICE_RECORDING',reference:manifest.session_id,message:'The saved consent evidence needs Project X review.'});}
  }
  // Renewals survive separately from active model/recording bytes.
  const ownerHash=hash(member),base=path.join(c.dataDir,'profile-consent-history',ownerHash);
  let folders=[];try{folders=await fs.readdir(base,{withFileTypes:true});}catch(e){if(e.code!=='ENOENT')throw e;}
  for(const folder of folders){
    if(!folder.isDirectory()||!/^[a-f0-9]{64}$/.test(folder.name))continue;
    const directory=path.join(base,folder.name);let prior=null;
    try{
      const names=(await fs.readdir(directory)).filter(n=>/^event-\d{6}-[a-f0-9]{64}\.json$/.test(n)).sort();
      const pending=[];
      for(const name of names){
        const file=path.join(directory,name),stat=await fs.lstat(file);
        if(!stat.isFile()||stat.isSymbolicLink()||stat.size>100000)fail('Invalid consent event.');
        const event=JSON.parse(await fs.readFile(file,'utf8')),{event_sha256,...body}=event;
        if(event.owner_member_id!==member||hash(event.voice_profile_id)!==folder.name||contract.hash(body)!==event_sha256||
          name!==`event-${String(event.revision).padStart(6,'0')}-${event_sha256}.json`||
          event.revision!==(prior?prior.revision+1:1)||event.previous_sha256!==(prior?prior.event_sha256:null))fail('Consent event identity differs.');
        if(event.kind==='RENEWAL')pending.push({kind:'STORAGE_RENEWAL',reference:event_sha256,title:'Profile Storage Consent Renewal',
          accepted_at:event.accepted_at,version:event.consent_version,document_sha256:event.consent_document_sha256,
          document_url:await documentReference(c.root,event.consent_document_sha256),expires_at:event.expires_at,
          choices:{retention:'FUTURE_PURCHASES',retention_text:event.consent?.retention_text,
            improvement:event.development_use,improvement_text:event.consent?.improvement_text},notice:event.consent?.notice_text});
        prior=event;
      }
      records.push(...pending);
    }catch{issues.push({kind:'STORAGE_RENEWAL',message:'A saved renewal history needs Project X review.'});}
  }
  return {records,issues};
}
function attach(app,c){
  app.get('/my-agreements',(req,res)=>{res.set('Cache-Control','no-store');res.sendFile(path.join(c.root,'public/my-agreements.html'));});
  app.get('/api/session/agreements',c.authenticatedMember,async(req,res,next)=>{
    try{
      res.set('Cache-Control','private, no-store');res.vary('Cookie');
      const voice=await voiceAgreements(c,req.memberId);
      const testers=await c.store.testerAgreementsForAccount(req.memberId,req.memberEmail);
      res.json({ok:true,records:[...voice.records,...testers.records].sort((a,b)=>String(b.accepted_at).localeCompare(String(a.accepted_at))),
        issues:[...voice.issues,...testers.issues],coverage_note:'This page shows saved agreement evidence available to Project X. Missing or older records may require support review.'});
    }catch(error){next(error);}
  });
}
module.exports={attach,voiceAgreements,documentReference};
