(()=>{'use strict';
 const token=new URLSearchParams(location.hash.slice(1)).get('token');history.replaceState(null,'',location.pathname);
 const el=id=>document.getElementById(id),status=el('status');let current,busy=false;
 const showDate=v=>new Intl.DateTimeFormat('en-CA',{dateStyle:'full',timeStyle:'long',timeZone:'America/Halifax'}).format(new Date(v));
 async function post(route,body){const r=await fetch(route,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const value=await r.json();if(!r.ok)throw new Error(value.error||'The renewal could not be completed.');return value;}
 async function start(){try{
  current=await post('/api/profile-consent/link',{token});el('deadline').textContent='Current deletion deadline: '+showDate(current.expires_at);
  const r=await fetch('/consent?version='+current.consent_document_sha256,{cache:'no-store'});if(!r.ok)throw new Error('Could not load the current consent terms.');const bytes=await r.arrayBuffer(),digest=await crypto.subtle.digest('SHA-256',bytes),hash=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');if(hash!==current.consent_document_sha256)throw new Error('Consent document verification failed.');
  const page=new DOMParser().parseFromString(new TextDecoder().decode(bytes),'text/html'),main=page.querySelector('main');if(!main)throw new Error('Consent document is unavailable.');for(const n of main.querySelectorAll('script,iframe,style'))n.remove();el('terms').replaceChildren(...Array.from(main.childNodes,n=>document.importNode(n,true)));
  el('renew').hidden=false;status.textContent='Your existing profile will be preserved when you re-sign. Improvement use is optional and starts unchecked.';
 }catch(e){status.textContent=e.message;}}
 el('renew').addEventListener('submit',async e=>{e.preventDefault();if(busy||!current)return;busy=true;el('submit').disabled=true;
  try{const result=await post('/api/profile-consent/renew-link',{token,expected_event_sha256:current.event_sha256,consent_version:current.consent_version,consent_document_sha256:current.consent_document_sha256,agree:el('agree').checked,adult_confirmed:el('adult').checked,own_voice_confirmed:el('adult').checked,development_use:el('improvement').checked});
   window.PXShowConsentReminder(result.expires_at,'renewed');el('renew').hidden=true;status.textContent='Consent renewed. Your existing profile is kept. New deletion deadline: '+showDate(result.expires_at)+'. No recording or retraining is needed.';
  }catch(error){status.textContent=error.message;el('submit').disabled=false;busy=false;}
 });if(token)start();else status.textContent='Open the renewal link in your Project X reminder email. This page cannot renew a profile without its valid link.';
})();
