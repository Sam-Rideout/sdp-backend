'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {PRICES,demand,createStore}=require('./song-commerce');
const priceQuote=require('./song-price-quote');
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
async function read(file){try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function write(file,value){const temp=file+'.'+crypto.randomUUID()+'.tmp';try{await fs.writeFile(temp,JSON.stringify(value),{flag:'wx',mode:0o600});await fs.rename(temp,file);}finally{await fs.unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}}
function attach(app,c){
  const root=path.join(c.dataDir,'song-commits');
  const gate=require('./account-song-limit').createAccountSongGate(c.dataDir);
  const commerce=createStore(path.join(c.dataDir,'song-commerce'),c.config);
  const regularAllowed=owner=>c.config.enabled===true&&(c.config.public_processing===true||c.config.pilot_members?.includes(owner));
  const memberAllowed=async owner=>c.config.enabled===true&&(regularAllowed(owner)||(await commerce.testerStatus(owner)).active);
  const file=id=>{demand(uuid(id),'Invalid song selection.',400);return path.join(root,id+'.json');};
  async function owned(owner,id){const r=await read(file(id));if(r)demand(r.owner_member_id===owner&&r.selection_id===id&&r.schema_version==='PX-CREATE-SONG-1.0','Song request owner differs.');return r;}
  async function assertCustomerAvailable(owner){
    // Processing COMPLETED is not delivery. Keep admission serialized by the
    // account gate until the review and its original request both finish.
    const {reviews}=await commerce.list(owner);
    const message='You already have a song being prepared or awaiting approval, payment or delivery. Please finish that request before creating another.';
    const blocked=()=>{const error=new Error(message);error.status=409;error.code='ACTIVE_SONG_LIMIT';throw error;};
    if(reviews.some(r=>r.state!=='DELIVERED'))blocked();
    const names=(await fs.readdir(root)).filter(n=>n.endsWith('.json')&&uuid(n.slice(0,-5)));
    demand(names.length<=5000,'Customer song archive requires maintenance.',503);
    for(const name of names){
      const r=await read(path.join(root,name));
      demand(r,'Customer song request status could not be confirmed.',503);
      if(r.owner_member_id!==owner||r.mode!=='CUSTOMER')continue;
      demand(r.schema_version==='PX-CREATE-SONG-1.0'&&name===r.selection_id+'.json'
        &&['REQUESTED','WORKING','DONE','CANCELLED','NEEDS_ATTENTION'].includes(r.state)
        &&(r.outcome===undefined||r.state==='NEEDS_ATTENTION'&&r.outcome==='PRODUCTION_REJECTED'),
        'Customer song request status needs review.',503);
      if(r.state==='CANCELLED')continue;
      // PC-confirmed cancellation is authoritative even when a failed commit
      // retains its terminal QA state. Pending/TOO_LATE receipts never release it.
      const {readCancel}=require('./wix-cancel');
      const selectionCancellation=await readCancel(c.dataDir,owner,'SELECTION',r.selection_id);
      const orderCancellation=/^PXO-\d{6}$/.test(r.order_id||'')
        ? await readCancel(c.dataDir,owner,'ORDER',r.order_id) : null;
      if(selectionCancellation?.status==='CANCELLED'||orderCancellation?.status==='CANCELLED')continue;
      // This also closes the interval between processing completion and preview
      // publication, when there may not be a commerce review record yet.
      if(r.state!=='DONE')blocked();
      const delivered=reviews.filter(review=>review.selection_id===r.selection_id);
      demand(delivered.length===1&&delivered[0].state==='DELIVERED'
        &&delivered[0].order_id===r.order_id&&delivered[0].run_id===r.run_id,
        'The previous song delivery needs review before another request can be created.');
    }
  }
  app.get('/api/transfer/failed-song-cancellation-status',c.transferAuth,(req,res)=>res.json({ok:true,schema_version:'PX-AUTO-FAILED-SONG-1.0'}));
  app.post('/api/transfer/song-commits/:selectionId/cancel-failed',c.transferAuth,async(req,res,next)=>{try{
    const b=req.body||{},p=b.proof;
    demand(p&&p.schema_version==='PX-AUTO-FAILED-SONG-1.0'&&['PREPARE','CONFIRM'].includes(b.operation)
      &&uuid(p.selection_id)&&p.selection_id===req.params.selectionId&&uuid(p.claim_id)
      &&typeof p.owner_member_id==='string'&&p.owner_member_id.length>=3&&p.owner_member_id.length<=200
      &&/^PXC-\d{6}$/.test(p.customer_id)&&/^PXO-\d{6}$/.test(p.order_id)&&/^PXR-\d{6}$/.test(p.run_id)
      &&['TECHNICAL_FAILURE','REJECTED'].includes(p.run_status)&&/^[a-f0-9]{64}$/.test(p.failure_sha256)
      &&p.payment_status==='NOT_REQUIRED'&&p.amount_cad==='0.00','Invalid failure cancellation proof.');
    const keys=['schema_version','owner_member_id','customer_id','selection_id','order_id','run_id','claim_id','run_status','failure_sha256','payment_status','amount_cad'].sort();
    demand(Object.keys(p).length===keys.length&&keys.every(k=>Object.hasOwn(p,k)),'Failure proof fields differ.');
    const evidence=crypto.createHash('sha256').update(JSON.stringify(Object.fromEntries(keys.map(k=>[k,p[k]])))).digest('hex');
    demand(b.evidence_sha256===evidence,'Failure proof fingerprint differs.');
    await gate.exclusive(p.owner_member_id,async()=>{
      const r=await owned(p.owner_member_id,p.selection_id);
      demand(r&&r.mode==='CUSTOMER'&&r.authorize_preview===true&&!r.authorize_comped&&!r.authorize_test_email
        &&r.state==='NEEDS_ATTENTION'&&r.claim_id===p.claim_id&&r.order_id===p.order_id&&r.run_id===p.run_id
        &&r.frozen?.selection?.customer_id===p.customer_id&&r.frozen?.selection?.owner_member_id===p.owner_member_id
        &&r.frozen?.selection?.selection_id===p.selection_id,'Failed request ownership or terminal state differs.');
      if(r.outcome!==undefined)demand(r.outcome==='PRODUCTION_REJECTED'&&p.run_status==='REJECTED','Failure outcome differs.');
      const reserved=await commerce.reserveFailedCancellation(p,evidence);
      if(b.operation==='PREPARE')return res.json(reserved);
      const {readCancel}=require('./wix-cancel');
      const old=await readCancel(c.dataDir,p.owner_member_id,'ORDER',p.order_id);
      demand(!old||old.status==='CANCELLED','An existing cancellation must finish reconciliation first.');
      if(!old){
        const command_id=crypto.createHash('sha256').update(JSON.stringify([p.owner_member_id,'ORDER',p.order_id])).digest('hex');
        const stamp=new Date().toISOString();
        const record={schema_version:'PX-SONG-CANCELLATION-1.0',command_id,owner_member_id:p.owner_member_id,
          kind:'ORDER',target_id:p.order_id,status:'CANCELLED',requested_at:stamp,resolved_at:stamp,
          reason:'AUTO_UNPAID_FAILURE',evidence_sha256:evidence};
        const folder=path.join(c.dataDir,'song-cancellations');await fs.mkdir(folder,{recursive:true,mode:0o700});
        // Publish a fully written file with no overwrite, even if a manual cancellation races.
        const target=path.join(folder,command_id+'.json'),temp=target+'.'+crypto.randomUUID()+'.tmp';
        try{await fs.writeFile(temp,JSON.stringify(record),{flag:'wx',mode:0o600});await fs.link(temp,target);}
        catch(e){if(e.code!=='EEXIST')throw e;const concurrent=await readCancel(c.dataDir,p.owner_member_id,'ORDER',p.order_id);demand(concurrent?.status==='CANCELLED','Cancellation is still reconciling.');}
        finally{await fs.unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
      }
      res.json({ok:true,status:'CANCELLED',evidence_sha256:evidence});
    });
  }catch(e){next(e);}});
  app.get('/api/transfer/customer-song-commits',c.transferAuth,async(req,res,next)=>{try{
    demand(c.config.enabled===true,'Customer review processing is not enabled.',503);
    let names;try{names=await fs.readdir(root);}catch(e){if(e.code!=='ENOENT')throw e;names=[];}
    names=names.filter(n=>uuid(n.slice(0,-5))&&n.endsWith('.json'));
    demand(names.length<=5000,'Customer song archive requires maintenance.',503);
    const commands=[];
    for(const name of names){
      const r=await read(path.join(root,name));
      if(r?.mode!=='CUSTOMER'||!(regularAllowed(r.owner_member_id)||r.promotion&&await commerce.testerKnown(r.owner_member_id)))continue;
      if(['REQUESTED','WORKING'].includes(r.state)){commands.push(r);continue;}
      if(r.state==='NEEDS_ATTENTION'&&/^PXO-\d{6}$/.test(r.order_id||'')&&/^PXR-\d{6}$/.test(r.run_id||'')){
        const {readCancel}=require('./wix-cancel');
        const order=await readCancel(c.dataDir,r.owner_member_id,'ORDER',r.order_id);
        const selection=await readCancel(c.dataDir,r.owner_member_id,'SELECTION',r.selection_id);
        if(order?.status!=='CANCELLED'&&selection?.status!=='CANCELLED')commands.push(r);
      }
    }
    demand(commands.length<=100,'Customer queue requires pagination.',503);
    commands.sort((a,b)=>a.requested_at.localeCompare(b.requested_at));res.json({ok:true,commands});
  }catch(e){next(e);}});
  return {
    memberAllowed,
    async testerReserved(owner,email){return await commerce.testerKnown(owner)||await commerce.testerInvitedEmail(email);},
    async hasLegacy(owner,id){const r=await owned(owner,id);return !!r&&r.mode==='ACCOUNT_TEST';},
    async admit(a){
      demand(await memberAllowed(a.sub),'Customer preview processing is not enabled for this account.',403);
      demand(typeof a.email==='string'&&a.email===a.email.trim().toLowerCase()&&a.email.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.email),'Verified member email is missing.');
      return gate.exclusive(a.sub,async()=>{
        await fs.mkdir(root,{recursive:true,mode:0o700});const lock=file(a.selection_id)+'.lock';
        try{await fs.mkdir(lock);}catch(e){if(e.code==='EEXIST')demand(false,'The song request is being saved. Refresh your orders.');throw e;}
        try {
          let r=await owned(a.sub,a.selection_id);
          const {readCancel}=require('./wix-cancel');
          const cancellation=await readCancel(c.dataDir,a.sub,'SELECTION',a.selection_id);
          demand(!cancellation||cancellation.status==='TOO_LATE','This song request was withdrawn.');
          if(r){demand(r.mode==='CUSTOMER'&&r.email===a.email,'Saved customer request differs.');return {ok:true,creation:{selection_id:r.selection_id,state:r.state,order_id:r.order_id,run_id:r.run_id}};}
          await gate.assertAvailable(a.sub,a.selection_id);
          await assertCustomerAvailable(a.sub);
          const frozen=await c.freezeMessage(a.sub,a.selection_id);
          const s=frozen.selection,product=s.product_type||'VOICE_CLONE';
          demand(s.owner_member_id===a.sub&&/^PXC-\d{6}$/.test(s.customer_id||'')&&PRICES[product]
            &&['RECORDED','SKIPPED'].includes(frozen.message?.choice),'Customer selection or message authority differs.');
          demand(!s.account_test_only&&!s.profile_origin,'Test-only voice profiles cannot enter paid customer production.');
          const quote=priceQuote.fromTicket(a,product);
          if(quote)frozen.pricing_quote=quote;
          const quotedPrice=quote?quote.amount_minor:PRICES[product];
          return await commerce.testerAdmission(a.sub,a.email,async promotion=>{
          demand(promotion||regularAllowed(a.sub),'Song production is not enabled for this account.',403);
          r={schema_version:'PX-CREATE-SONG-1.0',selection_id:a.selection_id,owner_member_id:a.sub,email:a.email,
            mode:'CUSTOMER',authorize_preview:true,authorize_comped:false,authorize_test_email:false,
            ...(promotion?{promotion,catalog_price_minor:quotedPrice}:{}),price_minor:promotion?0:quotedPrice,currency:'CAD',state:'REQUESTED',frozen,
            requested_at:new Date().toISOString(),updated_at:new Date().toISOString(),claim_id:null,order_id:'',run_id:''};
          await write(file(r.selection_id),r);
          return {ok:true,creation:{selection_id:r.selection_id,state:r.state,order_id:'',run_id:''}};
          });
        }finally{await fs.rmdir(lock);}
      });
    }
  };
}
module.exports={attach};
