'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');

const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const validEmail=value=>typeof value==='string'&&value.length<=254&&/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value);
const validId=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const now=()=>new Date().toISOString();

function pdfEscape(value){
  return String(value??'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^\x20-\x7e]/g,'?')
    .replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)');
}
function textLines(value,width){
  const words=pdfEscape(value).split(/\s+/);const out=[];let line='';
  for(const word of words){const next=line?line+' '+word:word;if(next.length>width&&line){out.push(line);line=word;}else line=next;}
  if(line)out.push(line);return out;
}
function makePdf(ownerEmail,records,batchNumber,createdAt){
  const lines=[
    'SDP PROJECT X - PURCHASE HISTORY',
    `Song purchases ${((batchNumber-1)*100)+1}-${batchNumber*100}`,
    `Prepared ${new Date(createdAt).toLocaleDateString('en-CA',{timeZone:'UTC'})}`,
    `Account: ${ownerEmail}`,
    'Completed song purchases (including songs redeemed with credits).',
    'Test, refunded and free promotional songs are excluded.',
    ''
  ];
  records.forEach((record,index)=>{
    const amount=(record.amount_minor/100).toFixed(2);
    const paid=record.kind==='CREDIT_REDEMPTION'?'Credit used':`CAD $${amount}`;
    const title=record.title||'Project X song';
    const head=`${index+1}. ${record.purchased_at.slice(0,10)} | ${paid} | ${record.order_id||record.source_key}`;
    lines.push(...textLines(head,92));
    lines.push(...textLines(`   ${title}`,92));
  });
  const pageLines=48,pages=[];
  for(let i=0;i<lines.length;i+=pageLines)pages.push(lines.slice(i,i+pageLines));
  const objects=[];
  const add=body=>{objects.push(Buffer.isBuffer(body)?body:Buffer.from(body,'latin1'));return objects.length;};
  const catalog=add('');const pagesObj=add('');const font=add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const pageIds=[];
  for(const pageLinesNow of pages){
    let stream='BT\n/F1 9 Tf\n48 750 Td\n12 TL\n';
    pageLinesNow.forEach(line=>{stream+=`(${pdfEscape(line)}) Tj\nT*\n`;});
    stream+='ET\n';
    const content=add(Buffer.from(`<< /Length ${Buffer.byteLength(stream,'latin1')} >>\nstream\n${stream}endstream`,'latin1'));
    const page=add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`);
    pageIds.push(page);
  }
  objects[catalog-1]=Buffer.from(`<< /Type /Catalog /Pages ${pagesObj} 0 R >>`,'latin1');
  objects[pagesObj-1]=Buffer.from(`<< /Type /Pages /Kids [${pageIds.map(id=>`${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`,'latin1');
  let output=Buffer.from('%PDF-1.4\n%PXARCHIVE\n','latin1');const offsets=[0];
  objects.forEach((object,index)=>{offsets.push(output.length);output=Buffer.concat([output,Buffer.from(`${index+1} 0 obj\n`,'latin1'),object,Buffer.from('\nendobj\n','latin1')]);});
  const xref=output.length;let table=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;
  for(const offset of offsets.slice(1))table+=`${String(offset).padStart(10,'0')} 00000 n \n`;
  output=Buffer.concat([output,Buffer.from(`${table}trailer\n<< /Size ${objects.length+1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`,'latin1')]);
  return output;
}
async function atomicJson(file,value){
  await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});
  const tmp=file+'.'+crypto.randomUUID()+'.tmp';
  try{await fs.writeFile(tmp,JSON.stringify(value),{flag:'wx',mode:0o600});await fs.rename(tmp,file);}
  finally{await fs.unlink(tmp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}
async function readJson(file){try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
function completedSongs(result){
  const rows=result?.sales;
  if(!Array.isArray(rows)||rows.length>5000||!Array.isArray(result?.issues)||result.issues.length)
    throw new Error('Purchase history is incomplete.');
  const eligible=rows.filter(r=>r&&['SINGLE_SONG','CREDIT_REDEMPTION'].includes(r.kind)
      &&r.fulfilled===true&&r.payment_status==='PAID'&&r.test_order!==true);
  for(const r of eligible){
    if(typeof r.owner!=='string'||typeof r.source_key!=='string'||!validId(r.source_hash)
      ||typeof r.title!=='string'||r.title.length>200||!Number.isFinite(Date.parse(r.purchased_at))
      ||!Number.isSafeInteger(r.amount_minor)||r.amount_minor<0||!validEmail(r.email))
      throw new Error('A completed purchase record needs review.');
  }
  return eligible
    .sort((a,b)=>Date.parse(a.purchased_at)-Date.parse(b.purchased_at)||a.source_key.localeCompare(b.source_key));
}
function createPurchaseHistoryArchive(dataDir,commerceStore){
  const root=path.join(dataDir,'purchase-history-archive');const locks=new Set();
  const ownerFile=owner=>path.join(root,hash(owner)+'.json');
  async function withHashedLock(key,action){
    if(locks.has(key))return null;locks.add(key);
    const lockFile=path.join(root,key+'.lock');let acquired=false;
    try{await fs.mkdir(root,{recursive:true,mode:0o700});try{await fs.mkdir(lockFile);acquired=true;}catch(e){if(e.code==='EEXIST')return null;throw e;}return await action();}
    finally{if(acquired)await fs.rmdir(lockFile).catch(()=>{});locks.delete(key);}
  }
  const withOwnerLock=(owner,action)=>withHashedLock(hash(owner),action);
  async function refreshOwner(owner,allSales){
    return withOwnerLock(owner,async()=>{
      const sales=completedSongs(allSales).filter(r=>r.owner===owner);
      const file=ownerFile(owner);const prior=await readJson(file)||{schema_version:'PX-PURCHASE-ARCHIVE-1.0',owner_hash:hash(owner),batches:[]};
      if(prior.schema_version!=='PX-PURCHASE-ARCHIVE-1.0'||prior.owner_hash!==hash(owner)||!Array.isArray(prior.batches))throw new Error('Purchase archive needs review.');
      const used=new Set(prior.batches.flatMap(b=>Array.isArray(b.source_hashes)?b.source_hashes:[]));
      const candidates=sales.filter(s=>!used.has(s.source_hash));
      let nextBatch=prior.batches.reduce((n,b)=>Math.max(n,Number(b.batch_number)||0),0)+1;
      const created=[];
      for(let offset=0;offset+100<=candidates.length;offset+=100){
        const batch=candidates.slice(offset,offset+100);const email=batch.at(-1).email;
        if(batch.some(r=>r.owner!==owner||!validEmail(r.email)))throw new Error('Purchase archive recipient needs review.');
        const id=hash(JSON.stringify([owner,batch.map(x=>x.source_hash)]));
        const existing=prior.batches.find(b=>b.archive_id===id);if(existing)continue;
        const createdAt=now(),pdf=makePdf(email,batch,nextBatch,createdAt);
        const pdfFile=path.join(root,id+'.pdf');
        try{await fs.access(pdfFile);}catch(e){if(e.code!=='ENOENT')throw e;const temp=pdfFile+'.'+crypto.randomUUID()+'.tmp';try{await fs.writeFile(temp,pdf,{flag:'wx',mode:0o600});await fs.rename(temp,pdfFile);}finally{await fs.unlink(temp).catch(x=>{if(x.code!=='ENOENT')throw x;});}}
        const archive={archive_id:id,batch_number:nextBatch,owner_hash:hash(owner),recipient:email,
          created_at:createdAt,status:'PENDING',claim_id:'',claimed_at:'',sent_at:'',attempts:0,
          pdf_file:id+'.pdf',pdf_sha256:hash(pdf),source_hashes:batch.map(x=>x.source_hash),sales:batch};
        prior.batches.push(archive);created.push(id);nextBatch++;
      }
      if(created.length)await atomicJson(file,prior);
      return {completed_song_count:sales.length,archives_created:created};
    });
  }
  async function refreshAll(){const result=await commerceStore.salesRecords();const owners=[...new Set(completedSongs(result).map(s=>s.owner))];const summaries=[];for(const owner of owners)summaries.push(await refreshOwner(owner,result));return summaries;}
  async function claimPending(limit=5){
    let files=[];try{files=await fs.readdir(root);}catch(e){if(e.code==='ENOENT')return [];throw e;}
    const results=[];const nowMs=Date.now();
    for(const name of files.filter(n=>/^[a-f0-9]{64}\.json$/.test(n)).slice(0,2000)){
      if(results.length>=limit)break;const file=path.join(root,name);const state=await readJson(file);if(!state||!Array.isArray(state.batches))continue;
      const claimed=await withHashedLock(name.slice(0,64),async()=>{
        const latest=await readJson(file);if(!latest||!Array.isArray(latest.batches))return [];
        const jobs=[];
        for(const batch of latest.batches){
          if(jobs.length>=limit-results.length)break;
          const claimedAt=Date.parse(batch.claimed_at||'');
          const stale=batch.status==='SENDING'&&Number.isFinite(claimedAt)&&nowMs-claimedAt>15*60*1000;
          if(batch.status!=='PENDING'&&!stale)continue;
          const claimId=crypto.randomBytes(24).toString('hex');batch.status='SENDING';batch.claim_id=claimId;batch.claimed_at=now();batch.attempts=(batch.attempts||0)+1;
          const pdfPath=path.join(root,batch.pdf_file);const pdf=await fs.readFile(pdfPath);
          if(hash(pdf)!==batch.pdf_sha256)throw new Error('Archived PDF integrity check failed.');
          jobs.push({archive_id:batch.archive_id,claim_id:claimId,to:batch.recipient,filename:`Project-X-Purchases-${batch.batch_number}.pdf`,pdf_base64:pdf.toString('base64')});
        }
        if(jobs.length)await atomicJson(file,latest);
        return jobs;
      });
      results.push(...(claimed||[]));
    }
    return results;
  }
  async function acknowledge(body){
    const {archive_id,claim_id,sent}=body||{};if(!validId(archive_id)||typeof claim_id!=='string'||!/^[a-f0-9]{48}$/.test(claim_id)||typeof sent!=='boolean')throw new Error('Invalid purchase archive acknowledgement.');
    let files=[];try{files=await fs.readdir(root);}catch(e){if(e.code==='ENOENT')throw new Error('Purchase archive not found.');throw e;}
    for(const name of files.filter(n=>/^[a-f0-9]{64}\.json$/.test(n))){const file=path.join(root,name);
      const outcome=await withHashedLock(name.slice(0,64),async()=>{const state=await readJson(file);const batch=state?.batches?.find(x=>x.archive_id===archive_id);if(!batch)return null;
        if(batch.status==='SENT'&&sent)return {ok:true,already_sent:true};
        if(batch.status!=='SENDING'||batch.claim_id!==claim_id)throw new Error('Purchase archive claim changed.');
        batch.status=sent?'SENT':'PENDING';batch.sent_at=sent?now():'';batch.claim_id='';batch.claimed_at='';
        await atomicJson(file,state);return {ok:true,status:batch.status};
      });
      if(outcome)return outcome;
    }
    throw new Error('Purchase archive not found.');
  }
  return {refreshOwner,refreshAll,claimPending,acknowledge};
}
function attachPurchaseHistoryArchive(app,context){
  const archive=context.archive;
  app.post('/api/transfer/purchase-history-archive/work',context.transferAuth,async(req,res,next)=>{try{
    const jobs=await archive.claimPending(5);res.json({ok:true,jobs});
  }catch(e){next(e);}});
  app.post('/api/transfer/purchase-history-archive/ack',context.transferAuth,async(req,res,next)=>{try{
    const result=await archive.acknowledge(req.body||{});res.json(result);
  }catch(e){next(e);}});
}
module.exports={createPurchaseHistoryArchive,attachPurchaseHistoryArchive,completedSongs,makePdf};
