(()=>{
 'use strict';
 const link=document.getElementById('consentDocument'),details=document.getElementById('consentFullTerms'),content=document.getElementById('consentFullText');
 if(!link||!details||!content)return;let loading=false,loaded=false;
 async function show(){
  if(loading||loaded)return;loading=true;content.textContent='Loading the full terms…';
  try{
   const configResponse=await fetch('/api/config',{cache:'no-store'});if(!configResponse.ok)throw new Error();const config=await configResponse.json();
   const expected=config.consent_document_sha256;if(!/^[a-f0-9]{64}$/.test(expected||''))throw new Error();
   const response=await fetch('/consent?version='+expected,{cache:'no-store'});if(!response.ok)throw new Error();const bytes=await response.arrayBuffer();
   const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(v=>v.toString(16).padStart(2,'0')).join('');if(hash!==expected)throw new Error();
   const documentCopy=new DOMParser().parseFromString(new TextDecoder().decode(bytes),'text/html'),main=documentCopy.querySelector('main');if(!main)throw new Error();
   for(const node of main.querySelectorAll('script,style,iframe'))node.remove();
   for(const node of main.querySelectorAll('p'))if(node.textContent.trim().startsWith('When you have finished reading'))node.remove();
   content.replaceChildren(...[...main.childNodes].map(n=>document.importNode(n,true)));loaded=true;
  }catch{content.textContent='The full terms could not be loaded here. Use the full-document link to read them, then return to this page.';link.setAttribute('data-full-document-fallback','true');}
  finally{loading=false;}
 }
 link.addEventListener('click',event=>{if(link.hasAttribute('data-full-document-fallback'))return;event.preventDefault();details.open=true;show();});
 details.addEventListener('toggle',()=>{if(details.open)show();});
})();
