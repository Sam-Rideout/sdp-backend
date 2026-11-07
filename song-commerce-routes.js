'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {createStore,demand}=require('./song-commerce');
function attach(app,c) {
  if(c.config?.enabled!==true) {
    const unavailable=(req,res)=>res.set('Cache-Control','no-store').status(503).json({
      ok:false,code:'SONG_REVIEW_UNAVAILABLE',
      error:'Song review and checkout are not available yet. Please return to My Orders.'
    });
    app.post('/api/wix/song-commerce',unavailable);
    app.post('/api/wix/song-commerce-event',unavailable);
    return null;
  }
  const folder=path.join(c.dataDir,'song-commerce'),audio=path.join(folder,'preview-audio');
  const store=createStore(folder,c.config);
  const memberAllowed=owner=>typeof owner==='string'&&(c.config.public_processing===true
    ||c.config.pilot_members?.includes(owner)===true);
  const requireMember=owner=>demand(memberAllowed(owner),
    'Song review and checkout are not available yet. Please return to My Orders.',503);
  const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
  const route=fn=>async(req,res,next)=>{try{res.set('Cache-Control','no-store');await fn(req,res);}catch(e){next(e);}};
  const valid=(a,aud,purpose)=>{
    const now=Math.floor(Date.now()/1000);
    return a&&a.iss==='wix'&&a.aud===aud&&a.purpose===purpose&&typeof a.sub==='string'
      &&a.sub.length>=3&&a.sub.length<=200&&Number.isInteger(a.iat)&&Number.isInteger(a.exp)
      &&a.iat<=now+30&&a.iat>=now-180&&a.exp>now&&a.exp<=now+180&&/^[a-f0-9]{48}$/.test(a.jti||'');
  };
  app.post('/api/wix/song-commerce',route(async(req,res)=>{
    const a=c.verifySigned(req.body?.ticket);
    demand(valid(a,'project-x-commerce','member-operation'),'Sign in again to continue.',401);
    requireMember(a.sub);
    demand(await c.consumeTicket(a.jti),'Authorization already used. Retry the action.',401);
    let result;
    switch(a.operation) {
      case 'LIST':result=await store.list(a.sub);break;
      case 'GET':result=await store.get(a.sub,a.review_id);break;
      case 'APPROVE':result=await store.approve(a.sub,a.review_id,a.preview_sha256,a.method);break;
      case 'RESERVE_PAYMENT':result=await store.reservePayment(a.sub,a.review_id);break;
      case 'BIND_PAYMENT':result=await store.bindPayment(a.sub,a.intent_id,a.payment);break;
      case 'RESERVE_PLAN':result=await store.reservePlan(a.sub,a.plan_key);break;
      case 'BIND_PLAN':result=await store.bindPlan(a.sub,a.intent_id,a.order);break;
      default:demand(false,'Unknown review action.',400);
    }
    // The signed URL exposes only the watermarked artifact, never a clean file.
    if(a.operation==='GET') {
      const now=Math.floor(Date.now()/1000);
      const ticket=c.sign({iss:'project-x',aud:'song-preview-audio',sub:a.sub,sha256:result.preview_sha256,iat:now,exp:now+900});
      result.preview_url=c.origin+'/api/song-review-audio/'+result.preview_sha256+'?ticket='+encodeURIComponent(ticket);
    }
    res.json({ok:true,result});
  }));
  app.post('/api/wix/song-commerce-event',route(async(req,res)=>{
    const a=c.verifySigned(req.body?.ticket);
    demand(valid(a,'project-x-commerce','provider-event')&&a.sub==='wix-backend','Payment authorization failed.',401);
    demand(await c.consumeTicket(a.jti),'Event authorization was already used.',401);
    let result;
    if(a.operation==='PAYMENT') result=await store.paymentEvent(a.event);
    else if(a.operation==='PAID_CYCLE') {requireMember(a.order?.buyer?.memberId);result=await store.grantCycle(a.order);}
    else if(a.operation==='SUBSCRIPTION_STATE') {requireMember(a.order?.buyer?.memberId);result=await store.subscriptionState(a.order);}
    else demand(false,'Unknown provider event.',400);
    res.json({ok:true,result});
  }));
  app.post('/api/transfer/song-review-audio/:sha',c.transferAuth,c.express.raw({type:'application/octet-stream',limit:'48mb'}),route(async(req,res)=>{
    demand(hex(req.params.sha)&&Buffer.isBuffer(req.body)&&req.body.length>0,'Invalid preview audio.',400);
    demand(crypto.createHash('sha256').update(req.body).digest('hex')===req.params.sha,'Preview bytes differ from their fingerprint.');
    await fs.mkdir(audio,{recursive:true,mode:0o700});const file=path.join(audio,req.params.sha+'.mp3');
    const lock=path.join(audio,'Upload.lock');
    try{await fs.mkdir(lock);}catch(e){if(e.code==='EEXIST')demand(false,'Another preview upload is running. Retry shortly.',503);throw e;}
    try {
      let exists=false;try{const st=await fs.lstat(file);demand(st.isFile()&&!st.isSymbolicLink(),'Stored preview requires review.');exists=true;}catch(e){if(e.code!=='ENOENT')throw e;}
      if(!exists) {
        demand(typeof c.directoryBytes==='function'&&Number.isSafeInteger(c.maxStoreBytes),'Preview storage limit is not configured.',503);
        demand((await c.directoryBytes(c.dataDir))+req.body.length<=c.maxStoreBytes,'Preview storage is full. Contact Project X before submitting another song.',507);
      }
      // Immutable, content-addressed publish. No partial file is exposed by GET.
      const temp=file+'.'+crypto.randomUUID()+'.tmp';
      try {const h=await fs.open(temp,'wx',0o600);try{await h.writeFile(req.body);await h.sync();}finally{await h.close();}
        try{await fs.link(temp,file);}catch(e){if(e.code!=='EEXIST')throw e;}
      }finally{await fs.unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
      demand(crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex')===req.params.sha,'Stored preview differs.');
    } finally{await fs.rmdir(lock);}
    res.json({ok:true,preview_sha256:req.params.sha});
  }));
  app.post('/api/transfer/song-reviews',c.transferAuth,route(async(req,res)=>{
    requireMember(req.body?.owner);
    demand(hex(req.body?.preview_sha256),'Missing preview identity.',400);
    await fs.access(path.join(audio,req.body.preview_sha256+'.mp3'));
    res.json({ok:true,result:await store.publish(req.body)});
  }));
  app.post('/api/transfer/song-review-authority',c.transferAuth,route(async(req,res)=>{
    requireMember(req.body?.owner);
    res.json({ok:true,result:await store.delivery(req.body?.owner,req.body?.review_id)});
  }));
  app.get('/api/transfer/song-commerce-status',c.transferAuth,route(async(req,res)=>{
    res.json({ok:true,result:await store.status()});
  }));
  app.post('/api/transfer/song-review-delivered',c.transferAuth,route(async(req,res)=>{
    requireMember(req.body?.owner);
    res.json(await store.delivered(req.body?.owner,req.body?.review_id,req.body?.receipt_sha256));
  }));
  app.get('/api/song-review-audio/:sha',route(async(req,res)=>{
    const a=c.verifySigned(req.query.ticket),now=Math.floor(Date.now()/1000);
    demand(hex(req.params.sha)&&a&&a.iss==='project-x'&&a.aud==='song-preview-audio'
      &&a.sha256===req.params.sha&&Number.isInteger(a.iat)&&Number.isInteger(a.exp)
      &&a.iat<=now&&a.exp>now&&a.exp-a.iat<=900,'Preview link expired. Refresh your review.',401);
    requireMember(a.sub);
    res.set('Content-Type','audio/mpeg');res.set('Content-Disposition','inline; filename="Project X Preview.mp3"');
    res.set('Referrer-Policy','no-referrer');res.set('X-Content-Type-Options','nosniff');
    res.sendFile(path.resolve(audio,req.params.sha+'.mp3'),e=>{if(e&&!res.headersSent)res.status(e.statusCode||404).end();});
  }));
  return store;
}
module.exports={attach};
