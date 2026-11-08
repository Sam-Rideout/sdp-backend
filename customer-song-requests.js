'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {PRICES,demand,createStore}=require('./song-commerce');
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
    demand(!reviews.some(r=>r.state!=='DELIVERED'),message);
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
      // This also closes the interval between processing completion and preview
      // publication, when there may not be a commerce review record yet.
      demand(r.state==='DONE',message);
      const delivered=reviews.filter(review=>review.selection_id===r.selection_id);
      demand(delivered.length===1&&delivered[0].state==='DELIVERED'
        &&delivered[0].order_id===r.order_id&&delivered[0].run_id===r.run_id,
        'The previous song delivery needs review before another request can be created.');
    }
  }
  app.get('/api/transfer/customer-song-commits',c.transferAuth,async(req,res,next)=>{try{
    demand(c.config.enabled===true,'Customer review processing is not enabled.',503);
    let names;try{names=await fs.readdir(root);}catch(e){if(e.code!=='ENOENT')throw e;names=[];}
    names=names.filter(n=>uuid(n.slice(0,-5))&&n.endsWith('.json'));
    demand(names.length<=5000,'Customer song archive requires maintenance.',503);
    const commands=[];
    for(const name of names){const r=await read(path.join(root,name));if(r?.mode==='CUSTOMER'&&(regularAllowed(r.owner_member_id)||r.promotion&&await commerce.testerKnown(r.owner_member_id))&&['REQUESTED','WORKING'].includes(r.state))commands.push(r);}
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
          return await commerce.testerAdmission(a.sub,a.email,async promotion=>{
          demand(promotion||regularAllowed(a.sub),'Song production is not enabled for this account.',403);
          r={schema_version:'PX-CREATE-SONG-1.0',selection_id:a.selection_id,owner_member_id:a.sub,email:a.email,
            mode:'CUSTOMER',authorize_preview:true,authorize_comped:false,authorize_test_email:false,
            ...(promotion?{promotion,catalog_price_minor:PRICES[product]}:{}),price_minor:promotion?0:PRICES[product],currency:'CAD',state:'REQUESTED',frozen,
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

