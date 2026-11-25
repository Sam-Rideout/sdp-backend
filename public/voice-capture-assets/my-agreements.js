(()=>{'use strict';
const $=id=>document.getElementById(id);
let busy=false;
const text=(tag,value)=>{const n=document.createElement(tag);n.textContent=value||'';return n;};
async function request(url,options={}){
 const response=await fetch(url,{...options,credentials:'same-origin',cache:'no-store'});
 if(response.status===401){$('signIn').hidden=false;throw new Error('Sign in through My Agreements on the Project X website to view your own records.');}
 if(!response.ok)throw new Error('Saved agreements could not be loaded. Please try again or contact Project X.');
 return response.json();
}
function addField(list,label,value){if(value===undefined||value===null||value==='')return;list.append(text('dt',label),text('dd',String(value)));}
function render(record){
 const card=document.createElement('article');card.append(text('h2',record.title));const list=document.createElement('dl');
 addField(list,'Version',record.version);addField(list,'Accepted',record.accepted_at);addField(list,'Reference',record.reference);
 addField(list,'Signed name',record.typed_name);addField(list,'Tester status',record.status);addField(list,'Revoked',record.revoked_at);addField(list,'Storage expiry',record.expires_at);
 if(record.choices){addField(list,'Profile storage',record.choices.retention_text||record.choices.retention);addField(list,'Optional improvement use',record.choices.improvement===true?'Accepted':record.choices.improvement===false?'Not accepted':'Not recorded');addField(list,'Improvement terms',record.choices.improvement_text);}
 addField(list,'Document fingerprint',record.document_sha256);card.append(list);
 if(record.notice)card.append(text('p',record.notice));
 const details=document.createElement('details');details.append(text('summary','Read the agreement version I accepted'));
 const frame=document.createElement('iframe');frame.setAttribute('sandbox','');frame.referrerPolicy='no-referrer';frame.title=record.title+' — accepted version';frame.loading='lazy';
 if(record.document_url&&/^\/consent\?version=[a-f0-9]{64}$/.test(record.document_url)){
   frame.src=record.document_url;const link=document.createElement('a');link.href=record.document_url;link.target='_blank';link.rel='noopener noreferrer';link.textContent='Open accepted document in a new tab';details.append(link);
 }else if(record.kind==='TESTER'&&typeof record.document_html==='string'){
   frame.srcdoc='<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><style>body{font:16px/1.6 system-ui;padding:15px}</style></head><body>'+record.document_html+'</body></html>';
 }else{details.append(text('p','The accepted document needs support review.'));card.append(details);return card;}
 details.append(frame);card.append(details);return card;
}
async function load(){
 if(busy)return;busy=true;$('refresh').disabled=true;$('records').replaceChildren();$('status').textContent='Loading your saved agreements…';$('coverage').textContent='';
 try{
  const params=new URLSearchParams(location.hash.slice(1)),ticket=params.get('ticket');
  // Remove the handoff before any further navigation or resource interaction.
  if(location.hash)history.replaceState(null,'',location.pathname);
  if(ticket){const exchanged=await request('/api/session/exchange',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ticket})});if(exchanged.ok!==true)throw new Error('Sign-in could not be confirmed.');}
  const result=await request('/api/session/agreements');
  if(result.ok!==true||!Array.isArray(result.records)||!Array.isArray(result.issues))throw new Error('The saved agreement response is incomplete.');
  for(const record of result.records)$('records').append(render(record));
  for(const issue of result.issues){const p=text('p',issue.message);p.className='error';$('records').append(p);}
  $('status').textContent=result.records.length?result.records.length+' saved agreement record(s).':'No saved agreements were found for this signed-in account.';
  $('coverage').textContent=result.coverage_note||'';
 }catch(error){$('status').textContent=error.message;$('status').className='error';}
 finally{busy=false;$('refresh').disabled=false;}
}
$('refresh').addEventListener('click',load);load();
})();
