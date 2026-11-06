'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {PRICES,demand}=require('./song-commerce');
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
async function read(file){try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function write(file,value){const temp=file+'.'+crypto.randomUUID()+'.tmp';try{await fs.writeFile(temp,JSON.stringify(value),{flag:'wx',mode:0o600});await fs.rename(temp,file);}finally{await fs.unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}}
function attach(app,c){
  const root=path.join(c.dataDir,'song-commits');
  const gate=require('./account-song-limit').createAccountSongGate(c.dataDir);
  const memberAllowed=owner=>c.config.enabled===true&&(c.config.public_processing===true||c.config.pilot_members?.includes(owner));
  const file=id=>{demand(uuid(id),'Invalid song selection.',400);return path.join(root,id+'.json');};
  async function owned(owner,id){const r=await read(file(id));if(r)demand(r.owner_member_id===owner&&r.selection_id===id&&r.schema_version==='PX-CREATE-SONG-1.0','Song request owner differs.');return r;}
  app.get('/api/transfer/customer-song-commits',c.transferAuth,async(req,res,next)=>{try{
    demand(c.config.enabled===true,'Customer review processing is not enabled.',503);
    let names;try{names=await fs.readdir(root);}catch(e){if(e.code!=='ENOENT')throw e;names=[];}
    names=names.filter(n=>uuid(n.slice(0,-5))&&n.endsWith('.json'));
    demand(names.length<=5000,'Customer song archive requires maintenance.',503);
    const commands=[];
    for(const name of names){const r=await read(path.join(root,name));if(r?.mode==='CUSTOMER'&&['REQUESTED','WORKING'].includes(r.state))commands.push(r);}
    demand(commands.length<=100,'Customer queue requires pagination.',503);
    commands.sort((a,b)=>a.requested_at.localeCompare(b.requested_at));res.json({ok:true,commands});
  }catch(e){next(e);}});
  return {
    memberAllowed,
    async hasLegacy(owner,id){const r=await owned(owner,id);return !!r&&r.mode==='ACCOUNT_TEST';},
    async admit(a){
      demand(memberAllowed(a.sub),'Customer preview processing is not enabled for this account.',403);
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
          const frozen=await c.freezeMessage(a.sub,a.selection_id);
          const s=frozen.selection,product=s.product_type||'VOICE_CLONE';
          demand(s.owner_member_id===a.sub&&/^PXC-\d{6}$/.test(s.customer_id||'')&&PRICES[product]
            &&['RECORDED','SKIPPED'].includes(frozen.message?.choice),'Customer selection or message authority differs.');
          demand(!s.account_test_only&&!s.profile_origin,'Test-only voice profiles cannot enter paid customer production.');
          r={schema_version:'PX-CREATE-SONG-1.0',selection_id:a.selection_id,owner_member_id:a.sub,email:a.email,
            mode:'CUSTOMER',authorize_preview:true,authorize_comped:false,authorize_test_email:false,
            price_minor:PRICES[product],currency:'CAD',state:'REQUESTED',frozen,
            requested_at:new Date().toISOString(),updated_at:new Date().toISOString(),claim_id:null,order_id:'',run_id:''};
          await write(file(r.selection_id),r);
          return {ok:true,creation:{selection_id:r.selection_id,state:r.state,order_id:'',run_id:''}};
        }finally{await fs.rmdir(lock);}
      });
    }
  };
}
module.exports={attach};
