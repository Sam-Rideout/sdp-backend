'use strict';
// These historical prices are used only for requests made before live quotes.
const LEGACY = Object.freeze({VOICE_CLONE:2399,ORIGINAL_MESSAGE:1399,ORIGINAL_ONLY:899});
function demand(ok,message){if(!ok){const e=new Error(message);e.status=503;throw e;}}
const amount=n=>Number.isSafeInteger(n)&&n>0&&n<=10000000;
const FIELDS=['schema_version','owner','selection_id','product','amount_minor','currency','tax_included','quoted_at'];
const canonical=q=>Object.fromEntries(Object.keys(q).sort().map(key=>[key,q[key]]));
function sameQuote(a,b){
  if(a===undefined||b===undefined)return a===b;
  return !!a&&!!b&&JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
}
function validate(q,owner,selection,product){
  demand(q&&typeof q==='object'&&!Array.isArray(q)&&Object.keys(q).length===FIELDS.length
    &&FIELDS.every(key=>Object.hasOwn(q,key))&&q.schema_version==='PX-PRICE-QUOTE-1.0'&&q.owner===owner&&q.selection_id===selection
    &&q.product===product&&Object.hasOwn(LEGACY,product)&&q.currency==='CAD'&&q.tax_included===true
    &&amount(q.amount_minor)&&typeof q.quoted_at==='string'&&Number.isFinite(Date.parse(q.quoted_at)),
    'The saved song price could not be confirmed.');
  return q.amount_minor;
}
function fromTicket(a,product){
  const catalog=a.pricing_catalog;
  if(catalog===undefined){
    demand(process.env.PX_LIVE_PRICING_ENABLED!=='true','Live pricing is unavailable. Refresh before trying again.');
    return null;
  }
  demand(catalog.schema_version==='PX-PUBLIC-PRICING-1.0'&&catalog.currency==='CAD'&&catalog.tax_included===true,
    'The product catalog could not be confirmed.');
  const q={schema_version:'PX-PRICE-QUOTE-1.0',owner:a.sub,selection_id:a.selection_id,product,
    amount_minor:catalog.products?.[product]?.amountMinor,currency:'CAD',tax_included:true,
    quoted_at:new Date().toISOString()};
  validate(q,a.sub,a.selection_id,product);return canonical(q);
}
function reviewAmount(r){
  return r.pricing_quote===undefined?LEGACY[r.product]:validate(r.pricing_quote,r.owner,r.selection_id,r.product);
}
module.exports={LEGACY,amount,validate,fromTicket,reviewAmount,canonical,sameQuote};
