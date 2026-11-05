'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const ROOT=path.resolve(process.env.VOICE_DATA_DIR||'/var/data/project-x-voice-capture');
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const owners={
 'PXC-000003':'29b28efa-5b13-4799-a369-6348c59c0f5e',
 'PXC-000004':'ad658839-5770-47df-9e02-f0afe121713b'
};
const targets=[
 ['PXC-000003','PXPITCH-RVC_Train_Sam_Rideout_Tier_01_Epoch_300_C_a94eb240a3c3fd08','dfc84539-3e29-439e-9fb3-bb3c6674a849','PARTIAL'],
 ['PXC-000003','PXPITCH-RVC_Train_Sam_Rideout_Tier_01_Epoch_300_Phone_bca520914fc0','96870f41-bd0f-41af-b04e-9c77a31fc209','REQUESTED'],
 ['PXC-000003','PXPITCH-TRN-PC-19c512ae-af53-4280-a1e3-f93733a1391c',null,null],
 ['PXC-000004','PXPITCH-RVC_Train_Tabatha_Rideout_Tier_01_Epoch_300_C_924f00cafb84d1b3','b12115b5-2841-44f9-86f5-08cef16718a5','PARTIAL'],
 ['PXC-000004','PXPITCH-RVC_Train_Tabatha_Rideout_Tier_01_Epoch_300_C_0af1d80f0d782ca8','081ea6ad-21d1-429a-9fb5-74b1a2b845ce','PARTIAL']
];
function must(ok,message){if(!ok)throw Error(message);}
function safe(file){const p=path.resolve(file);must(p===ROOT||p.startsWith(ROOT+path.sep),'Path escaped managed storage.');let at=ROOT;for(const part of path.relative(ROOT,p).split(path.sep).filter(Boolean)){at=path.join(at,part);if(fs.existsSync(at))must(!fs.lstatSync(at).isSymbolicLink(),'Linked path requires review.');}return p;}
function files(dir){dir=safe(dir);if(!fs.existsSync(dir))return [];const result=[];for(const n of fs.readdirSync(dir)){const p=safe(path.join(dir,n)),s=fs.lstatSync(p);if(s.isDirectory())result.push(...files(p));else{must(s.isFile()&&s.nlink===1,'Shared/nonregular file requires review.');result.push(p);}}return result;}
function read(p){p=safe(p);must(fs.statSync(p).size<2000000,'Metadata file is too large.');return JSON.parse(fs.readFileSync(p,'utf8'));}
const id=r=>r.voice_profile_id, byId=new Map(targets.map(t=>[t[1],t]));
function inventory(){
 const rows=[],seen=new Set(),sessions=new Set();
 for(const [customer,member] of Object.entries(owners)){
  const source=files(path.join(ROOT,'voice-profile-records',sha(member))).filter(f=>f.endsWith('.json'));
  const legacy=safe(path.join(ROOT,'voice-profile-status',sha(member)+'.json'));if(fs.existsSync(legacy))source.push(legacy);
  for(const file of source){const r=read(file),target=byId.get(id(r));if(!target)continue;
   must(r.customer_id===target[0]&&r.customer_id===customer&&r.owner_member_id===member&&r.voice_model_id===id(r).slice(8),'Profile ownership differs.');
   must(/^[a-f0-9-]{36}$/i.test(r.session_id),'Invalid capture session.');
   const manifest=read(path.join(ROOT,'sessions',r.session_id,'manifest.json'));
   must(manifest.session_id===r.session_id&&manifest.owner_member_id===member,'Capture ownership differs.');
   sessions.add(r.session_id);seen.add(id(r));rows.push({relative:path.relative(ROOT,file),sha256:sha(fs.readFileSync(file)),kind:'PROFILE_RECORD',profile_id:id(r)});
  }
 }
 must(seen.size===5&&targets.every(t=>seen.has(t[1])),'Expected exactly the five reviewed legacy profiles.');
 // All records sharing these sessions must also belong to the reviewed scope.
 for(const file of files(path.join(ROOT,'voice-profile-records')).filter(f=>f.endsWith('.json'))){const r=read(file);if(sessions.has(r.session_id))must(byId.has(id(r)),'A retained profile shares a reviewed session.');}
 const voice=/\.(wav|webm|mp3|m4a|ogg|flac|mp4|audio|pth|index)$/i;
 for(const sid of sessions)for(const area of ['sessions','phone-training'])must(!files(path.join(ROOT,area,sid)).some(p=>voice.test(p)),'Voice files remain: stop for a separate byte-verified deletion plan.');
 for(const [customer,profile,request,status] of targets){if(!request)continue;const member=owners[customer],file=safe(path.join(ROOT,'profile-deletion-requests',sha(member),sha(profile)+'.json')),r=read(file);
  must(r.schema_version==='PX-PROFILE-DELETION-REQUEST-1.0'&&r.owner_member_id===member&&r.customer_id===customer&&r.voice_profile_id===profile&&r.voice_model_id===profile.slice(8)&&r.request_id===request&&r.status===status,'Saved deletion request differs.');
  rows.push({relative:path.relative(ROOT,file),sha256:sha(fs.readFileSync(file)),kind:'DELETION_REQUEST',profile_id:profile,original_status:r.status});
 }
 return rows.sort((a,b)=>a.relative.localeCompare(b.relative));
}
function save(file,value){file=safe(file);fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});const t=file+'.'+crypto.randomUUID()+'.tmp';const fd=fs.openSync(t,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(t,file);}
const archive=safe(path.join(ROOT,'legacy-profile-retirements','reviewed-five-profile-reset-v1'));
const receipt=path.join(archive,'receipt.json');
function run(){
 if(fs.existsSync(receipt)&&read(receipt).phase==='ARCHIVED'){
  const r=read(receipt);must(r.files.every(x=>!fs.existsSync(safe(path.join(ROOT,x.relative)))),'An archived record reappeared.');console.log('Already archived. No additional changes.');return;
 }
 const apply=process.argv.includes('--apply'),rows=inventory();
 console.log(JSON.stringify({profiles:5,pending_requests:4,active_metadata_files:rows.length,remaining_managed_voice_files:0,plan_sha256:sha(JSON.stringify(rows))}));
 if(!apply){console.log('PREVIEW ONLY. Nothing changed.');return;}
 must(process.env.VOICE_CONSENT_APPROVED==='false','New capture must remain disabled.');
 must(!fs.existsSync(receipt),'An earlier reset receipt requires review.');
 const locks=[],hold=safe(path.join(ROOT,'profile-erasure-jobs/Maintenance.json')),nonce=crypto.randomUUID();let holding=false,state=null,failed=false;
 try{
  fs.mkdirSync(path.dirname(hold),{recursive:true,mode:0o700});fs.writeFileSync(hold,JSON.stringify({request_id:nonce,kind:'LEGACY_CATALOG_RETIREMENT'}),{flag:'wx',mode:0o600});holding=true;
  for(const member of Object.values(owners)){const dir=safe(path.join(ROOT,'voice-profile-records',sha(member),'.publish.lock'));fs.mkdirSync(dir);locks.push(dir);}
  must(JSON.stringify(inventory())===JSON.stringify(rows),'Inventory changed before the reset.');
  state={schema_version:'PX-LEGACY-ACTIVE-PROFILE-RESET-1.0',phase:'ARCHIVING',started_at:new Date().toISOString(),files:rows,moved:[],voice_files_deleted:0,customer_accounts_preserved:true,consent_records_preserved:true,original_deletion_outcomes_preserved:true,full_historical_erasure_verified:false};save(receipt,state);
  for(const row of rows){const from=safe(path.join(ROOT,row.relative)),to=safe(path.join(archive,'original-metadata',row.relative));must(sha(fs.readFileSync(from))===row.sha256,'Metadata changed before move.');fs.mkdirSync(path.dirname(to),{recursive:true,mode:0o700});fs.renameSync(from,to);state.moved.push(row.relative);save(receipt,state);must(sha(fs.readFileSync(to))===row.sha256&&!fs.existsSync(from),'Archive verification failed.');}
  state.phase='ARCHIVED';state.completed_at=new Date().toISOString();save(receipt,state);
  console.log('VERIFIED: five stale profiles and four requests removed from active stores.');console.log('Original metadata/evidence archive: '+archive);console.log('No voice files, customer accounts, consent manifests or project outputs were deleted.');
 }catch(error){
  try{if(state){for(const rel of [...state.moved].reverse()){const from=safe(path.join(archive,'original-metadata',rel)),to=safe(path.join(ROOT,rel));must(!fs.existsSync(to),'Rollback target already exists.');fs.renameSync(from,to);}state.phase='ROLLED_BACK';save(receipt,state);}}
  catch(rollback){failed=true;console.error('Rollback requires review. Maintenance remains in place.');}
  throw error;
 }finally{for(const lock of locks.reverse())fs.rmdirSync(lock);if(holding&&!failed){must(read(hold).request_id===nonce,'Maintenance owner changed.');fs.unlinkSync(hold);}}
}
try{run();}catch(error){console.error('STOP: '+error.message);process.exitCode=1;}
