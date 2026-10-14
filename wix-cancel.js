'use strict';
const crypto=require('node:crypto');
const fs=require('node:fs/promises');
const path=require('node:path');
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const uuid=s=>typeof s==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(s);
const member=s=>typeof s==='string'&&s.length>=3&&s.length<=200&&s.trim()===s&&!/[\x00-\x1f\x7f]/.test(s);
const validTarget=(kind,id)=>kind==='ORDER'?/^PXO-\d{6}$/.test(id):kind==='SELECTION'&&uuid(id);
const key=(owner,kind,id)=>hash(JSON.stringify([owner,kind,id]));
async function readCancel(dataDir,owner,kind,id){
  try{
    const r=JSON.parse(await fs.readFile(path.join(dataDir,'song-cancellations',key(owner,kind,id)+'.json'),'utf8'));
    if(r.owner_member_id!==owner||r.kind!==kind||r.target_id!==id||r.command_id!==key(owner,kind,id)
      ||r.schema_version!=='PX-SONG-CANCELLATION-1.0'||!['REQUESTED','CANCELLED','TOO_LATE'].includes(r.status))throw new Error('Cancellation ownership mismatch.');
    return r;
  }catch(e){if(e.code==='ENOENT')return null;throw e;}
}
function publicCancellation(r){return r?{status:r.status,requested_at:r.requested_at,resolved_at:r.resolved_at||''}:null;}
async function selection(dataDir,owner,id){
  const {validateRecord}=require('./song-selection-transfer');
  let entries=[];try{entries=await fs.readdir(path.join(dataDir,'song-selections'));}catch(e){if(e.code!=='ENOENT')throw e;}
  if(entries.length>5000)throw new Error('Selection listing requires pagination.');
  for(const f of entries.filter(f=>/^[a-f0-9]{64}\.json$/.test(f))){
    const target=path.join(dataDir,'song-selections',f);
    if((await fs.stat(target)).size>16384)throw new Error('Oversized selection.');
    const r=JSON.parse(await fs.readFile(target,'utf8'));validateRecord(r,f);
    if(r.owner_member_id===owner&&r.selection_id===id)return r;
  }return null;
}
function attachWixCancellation(app,c){
  const root=path.join(c.dataDir,'song-cancellations');
  const locks=new Set();
  app.post('/api/wix/cancel-song',async(req,res,next)=>{
    res.set('Cache-Control','no-store');
    let lock;
    try{
      const claims=c.verifySigned(req.body&&req.body.ticket),now=Math.floor(Date.now()/1000);
      if(!claims||claims.iss!=='wix'||claims.aud!=='project-x-orders'||claims.purpose!=='cancel-song'
        ||!member(claims.sub)||!validTarget(claims.kind,claims.target_id)||!Number.isInteger(claims.iat)
        ||!Number.isInteger(claims.exp)||claims.iat>now+60||claims.iat<now-180||claims.exp<=now
        ||claims.exp>now+180||claims.exp<=claims.iat||!(/^[a-f0-9]{48}$/).test(claims.jti||''))return res.status(401).json({error:'Cancellation authorization failed.'});
      if(!await c.consumeTicket(claims.jti))return res.status(401).json({error:'Authorization already used.'});
      const id=key(claims.sub,claims.kind,claims.target_id);
      if(locks.has(id))return res.status(409).json({error:'Cancellation is being recorded.'});
      locks.add(id);lock=id;
      const existing=await readCancel(c.dataDir,claims.sub,claims.kind,claims.target_id);
      if(existing)return res.json({ok:true,cancellation:publicCancellation(existing)});
      let owned=false;
      if(claims.kind==='SELECTION')owned=Boolean(await selection(c.dataDir,claims.sub,claims.target_id));
      else{
        let snapshot;try{snapshot=JSON.parse(await fs.readFile(path.join(c.dataDir,'order-status',hash(claims.sub)+'.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
        if(snapshot&&snapshot.owner_member_id===claims.sub){
          const o=snapshot.orders.find(o=>o.order_id===claims.target_id);
          owned=Boolean(o);
          if(o&&['COMPLETED','REFUNDED','PAYMENT_FAILED'].includes(o.order_status))return res.status(409).json({error:'This order cannot be cancelled.'});
        }
      }
      if(!owned)return res.status(404).json({error:'Song request not found.'});
      const r={schema_version:'PX-SONG-CANCELLATION-1.0',command_id:id,owner_member_id:claims.sub,
        kind:claims.kind,target_id:claims.target_id,status:'REQUESTED',requested_at:new Date().toISOString()};
      await fs.mkdir(root,{recursive:true,mode:0o700});
      await fs.writeFile(path.join(root,id+'.json'),JSON.stringify(r),{flag:'wx',mode:0o600});
      res.json({ok:true,cancellation:publicCancellation(r)});
    }catch(e){next(e);}finally{if(lock)locks.delete(lock);}
  });
  app.get('/api/transfer/song-cancellations',c.transferAuth,async(req,res,next)=>{
    res.set('Cache-Control','no-store');
    try{
      let files=[];try{files=await fs.readdir(root);}catch(e){if(e.code!=='ENOENT')throw e;}
      files=files.filter(f=>/^[a-f0-9]{64}\.json$/.test(f));
      if(files.length>5000)throw new Error('Cancellation listing requires pagination.');
      const commands=[];
      for(const f of files){const r=JSON.parse(await fs.readFile(path.join(root,f),'utf8'));
        const checked=await readCancel(c.dataDir,r.owner_member_id,r.kind,r.target_id);
        if(checked.status==='REQUESTED')commands.push(checked);}
      commands.sort((a,b)=>a.requested_at.localeCompare(b.requested_at));
      res.json({ok:true,commands:commands.slice(0,100),truncated:commands.length>100});
    }catch(e){next(e);}
  });
  app.post('/api/transfer/song-cancellations/receipt',c.transferAuth,async(req,res,next)=>{
    try{
      const b=req.body;
      if(!b||!member(b.owner_member_id)||!validTarget(b.kind,b.target_id)||!['CANCELLED','TOO_LATE'].includes(b.status))return res.status(400).json({error:'Invalid receipt.'});
      const r=await readCancel(c.dataDir,b.owner_member_id,b.kind,b.target_id);
      if(!r||r.command_id!==b.command_id)return res.status(404).json({error:'Cancellation not found.'});
      if(r.status!=='REQUESTED'){if(r.status!==b.status)return res.status(409).json({error:'Receipt conflict.'});return res.json({ok:true});}
      const target=path.join(root,r.command_id+'.json'),temp=target+'.'+crypto.randomUUID()+'.tmp';
      try{await fs.writeFile(temp,JSON.stringify({...r,status:b.status,resolved_at:new Date().toISOString()}),{flag:'wx',mode:0o600});await fs.rename(temp,target);}finally{await fs.unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
      res.json({ok:true});
    }catch(e){next(e);}
  });
}
module.exports={attachWixCancellation,readCancel,publicCancellation};
