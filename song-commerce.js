'use strict';
// Durable commerce state. This module never renders clean audio or sends email.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const PRICES = Object.freeze({VOICE_CLONE:2399, ORIGINAL_MESSAGE:1399, ORIGINAL_ONLY:899});
const PLANS = Object.freeze({THREE:{credits:3,amount_minor:4399}, EIGHT:{credits:8,amount_minor:6499}});
const digest = x => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const stamp = () => new Date().toISOString();
function demand(ok, message, status=409) {if(!ok) {const e=new Error(message);e.status=status;throw e;}}
function id(x) {return typeof x==='string' && /^[a-zA-Z0-9_-]{3,200}$/.test(x);}
function uuid(x) {return typeof x==='string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(x);}
function sha(x) {return typeof x==='string' && /^[a-f0-9]{64}$/.test(x);}
function minor(x) {
  demand(typeof x==='number'||typeof x==='string','Invalid amount.');
  const s=String(x); demand(/^\d{1,7}(\.\d{1,2})?$/.test(s),'Invalid currency precision.');
  const [whole,fraction='']=s.split('.');return Number(whole)*100+Number(fraction.padEnd(2,'0'));
}
function initial() {return {schema:'PX-SONG-COMMERCE-1.0',revision:0,reviews:{},grants:{},intents:{},payments:{},events:{},holds:{}};}
function balance(s,owner) {
  return Object.values(s.grants).filter(g=>g.owner===owner).reduce((a,g)=>a+g.credits,0)
    -Object.values(s.reviews).filter(r=>r.owner===owner && r.authorization?.kind==='CREDIT').length;
}
function owned(s,owner,key) {const r=s.reviews[key];demand(r&&r.owner===owner,'Song review not found.',404);return r;}
function available(s,owner) {demand(!s.holds[owner],'Payment requires operator review.');}
function publicReview(s,r) {
  return {review_id:r.review_id,selection_id:r.selection_id,order_id:r.order_id,run_id:r.run_id,
    product:r.product,title:r.title,state:r.state,preview_sha256:r.preview_sha256,
    duration:r.duration,watermarks:r.watermarks,price_minor:PRICES[r.product],currency:'CAD',
    tax_included:true,credits:balance(s,r.owner),approved_at:r.approved_at||'',
    authorized:!!r.authorization,payment_review_required:!!s.holds[r.owner],delivered_at:r.delivered_at||''};
}
function authorize(r,kind,reference,creditBalanceAfter) {
  demand(!r.authorization,'Delivery already authorized.');
  r.authorization={kind,reference,approved_preview_sha256:r.preview_sha256,
    master_sha256:r.master_sha256,at:stamp()};
  if(kind==='CREDIT') {
    demand(Number.isSafeInteger(creditBalanceAfter)&&creditBalanceAfter>=0,'Invalid recorded credit balance.');
    r.authorization.credits_remaining_after_redemption=creditBalanceAfter;
  }
  r.authorization.seal=digest({review_id:r.review_id,order_id:r.order_id,run_id:r.run_id,...r.authorization});
  r.state='AUTHORIZED';
}
function applyPayment(s,paymentId) {
  const p=s.payments[paymentId];if(!p?.intent_id||!p.success)return;
  const intent=s.intents[p.intent_id],r=s.reviews[intent.review_id];
  demand(intent && r,'Payment intent is missing.');
  demand(p.success.currency==='CAD'&&p.success.amount_minor===intent.amount_minor,'Payment amount/currency differs.');
  if(p.refunded) {s.holds[r.owner]='Refunded payment '+paymentId;return;}
  if(r.authorization) {
    demand(r.authorization.kind==='PAYMENT'&&r.authorization.reference===paymentId,'Conflicting delivery authorization.');return;
  }
  demand(r.state==='PAYMENT_PENDING'&&r.approved_at&&r.preview_sha256===intent.preview_sha256,'Payment approval changed.');
  authorize(r,'PAYMENT',paymentId);intent.state='SUCCESSFUL';
}
function createStore(directory, config={}) {
  const stateFile=path.join(directory,'State.json'),lock=path.join(directory,'Write.lock');
  async function transaction(fn) {
    await fs.mkdir(directory,{recursive:true,mode:0o700});
    try {await fs.mkdir(lock);} catch(e) {if(e.code==='EEXIST') demand(false,'Another commerce update is running. Retry shortly.',503);throw e;}
    try {
      let s;try{s=JSON.parse(await fs.readFile(stateFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;s=initial();}
      demand(s.schema==='PX-SONG-COMMERCE-1.0'&&Number.isSafeInteger(s.revision),'Commerce state requires review.',503);
      const result=await fn(s);s.revision++;
      const temp=stateFile+'.'+crypto.randomUUID()+'.tmp';
      try {
        const h=await fs.open(temp,'wx',0o600);
        try {await h.writeFile(JSON.stringify(s));await h.sync();}finally{await h.close();}
        await fs.rename(temp,stateFile);
        // Directory fsync is supported on Linux; Windows rejects opening a directory.
        if(process.platform!=='win32') {const d=await fs.open(directory,'r');try{await d.sync();}finally{await d.close();}}
      } finally {await fs.unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
      return result;
    } finally {await fs.rmdir(lock);}
  }
  return {
    async publish(x) {return transaction(s=>{
      demand(uuid(x.review_id)&&uuid(x.selection_id)&&id(x.owner)&&/^PXO-\d{6}$/.test(x.order_id)
        &&/^PXR-\d{6}$/.test(x.run_id)&&PRICES[x.product]&&sha(x.master_sha256)&&sha(x.preview_sha256)
        &&typeof x.title==='string'&&x.title.length>0&&x.title.length<=100
        &&Number.isFinite(x.duration)&&x.duration>0&&x.duration<=1800,'Invalid review evidence.',400);
      demand(Array.isArray(x.watermarks)&&x.watermarks.length===3
        &&new Set(x.watermarks.map(w=>w.sha256)).size===3
        &&x.watermarks.every((w,i)=>sha(w.sha256)&&Number.isFinite(w.at)&&Number.isFinite(w.duration)
          &&w.duration>0&&w.at>=0&&w.at+w.duration<=x.duration
          &&(i===0||w.at>=x.watermarks[i-1].at+x.watermarks[i-1].duration)),'Three distinct, separate watermarks are required.',400);
      const keys=['review_id','selection_id','owner','order_id','run_id','product','title','master_sha256','preview_sha256','duration','watermarks'];
      const record=Object.fromEntries(keys.map(k=>[k,x[k]]));record.identity=digest(record);
      const old=s.reviews[x.review_id];
      if(old) {demand(old.identity===record.identity,'Review evidence changed. Publish a new review revision.');return publicReview(s,old);}
      demand(!Object.values(s.reviews).some(r=>r.order_id===x.order_id),'Order already has a review.');
      record.state='REVIEW';record.created_at=stamp();s.reviews[x.review_id]=record;return publicReview(s,record);
    });},
    async get(owner,key) {return transaction(s=>publicReview(s,owned(s,owner,key)));},
    async list(owner) {return transaction(s=>({credits:balance(s,owner),reviews:Object.values(s.reviews).filter(r=>r.owner===owner).map(r=>publicReview(s,r))}));},
    async approve(owner,key,previewHash,method) {return transaction(s=>{
      available(s,owner);const r=owned(s,owner,key);
      demand(r.preview_sha256===previewHash,'The song preview changed. Listen to the current version.');
      demand(['CREDIT','PAYMENT'].includes(method),'Choose a credit or checkout.',400);
      if(r.authorization) {demand(r.authorization.kind===method,'This song is already approved using another method.');return publicReview(s,r);}
      if(method==='CREDIT') {
        demand(r.state==='REVIEW','Checkout is already in progress.');
        const credits=balance(s,owner);
        demand(Number.isSafeInteger(credits)&&credits>0,'No available song credits.');
        r.approved_at=stamp();authorize(r,'CREDIT',key,credits-1);
      } else {demand(['REVIEW','PAYMENT_PENDING'].includes(r.state),'This review cannot be approved.');r.approved_at=r.approved_at||stamp();r.state='PAYMENT_PENDING';}
      return publicReview(s,r);
    });},
    async reservePayment(owner,key) {return transaction(s=>{
      available(s,owner);const r=owned(s,owner,key);demand(r.state==='PAYMENT_PENDING'&&!r.authorization,'Approve the song before checkout.');
      let existing=Object.values(s.intents).find(i=>i.review_id===key&&!['FAILED','CANCELLED','ABANDONED'].includes(i.state));
      // An unbound payment ID has never been returned to the browser. Expire only that
      // creation reservation, and reject any late binding before starting another one.
      if(existing&&!existing.payment_id&&Date.now()-Date.parse(existing.created_at)>300000){
        existing.state='ABANDONED';existing.abandoned_at=stamp();existing=null;
      }
      if(existing) {
        demand(existing.payment_id,'Checkout is still preparing. Please retry in a few minutes.');
        return {...existing,create:false};
      }
      const i={intent_id:crypto.randomUUID(),review_id:key,owner,amount_minor:PRICES[r.product],currency:'CAD',
        title:r.title,preview_sha256:r.preview_sha256,state:'CREATING',created_at:stamp()};
      s.intents[i.intent_id]=i;return {...i,create:true};
    });},
    async bindPayment(owner,intentId,payment) {return transaction(s=>{
      const i=s.intents[intentId];demand(i&&i.owner===owner,'Checkout intent not found.',404);
      demand(i.state!=='ABANDONED','This checkout attempt expired. Return to your song review.');
      demand(uuid(payment.id)&&minor(payment.amount)===i.amount_minor&&payment.currency==='CAD','Wix payment differs from the quoted song.');
      demand(!i.payment_id||i.payment_id===payment.id,'Checkout already has another payment.');
      const p=s.payments[payment.id]||{};demand(!p.intent_id||p.intent_id===intentId,'Payment already belongs to another song.');
      i.payment_id=payment.id;i.state='PENDING';p.intent_id=intentId;s.payments[payment.id]=p;applyPayment(s,payment.id);
      return {ok:true,payment_id:payment.id};
    });},
    async paymentEvent(event) {return transaction(s=>{
      const p=event.payment;
      demand(p&&uuid(p.id)&&id(event.transactionId)&&typeof event.status==='string','Invalid Wix payment event.',400);
      const amount=minor(p.amount);demand(p.currency==='CAD','Unexpected payment currency.');
      const key=digest([p.id,event.transactionId,event.status]);const evidence={payment_id:p.id,transaction_id:event.transactionId,status:event.status,amount_minor:amount,currency:p.currency};
      if(s.events[key]) {demand(digest(s.events[key])===digest(evidence),'Payment event changed.');return {ok:true,duplicate:true};}
      const saved=s.payments[p.id]||{};
      if(saved.intent_id && event.status==='Successful') demand(amount===s.intents[saved.intent_id].amount_minor,'Payment amount differs.');
      if(event.status==='Successful') {
        if(saved.success) demand(saved.success.transaction_id===event.transactionId&&saved.success.amount_minor===amount,'Payment transaction changed.');
        saved.success=evidence;
      }
      if(event.status==='Refunded'||event.status==='PartiallyRefunded'||event.status==='Chargeback') {
        saved.refunded=evidence;
        if(saved.intent_id) s.holds[s.intents[saved.intent_id].owner]='Payment adjustment requires review';
      }
      // Pending/Failed notifications cannot undo a successful payment.
      if(['Failed','Cancelled'].includes(event.status)&&saved.intent_id&&!saved.success)
        s.intents[saved.intent_id].state=event.status.toUpperCase();
      s.payments[p.id]=saved;s.events[key]=evidence;applyPayment(s,p.id);return {ok:true};
    });},
    async reservePlan(owner,planKey) {return transaction(s=>{
      available(s,owner);const plan=PLANS[planKey],planId=config.plan_ids?.[planKey];
      demand(plan&&uuid(planId),'Monthly plan is not configured.');
      demand(!Object.values(s.subscriptions||{}).some(o=>o.owner===owner&&o.plan_id===planId&&['ACTIVE','PENDING','PAUSED'].includes(o.status)),
        'You already have this monthly plan. Manage the existing subscription.');
      s.plan_intents=s.plan_intents||{};
      let old=Object.values(s.plan_intents).find(i=>i.owner===owner&&i.plan_id===planId&&!['PAID','ABANDONED'].includes(i.state));
      if(old&&!old.payment_id&&Date.now()-Date.parse(old.created_at)>300000){old.state='ABANDONED';old=null;}
      if(old){demand(old.order_id&&old.payment_id,'Subscription checkout is still preparing. Please retry in a few minutes.');return {...old,create:false};}
      const intent={intent_id:crypto.randomUUID(),owner,plan_key:planKey,plan_id:planId,amount_minor:plan.amount_minor,currency:'CAD',state:'CREATING',created_at:stamp()};
      s.plan_intents[intent.intent_id]=intent;return {...intent,create:true};
    });},
    async bindPlan(owner,intentId,order) {return transaction(s=>{
      const i=s.plan_intents?.[intentId];demand(i&&i.owner===owner,'Subscription checkout is unavailable.');
      demand(i.state!=='ABANDONED','This subscription checkout attempt expired. Try again.');
      demand(order.buyer?.memberId===owner&&order.planId===i.plan_id&&uuid(order._id)&&uuid(order.wixPayOrderId)
        &&order.priceDetails?.currency==='CAD'&&minor(order.priceDetails.total)===i.amount_minor,'Subscription checkout total or owner differs.');
      demand(!i.order_id||i.order_id===order._id,'Another subscription already owns this checkout.');
      i.order_id=order._id;i.payment_id=order.wixPayOrderId;i.state='PENDING';
      if(s.grants[order._id+':1'])i.state='PAID';return {ok:true};
    });},
    async grantCycle(order) {return transaction(s=>{
      const planKey=Object.keys(PLANS).find(k=>config.plan_ids?.[k]===order.planId);const plan=PLANS[planKey];
      demand(plan&&uuid(order._id)&&uuid(order.subscriptionId)&&id(order.buyer?.memberId),'Unknown song-credit plan.');
      const cycle=order.currentCycle;
      demand(order.type==='ONLINE'&&order.lastPaymentStatus==='PAID'&&Number.isInteger(cycle?.index)&&cycle.index>0,'No paid subscription cycle.');
      demand(order.pricing?.subscription?.cycleDuration?.unit==='MONTH'&&order.pricing.subscription.cycleDuration.count===1,'Plan is not monthly.');
      const prices=order.pricing.prices.filter(p=>p.duration?.cycleFrom<=cycle.index
        &&(p.duration.numberOfCycles===undefined||p.duration.cycleFrom+p.duration.numberOfCycles>cycle.index));
      demand(prices.length===1&&prices[0].price.currency==='CAD'&&minor(prices[0].price.total)===plan.amount_minor,'Monthly amount differs.');
      const key=order._id+':'+cycle.index;
      const record={owner:order.buyer.memberId,order_id:order._id,subscription_id:order.subscriptionId,
        plan_id:order.planId,cycle:cycle.index,credits:plan.credits,amount_minor:plan.amount_minor,currency:'CAD'};
      const old=s.grants[key];if(old)demand(digest(old)===digest(record),'Paid cycle ownership or terms changed.');else s.grants[key]=record;
      for(const intent of Object.values(s.plan_intents||{}))if(intent.order_id===order._id)intent.state='PAID';
      if(cycle.index>1&&!s.grants[order._id+':'+(cycle.index-1)]){
        s.issues=s.issues||{};s.issues[order._id]='Previous paid cycle needs provider reconciliation; no unproved credits were added.';
      }
      return {ok:true,duplicate:!!old,credits:balance(s,record.owner)};
    });},
    async subscriptionState(order) {return transaction(s=>{
      const plan=Object.keys(PLANS).find(k=>config.plan_ids?.[k]===order.planId);
      demand(plan&&uuid(order._id)&&id(order.buyer?.memberId),'Unknown subscription.');
      demand(['DRAFT','PENDING','ACTIVE','PAUSED','ENDED','CANCELED'].includes(order.status)
        &&Number.isFinite(Date.parse(order.updated_at)),'Invalid subscription state.');
      const grants=Object.values(s.grants).filter(g=>g.order_id===order._id);
      demand(grants.every(g=>g.owner===order.buyer.memberId),'Subscription ownership differs.');
      if(order.lastPaymentStatus==='REFUNDED')s.holds[order.buyer.memberId]='Subscription refund requires review';
      s.subscriptions=s.subscriptions||{};
      const old=s.subscriptions[order._id];
      if(!old||Date.parse(old.updated_at)<=Date.parse(order.updated_at))s.subscriptions[order._id]={
        owner:order.buyer.memberId,plan_id:order.planId,status:order.status,updated_at:order.updated_at};
      // Cancellation and failed renewal do not remove any previously earned credits.
      return {ok:true,credits:balance(s,order.buyer.memberId)};
    });},
    async status() {return transaction(s=>({reviews:Object.keys(s.reviews).length,paid_cycles:Object.keys(s.grants).length,
      payment_holds:Object.keys(s.holds).length,reconciliation_issues:Object.values(s.issues||{}),
      pending_checkouts:Object.values(s.intents).filter(i=>i.state!=='SUCCESSFUL').length}));},
    async delivery(owner,key) {return transaction(s=>{
      available(s,owner);const r=owned(s,owner,key);demand(r.authorization,'Approval and payment/credit are required.');
      return {review_id:key,owner,selection_id:r.selection_id,order_id:r.order_id,run_id:r.run_id,
        master_sha256:r.master_sha256,preview_sha256:r.preview_sha256,authorization:r.authorization,state:r.state,
        ...(r.authorization.kind==='PAYMENT'?{payment:{payment_id:r.authorization.reference,
          transaction_id:s.payments[r.authorization.reference].success.transaction_id,
          amount_minor:s.payments[r.authorization.reference].success.amount_minor,currency:'CAD'}}:{})};
    });},
    async delivered(owner,key,receipt) {return transaction(s=>{
      available(s,owner);const r=owned(s,owner,key);demand(r.authorization&&sha(receipt),'Delivery authority or receipt is missing.');
      demand(!r.delivery_receipt||r.delivery_receipt===receipt,'A different delivery receipt already exists.');
      r.delivery_receipt=receipt;r.delivered_at=r.delivered_at||stamp();r.state='DELIVERED';return {ok:true};
    });}
  };
}
module.exports={createStore,PRICES,PLANS,minor,digest,demand};
