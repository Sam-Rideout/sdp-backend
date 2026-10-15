'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { validateRecord } = require('./song-selection-transfer');
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const memberId = s => typeof s === 'string' && s.length >= 3 && s.length <= 200 && s.trim() === s && !/[\x00-\x1f\x7f]/.test(s);
const text = (s, max) => typeof s === 'string' && s.length <= max && !/[\x00-\x1f\x7f]/.test(s);
const uuid = s => typeof s === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(s);
const date = s => typeof s === 'string' && Number.isFinite(Date.parse(s));
const STATUSES = new Set(['READY','QUEUED','PROCESSING','COMPLETED','REJECTED','TECHNICAL_FAILURE','CANCELLED','REFUNDED','PAYMENT_FAILED']);
function authorized(c, now) {
  return Boolean(c && c.iss === 'wix' && c.aud === 'project-x-orders' && c.purpose === 'my-orders'
    && memberId(c.sub) && Number.isInteger(c.iat) && Number.isInteger(c.exp)
    && c.iat <= now + 60 && c.iat >= now - 180 && c.exp > now && c.exp <= now + 180
    && c.exp > c.iat && typeof c.jti === 'string' && /^[a-f0-9]{48}$/.test(c.jti));
}
function validateSnapshot(body) {
  if (!body || body.schema_version !== 'PX-WIX-ORDER-SNAPSHOT-1.0' || !memberId(body.owner_member_id)
    || !date(body.captured_at) || Date.parse(body.captured_at) > Date.now() + 300000
    || typeof body.truncated !== 'boolean' || !Array.isArray(body.orders) || body.orders.length > 100) {
    throw new Error('Invalid order snapshot.');
  }
  const seen = new Set();
  const orders = body.orders.map(o => {
    if (!o || !/^PXO-\d{6}$/.test(o.order_id) || seen.has(o.order_id)
      || !STATUSES.has(o.order_status) || !text(o.song_name, 200)
      || !(o.px_song_id === '' || /^PX\d{6}$/.test(o.px_song_id))
      || !date(o.created_at) || !date(o.updated_at) || typeof o.test_order !== 'boolean'
      || !(o.selection_id === '' || uuid(o.selection_id))
      || !['','CREATED','READY','PENDING','QUEUED','SENT','FAILED'].includes(o.delivery_status)
      || !(o.sent_at === '' || date(o.sent_at))) throw new Error('Invalid order record.');
    const processing_started_at = o.processing_started_at ?? '';
    const processing_finished_at = o.processing_finished_at ?? '';
    const processing_status = o.processing_status ?? '';
    if (!(processing_started_at === '' || date(processing_started_at))
      || !(processing_finished_at === '' || date(processing_finished_at))
      || !['','QUEUED','PROCESSING','COMPLETED','REJECTED','TECHNICAL_FAILURE','CANCELLED'].includes(processing_status)
      || (processing_started_at && processing_finished_at && Date.parse(processing_finished_at) < Date.parse(processing_started_at))) {
      throw new Error('Invalid processing clock.');
    }
    o = {...o, processing_started_at, processing_finished_at, processing_status};
    seen.add(o.order_id);
    // Explicit public whitelist: never persist model assets, email, logs or local paths.
    return Object.fromEntries(['order_id','order_status','song_name','px_song_id','created_at',
      'updated_at','test_order','selection_id','delivery_status','sent_at',
      'processing_started_at','processing_finished_at','processing_status'].map(k => [k,o[k]]));
  });
  return {schema_version:body.schema_version, owner_member_id:body.owner_member_id,
    captured_at:body.captured_at, truncated:body.truncated, orders};
}
function displayOrder(o) {
  const messages = {
    READY:['Ready for processing','Your song request is ready for processing.'],
    QUEUED:['Waiting to process','Your song request is waiting to be processed.'],
    PROCESSING:['Creating your song','Your song is being processed. You can return here to check its progress.'],
    COMPLETED:['Processing complete','Song processing is complete.'],
    REJECTED:['Song could not be completed','This song could not be completed. Please try another song. No additional voice recordings have been requested.'],
    TECHNICAL_FAILURE:['Technical issue','A technical issue prevented completion. No action or additional recordings are requested from you at this time.'],
    CANCELLED:['Cancelled','This processing request was cancelled.'],
    REFUNDED:['Refunded','This order is recorded as refunded.'],
    PAYMENT_FAILED:['Payment needs attention','The order system recorded a payment problem. Contact Project X before trying another payment.'],
  };
  const [status_label,message] = messages[o.order_status];
  return {...o, id:o.order_id, kind:'ORDER', status_label, message,
    delivery_label:o.delivery_status === 'SENT' ? 'Song emailed' : o.delivery_status === 'FAILED' ? 'Email delivery issue' : 'No email delivery recorded',
    recovery_action:null};
}
function attachWixOrders(app, context) {
  const root = path.join(context.dataDir,'order-status');
  const locks = new Set();
  app.post('/api/transfer/order-status', context.transferAuth, async (req,res,next) => {
    let target;
    let acquired=false;
    try {
      let snapshot;
      try { snapshot = validateSnapshot(req.body); }
      catch { return res.status(400).json({error:'Invalid order snapshot.'}); }
      target = path.join(root,hash(snapshot.owner_member_id)+'.json');
      if (locks.has(target)) return res.status(409).json({error:'Order status update in progress.'});
      locks.add(target);
      acquired=true;
      let previous;
      try { previous=JSON.parse(await fs.readFile(target,'utf8')); }
      catch(e) { if(e.code!=='ENOENT')throw e; }
      if(previous && Date.parse(previous.captured_at)>Date.parse(snapshot.captured_at)) {
        return res.status(409).json({error:'An older order snapshot cannot replace a newer one.'});
      }
      if(previous && Date.parse(previous.captured_at)===Date.parse(snapshot.captured_at)
        && JSON.stringify(previous)!==JSON.stringify(snapshot)) return res.status(409).json({error:'Order snapshot timestamp conflict.'});
      await fs.mkdir(root,{recursive:true,mode:0o700});
      const temporary=target+'.'+crypto.randomUUID()+'.tmp';
      try { await fs.writeFile(temporary,JSON.stringify(snapshot),{flag:'wx',mode:0o600}); await fs.rename(temporary,target); }
      finally { await fs.unlink(temporary).catch(e=>{if(e.code!=='ENOENT')throw e;}); }
      res.json({ok:true,order_count:snapshot.orders.length,captured_at:snapshot.captured_at});
    }catch(e){next(e);}finally{if(acquired)locks.delete(target);}
  });
  app.post('/api/wix/my-orders',async(req,res,next)=>{
    res.set('Cache-Control','no-store');
    try {
      const claims=context.verifySigned(req.body && req.body.ticket);
      if(!authorized(claims,Math.floor(Date.now()/1000))) return res.status(401).json({error:'Order authorization failed.'});
      if(!(await context.consumeTicket(claims.jti))) return res.status(401).json({error:'Order authorization was already used.'});
      await context.pruneOldReplayMarkers();
      let snapshot=null;
      try { snapshot=validateSnapshot(JSON.parse(await fs.readFile(path.join(root,hash(claims.sub)+'.json'),'utf8'))); }
      catch(e){if(e.code!=='ENOENT')throw e;}
      if(snapshot && snapshot.owner_member_id!==claims.sub)throw new Error('Stored order ownership mismatch.');
      const orders=(snapshot?snapshot.orders:[]).map(displayOrder);
      const {readCancel,publicCancellation}=require('./wix-cancel');
      for(const o of orders){
        const direct=await readCancel(context.dataDir,claims.sub,'ORDER',o.order_id);
        const linked=o.selection_id?await readCancel(context.dataDir,claims.sub,'SELECTION',o.selection_id):null;
        o.cancellation=publicCancellation(direct||linked);
      }
      const selectionIds=new Set(orders.map(o=>o.selection_id).filter(Boolean));
      const selectionsRoot=path.join(context.dataDir,'song-selections');
      let entries=[];
      try{entries=await fs.readdir(selectionsRoot,{withFileTypes:true});}catch(e){if(e.code!=='ENOENT')throw e;}
      const files=entries.filter(e=>/^[a-f0-9]{64}\.json$/.test(e.name));
      if(files.length>5000)throw new Error('Selection listing requires pagination.');
      const selections=[];
      for(const e of files){
        if(!e.isFile())throw new Error('Selection is not a regular file.');
        const file=path.join(selectionsRoot,e.name);
        if((await fs.stat(file)).size>16384)throw new Error('Selection record is oversized.');
        const record=JSON.parse(await fs.readFile(file,'utf8'));validateRecord(record,e.name);
        if(record.owner_member_id===claims.sub && !selectionIds.has(record.selection_id))selections.push({
          id:record.selection_id,kind:'SELECTION',order_id:'',px_song_id:record.px_song_id,song_name:record.px_song_id,
          status_label:'Song selected',message:'Your selection has been saved. Order processing has not yet been confirmed here.',
          created_at:record.selected_at,updated_at:record.selected_at,test_order:false,delivery_label:'',recovery_action:null
        });
      }
      for(const s of selections)s.cancellation=publicCancellation(await readCancel(context.dataDir,claims.sub,'SELECTION',s.id));
      const all=[...orders,...selections];
      for(const item of all){
        item.can_cancel=item.kind==='SELECTION'||['READY','QUEUED','PROCESSING','REJECTED','TECHNICAL_FAILURE'].includes(item.order_status);
        if(item.cancellation){
          item.can_cancel=false;
          if(item.cancellation.status==='REQUESTED'){item.status_label='Cancellation requested';item.message='Your cancellation request has been saved. Waiting for the processing system to confirm the outcome.';}
          if(item.cancellation.status==='CANCELLED'){item.status_label='Cancelled';item.message='This song request has been withdrawn. Your voice profile has not been deleted.';}
          if(item.cancellation.status==='TOO_LATE')item.message+=' The cancellation arrived after the request had finished.';
        }
        item.can_choose_another=item.cancellation&&item.cancellation.status==='REQUESTED'?false:Boolean(item.cancellation&&['CANCELLED','TOO_LATE'].includes(item.cancellation.status))||['CANCELLED','REFUNDED','COMPLETED'].includes(item.order_status);
      }
      for(const item of all){
        const sid=item.kind==='SELECTION'?item.id:item.selection_id;
        item.birthday_message=sid&&context.messageSummary?await context.messageSummary(claims.sub,sid):null;
        item.can_add_message=item.kind==='SELECTION'&&!item.cancellation&&item.birthday_message?.can_record===true;
        item.creation=sid&&context.creationSummary?await context.creationSummary(claims.sub,sid):null;
        item.can_create_song=item.kind==='SELECTION'&&!item.cancellation&&!item.creation&&(item.birthday_message?.can_record===true||item.birthday_message?.committed===true)&&['RECORDED','SKIPPED'].includes(item.birthday_message?.choice);
        if(item.creation && item.kind==='SELECTION'&&!item.cancellation){
          item.can_add_message=false;
          item.status_label=item.creation.state==='NEEDS_ATTENTION'?'Project X review needed':item.creation.state==='REQUESTED'?'Waiting for processing':'Preparing your order';
          item.message=item.creation.state==='NEEDS_ATTENTION'?'Your song request needs Project X review. Please do not create a duplicate request.':'Your song and message choices are committed. Processing will begin when the service is available.';
        }
      }
      const items=all.sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at)||a.id.localeCompare(b.id));
      res.json({ok:true,items:items.slice(0,100),truncated:items.length>100||Boolean(snapshot&&snapshot.truncated),
        synced_at:snapshot?snapshot.captured_at:null,checked_at:new Date().toISOString()});
    }catch(e){next(e);}
  });
}
module.exports={attachWixOrders,authorized,validateSnapshot,displayOrder};
