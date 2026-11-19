'use strict';
const path=require('node:path');
function attach(app,c){
  const route=fn=>async(req,res,next)=>{try{res.set('Cache-Control','no-store');if(!c.store)return res.status(503).json({error:'Tester enrollment is unavailable. Contact Project X.'});await fn(req,res);}catch(e){next(e);}};
  app.get('/tester-agreement',(req,res)=>{res.set('Cache-Control','no-store');res.sendFile(path.join(c.root,'public/tester-agreement.html'));});
  app.get('/api/session/tester-agreement',c.authenticatedMember,route(async(req,res)=>{
    const result=await c.store.presentTesterForAccount(req.memberId,req.memberEmail);
    res.json({ok:true,...result});
  }));
  app.post('/api/session/tester-agreement',c.authenticatedMember,c.requireSameOrigin,route(async(req,res)=>{
    const b=req.body||{};
    const result=await c.store.acceptTesterForAccount(req.memberId,req.memberEmail,{
      accepted:b.accepted,typed_name:b.typed_name,challenge:b.challenge,
      agreement_sha256:b.agreement_sha256,agreement_version:b.agreement_version
    });
    res.json({ok:true,active:result.tester.active,accepted_at:result.acceptance.accepted_at});
  }));
}
function requireAcceptance(store){return async(req,res,next)=>{
  try{
    if(req.captureProgram==='CUSTOMER'&&store){
      const tester=await store.testerConsentStatus(req.memberId,req.memberEmail);
      if(tester.required)return res.status(403).json({code:'TESTER_AGREEMENT_REQUIRED',error:'Please accept your tester agreement with the other consent decisions before starting a recording session.'});
    }
    next();
  }catch(error){next(error);}
};}
module.exports={attach,requireAcceptance};
