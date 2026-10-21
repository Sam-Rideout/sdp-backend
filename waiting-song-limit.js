'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {validateRecord}=require('./song-selection-transfer');
const {readCancel}=require('./wix-cancel');
const MESSAGE='You already have a song waiting. Please wait for processing to free space before adding more orders.';
async function assertWaitingSpace(dataDir,owner){
 const dir=path.join(dataDir,'song-selections');let files=[];
 let snapshot;const hash=require('node:crypto').createHash('sha256').update(owner).digest('hex');
 try{snapshot=require('./wix-orders').validateSnapshot(JSON.parse(await fs.readFile(path.join(dataDir,'order-status',hash+'.json'),'utf8')));}catch(e){if(e.code!=='ENOENT')throw e;}
 if(snapshot&&snapshot.owner_member_id!==owner)throw new Error('Order snapshot ownership differs.');
 const ordered=new Set((snapshot?.orders||[]).map(o=>o.selection_id).filter(Boolean));
 try{files=await fs.readdir(dir,{withFileTypes:true});}catch(e){if(e.code!=='ENOENT')throw e;}
 const records=files.filter(f=>/^[a-f0-9]{64}\.json$/.test(f.name));
 if(records.length>5000)throw new Error('Song selection history needs review.');
 for(const f of records){
  if(!f.isFile())throw new Error('Invalid selection storage.');
  const file=path.join(dir,f.name);if((await fs.stat(file)).size>16384)throw new Error('Invalid selection storage.');
  const r=JSON.parse(await fs.readFile(file,'utf8'));validateRecord(r,f.name);
  if(r.owner_member_id!==owner||ordered.has(r.selection_id))continue;
  const cancelled=await readCancel(dataDir,owner,'SELECTION',r.selection_id);
  if(cancelled?.status==='CANCELLED')continue;
  let commit;
  try{commit=JSON.parse(await fs.readFile(path.join(dataDir,'song-commits',r.selection_id+'.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  if(commit){
   if(commit.owner_member_id!==owner||commit.selection_id!==r.selection_id)throw new Error('Saved request ownership differs.');
   continue; // The account processing gate separately owns committed requests.
  }
  const e=new Error(MESSAGE);e.status=409;e.code='WAITING_SONG_LIMIT';throw e;
 }
}
module.exports={assertWaitingSpace,MESSAGE};
