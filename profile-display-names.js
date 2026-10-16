'use strict';
// Display metadata only; profile IDs remain the selection/authorization identity.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const hash = v => crypto.createHash('sha256').update(v).digest('hex');
const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function sourceLabel(record, manifest) {
  // validateExisting has already verified this explicitly bound PC profile.
  if (record.profile_origin === 'EXISTING_OWNER_TEST') return 'PC';
  if (manifest.training_source === 'SUPPLIED_RECORDING') return 'Uploaded audio';
  const context = manifest.phone_training?.test_context;
  if (context?.requested_device === 'BROWSER') {
    const agent = String(context.browser_user_agent || '');
    if (/iPhone|Android.*Mobile/i.test(agent)) return 'Phone';
    // Ambiguous tablet and unknown browser identifiers use the generic label.
    if (!/iPad|Tablet|Android/i.test(agent) && /Windows NT|X11.*Linux x86_64/i.test(agent)) return 'PC';
  }
  return 'Recording';
}
function dateLabel(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value)) return 'Date unknown';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Date unknown';
  return `${String(date.getUTCDate()).padStart(2,'0')} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}
function createDisplayNames(dataDir) {
  const root = path.join(dataDir, 'voice-profile-display-names');
  async function decorate(member, rows) {
    if (!rows.some(x => x.record.voice_profile_id)) return rows.map(() => null);
    const owner = hash(member), filename = path.join(root, owner + '.json');
    const lock = path.join(root, owner + '.lock');
    await fs.mkdir(root, {recursive:true, mode:0o700});
    let acquired = false;
    for (let attempt=0; attempt<100; attempt++) {
      try { await fs.mkdir(lock); acquired=true; break; }
      catch(e) { if(e.code!=='EEXIST') throw e; await new Promise(r=>setTimeout(r,10)); }
    }
    if (!acquired) { const e=new Error('Profile display naming is busy. Retry shortly.');e.status=409;throw e; }
    try {
      let ledger;
      try {
        const info=await fs.lstat(filename);
        if (!info.isFile() || info.isSymbolicLink() || info.size>2*1024*1024) throw new Error('Invalid profile naming metadata.');
        ledger=JSON.parse(await fs.readFile(filename,'utf8'));
      } catch(e) { if(e.code!=='ENOENT') throw e; ledger={schema_version:1,owner_sha256:owner,next_sequence:1,profiles:{}}; }
      const labels = new Set(['Phone','PC','Recording','Uploaded audio']);
      if (ledger.schema_version!==1 || ledger.owner_sha256!==owner || !Number.isSafeInteger(ledger.next_sequence)
        || ledger.next_sequence<1 || !ledger.profiles || Array.isArray(ledger.profiles) || typeof ledger.profiles!=='object') throw new Error('Invalid profile naming ledger.');
      const used = new Set();
      for (const [key,item] of Object.entries(ledger.profiles)) {
        if (!/^[a-f0-9]{64}$/.test(key) || !Number.isSafeInteger(item.sequence) || item.sequence<1
          || item.sequence>=ledger.next_sequence || used.has(item.sequence) || !labels.has(item.source)
          || typeof item.date!=='string' || !/^(Date unknown|\d{2} [A-Z][a-z]{2} \d{4})$/.test(item.date)) throw new Error('Invalid profile naming assignment.');
        used.add(item.sequence);
      }
      // All states participate before UI filtering; assignments survive deletion.
      const sorted=rows.filter(x=>x.record.voice_profile_id).slice().sort((a,b)=>{
        const time = x => {const n=Date.parse(x.record.created_at || x.manifest.created_at);return Number.isFinite(n)?n:Infinity;};
        const delta=time(a)-time(b);
        return (Number.isNaN(delta)?0:delta) || a.record.voice_profile_id.localeCompare(b.record.voice_profile_id);
      });
      let changed=false;
      for (const {record,manifest} of sorted) {
        const key=hash(record.voice_profile_id);
        if (!Object.hasOwn(ledger.profiles,key)) {
          if (Object.keys(ledger.profiles).length>=10000 || ledger.next_sequence>=Number.MAX_SAFE_INTEGER) throw new Error('Profile naming metadata requires maintenance.');
          ledger.profiles[key]={sequence:ledger.next_sequence++,source:sourceLabel(record,manifest),date:dateLabel(record.created_at || manifest.created_at)};
          changed=true;
        }
      }
      if(changed) {
        const tmp=filename+'.'+crypto.randomUUID()+'.tmp';
        try {
          const handle=await fs.open(tmp,'wx',0o600);
          try {await handle.writeFile(JSON.stringify(ledger,null,2)+'\n');await handle.sync();} finally {await handle.close();}
          await fs.rename(tmp,filename);
        } finally {await fs.unlink(tmp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
      }
      return rows.map(({record})=>{
        if(!record.voice_profile_id)return null;
        const item=ledger.profiles[hash(record.voice_profile_id)];
        return {label:`${item.source} · ${item.date} · ${String(item.sequence).padStart(2,'0')}`,sequence:item.sequence};
      });
    } finally {await fs.rmdir(lock);}
  }
  return {decorate};
}
module.exports={createDisplayNames,sourceLabel,dateLabel};
