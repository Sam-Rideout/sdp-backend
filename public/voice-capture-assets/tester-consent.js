'use strict';
(() => {
  let view=null,saving=false;
  const el=id=>document.getElementById(id);
  const notify=()=>{if(typeof window.guidedConsentUpdate==='function')window.guidedConsentUpdate();};
  const filled=()=>Boolean(el('testerAgree')?.checked&&el('testerTypedName')?.value.trim()&&el('testerTypedName').value.trim().length<=160&&!/[\x00-\x1f\x7f]/.test(el('testerTypedName').value.trim()));
  async function request(method,body){
    const response=await fetch('/api/session/tester-agreement',{method,credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    const data=await response.json().catch(()=>null);
    if(!response.ok||data?.ok!==true)throw new Error(data?.error||'Your tester status could not be checked. Return to the Project X Home page, sign in, and reopen the recorder.');
    return data;
  }
  function render(){
    const panel=el('testerAgreementPanel'),notice=el('testerPendingNotice');
    if(notice)notice.hidden=!view.required;
    if(!panel)return;
    panel.hidden=!view.required;
    if(view.required){
      el('testerAgreementTitle').textContent=view.agreement.title;
      el('testerAgreementEmail').textContent='Signed-in account: '+view.email;
      // This is the approved server-owned agreement, never a form-supplied HTML value.
      el('testerAgreementText').innerHTML=view.agreement.html
        .replace(/<tr><td>Tester name<\/td><td>_+<\/td><\/tr>\s*/g,'')
        .replace(/<p>Typed name: _+<\/p>\s*/g,'');
      el('testerAgree').checked=false;
      el('testerTypedName').value='';
      el('testerAgreementFields').hidden=false;
      el('testerAgreementStatus').textContent='Read the complete agreement, enter your name, and select the acceptance checkbox.';
    }
  }
  async function load(){view=await request('GET');render();notify();return view;}
  function ready(){return Boolean(view&&!saving&&(!view.required||filled()));}
  async function ensure(){
    if(!view)await load();
    if(!view.required)return true;
    if(saving)return false;
    if(!filled())throw new Error('Read the tester agreement, enter your name, and select its acceptance checkbox.');
    saving=true;notify();el('testerAgreementStatus').textContent='Saving your tester agreement acceptance…';
    try{
      const result=await request('POST',{accepted:true,typed_name:el('testerTypedName').value.trim(),challenge:view.challenge,agreement_sha256:view.agreement.sha256,agreement_version:view.agreement.version});
      if(result.active!==true)throw new Error('Tester acceptance could not be confirmed. Please reload and check your status.');
      view={required:false,active:true,status:'ACTIVE',accepted_at:result.accepted_at};
      el('testerAgreementFields').hidden=true;
      el('testerAgreementStatus').textContent='Your tester agreement acceptance is saved. Tester access is active.';
      if(el('testerPendingNotice'))el('testerPendingNotice').hidden=true;
      return true;
    }catch(error){el('testerAgreementStatus').textContent=error.message;throw error;}
    finally{saving=false;notify();}
  }
  el('testerTypedName')?.addEventListener('input',notify);
  el('testerAgree')?.addEventListener('change',notify);
  window.PXTesterConsent={load,ready,ensure};
  const submit=el('acceptTesterAgreement');
  if(submit){
    const continueToCapture=()=>window.location.assign('/voice-capture');
    const showContinue=()=>{const link=el('testerContinue');if(link)link.hidden=false;};
    const update=()=>{submit.disabled=!ready();};
    el('testerTypedName').addEventListener('input',update);el('testerAgree').addEventListener('change',update);
    load().then(status=>{el('testerPageStatus').textContent=status.active?'Your tester agreement is already accepted. Continue to Voice Recording.':status.required?'Your invitation is ready. Complete the agreement below.':'No pending tester agreement is available for this signed-in account.';submit.hidden=!status.required;if(status.active)showContinue();update();}).catch(error=>{el('testerPageStatus').textContent=error.message;submit.hidden=true;});
    submit.addEventListener('click',async()=>{submit.disabled=true;try{await ensure();submit.hidden=true;el('testerPageStatus').textContent='Tester access is active. Opening Voice Recording…';showContinue();continueToCapture();}catch(error){el('testerPageStatus').textContent=error.message;}finally{update();}});
  }
})();
