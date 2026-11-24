// Private accounting mirror. No checkout, charging, refunds, or customer email.
import wixData from 'wix-data';
import {orders} from '@wix/ecom';
import {items} from '@wix/data';
import {auth} from '@wix/essentials';
import {createHash,randomBytes} from 'crypto';
import {commerceCall} from 'backend/songCommerce';
const JOURNAL='PXWixOrderSync',SETTINGS='PXSalesSyncConfig';
const OPTIONS={suppressAuth:true,suppressHooks:true,consistentRead:true};
const searchOrders=auth.elevate(orders.searchOrders),importOrder=auth.elevate(orders.importOrder),conditionalUpdate=auth.elevate(items.update);
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const recordId=key=>{const h=hash(['PX-WIX-SALES',key]);return h.slice(0,8)+'-'+h.slice(8,12)+'-5'+h.slice(13,16)+'-a'+h.slice(17,20)+'-'+h.slice(20,32);};
function demand(ok,message){if(!ok)throw new Error(message);}
async function one(collection,id){return (await wixData.query(collection).eq('_id',id).limit(1).find(OPTIONS)).items[0]||null;}
function money(n){demand(Number.isSafeInteger(n)&&n>=0&&n<=10000000,'Unverified order amount.');return {amount:(n/100).toFixed(2)};}
export function makeWixOrder(r){
 demand(r&&typeof r.source_key==='string'&&/^(PX-PAYMENT|PX-SONG):/.test(r.source_key)&&r.currency==='CAD'
  &&typeof r.email==='string'&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email)&&typeof r.owner==='string'
  &&typeof r.title==='string'&&r.title.length<=200&&Number.isFinite(Date.parse(r.purchased_at))
  &&['PAID','FULLY_REFUNDED','PARTIALLY_REFUNDED','PENDING'].includes(r.payment_status),'Unverified sales record.');
 const total=money(r.amount_minor),regular=money(r.regular_amount_minor),discount=money(r.regular_amount_minor-r.amount_minor);
 const line={productName:{original:r.title},quantity:1,itemType:{preset:'SERVICE'},
  price:regular,totalDiscount:discount,totalPriceBeforeTax:total,totalPriceAfterTax:total,
  taxDetails:{taxRate:'0',totalTax:money(0)},paymentOption:r.amount_minor===0?'MEMBERSHIP':'FULL_PAYMENT_ONLINE',
  descriptionLines:[{name:{original:'Project X reference'},plainText:{original:r.order_id||r.source_key}},
   {name:{original:'Payment reference'},plainText:{original:r.payment_id||r.kind}}]};
 const note=['Project X accounting record.',r.kind==='CREDIT_REDEMPTION'?'One song credit used; no new cash payment.':'',r.kind==='PROMOTION'?'Promotional sample; no payment.':'',r.adjustment?'Payment adjustment: '+r.adjustment+'. Reconcile the provider refund details.':'',r.transaction_id?'Transaction '+r.transaction_id:''].filter(Boolean).join(' ');
 return {purchasedDate:new Date(r.purchased_at),channelInfo:{type:'OTHER_PLATFORM',externalOrderId:r.source_key},
  buyerInfo:{memberId:r.owner,email:r.email},billingInfo:{contactDetails:{}},lineItems:[line],currency:'CAD',
  currencyConversionDetails:{originalCurrency:'CAD',conversionRate:'1.00'},taxIncludedInPrices:true,
  priceSummary:{subtotal:regular,shipping:money(0),tax:money(0),discount,total},
  balanceSummary:{balance:money(0),paid:total,...(r.payment_status==='FULLY_REFUNDED'?{refunded:total}:{})},
  status:'APPROVED',paymentStatus:r.payment_status,fulfillmentStatus:r.fulfilled?'FULFILLED':'NOT_FULFILLED',buyerNote:note};
}
function validateImported(order,r){
 demand(order&&order.imported===true&&order.channelInfo?.externalOrderId===r.source_key
  &&order.buyerInfo?.memberId===r.owner&&order.buyerInfo?.email?.toLowerCase()===r.email.toLowerCase()
  &&order.currency==='CAD'&&Math.round(Number(order.priceSummary?.total?.amount)*100)===r.amount_minor,
  'Existing Wix order differs; manual review required.');
}
async function allOrders(){const all=[];let cursor;do{
 const response=await searchOrders({cursorPaging:{limit:100,...(cursor?{cursor}:{})}});
 demand(Array.isArray(response.orders),'Wix Orders search is unavailable.');all.push(...response.orders);
 cursor=response.metadata?.hasNext?response.metadata.cursors?.next:null;
 demand(!response.metadata?.hasNext||cursor,'Wix order search is truncated.');
 }while(cursor);return all;}
async function claim(row,status){
 const claimId=randomBytes(24).toString('hex');
 const result=await conditionalUpdate(JOURNAL,{...row,status,claimId,claimedAt:new Date()},
  {suppressHooks:true,condition:{filter:{status:row.status,sourceHash:row.sourceHash,claimId:row.claimId||''}}});
 demand(result.claimId===claimId,'Accounting reconciliation is busy.');return result;
}
async function saveClaim(row,changes){return conditionalUpdate(JOURNAL,{...row,...changes},
 {suppressHooks:true,condition:{filter:{claimId:row.claimId,status:row.status}}});}
let working=false;
export async function syncWixSalesRecords(){
 if(working)return {state:'BUSY'};working=true;
 try{
  const settings=await one(SETTINGS,'SETTINGS');
  if(settings?.enabled!==true)return {state:'DISABLED'};
  const source=await commerceCall('wix-backend','SALES_RECORDS',{},true);
  demand(source.schema_version==='PX-WIX-SALES-1.0'&&Array.isArray(source.sales)&&source.sales.length<=5000,'Sales export is incomplete or oversized.');
  const existing=await allOrders(),seen=new Map();
  for(const order of existing){const key=order.channelInfo?.externalOrderId;if(key?.startsWith('PX-')){demand(!seen.has(key),'Duplicate Project X order reference requires review.');seen.set(key,order);}}
  let imported=0,updated=0,issues=(source.issues||[]).length,checked=0;
  for(const r of source.sales){
   if(checked>=25)break;
   let row;
   try{
    const id=recordId(r.source_key);row=await one(JOURNAL,id);
    if(!row){
     const fresh={_id:id,sourceKey:r.source_key,sourceHash:r.source_hash,snapshot:r,status:'NEW',claimId:''};
     try{row=await wixData.insert(JOURNAL,fresh,OPTIONS);}catch(e){row=await one(JOURNAL,id);if(!row)throw e;}
    }
    demand(row.sourceKey===r.source_key,'Accounting journal identity differs.');
    const found=seen.get(r.source_key);
    if(row.wixOrderId&&!found){
     // A search index may lag; never recreate a journaled order from absence in search.
     issues++;continue;
    }
    if(found){
     validateImported(found,r);
     if(['IMPORTING','UNCERTAIN','UPDATING'].includes(row.status)){
      // Allow an active worker to finish; recover a stale claim only by conditional ownership.
      if(row.status!=='UNCERTAIN'&&Date.now()-new Date(row.claimedAt).getTime()<300000){issues++;continue;}
      await saveClaim(row,{wixOrderId:found._id||found.id,status:'DONE',sourceHash:row.snapshot.source_hash,claimId:''});continue;
     }
     if(row.status==='DONE'&&row.sourceHash===r.source_hash)continue;
     row=await claim(row,'UPDATING');checked++;
     // Recheck the latest authoritative snapshot after winning the conditional claim.
     const latest=await commerceCall('wix-backend','SALES_RECORDS',{},true);
     const current=latest.sales.find(x=>x.source_key===r.source_key);
     demand(current?.source_hash===r.source_hash,'Sales authority changed during reconciliation.');
     const result=await importOrder({...makeWixOrder(r),_id:found._id||found.id});
     validateImported(result,r);
     await saveClaim(row,{wixOrderId:result._id||result.id,status:'DONE',sourceHash:r.source_hash,snapshot:r,claimId:'',syncedAt:new Date()});updated++;continue;
    }
    if(['IMPORTING','UNCERTAIN','UPDATING'].includes(row.status)){issues++;continue;}
    demand(row.status==='NEW','Accounting journal requires review.');
    row=await claim(row,'IMPORTING');checked++;
    const latest=await commerceCall('wix-backend','SALES_RECORDS',{},true);
    demand(latest.sales.find(x=>x.source_key===r.source_key)?.source_hash===r.source_hash,'Sales authority changed before import.');
    const result=await importOrder(makeWixOrder(r));
    validateImported(result,r);
    await saveClaim(row,{wixOrderId:result._id||result.id,status:'DONE',sourceHash:r.source_hash,snapshot:r,claimId:'',syncedAt:new Date()});
    seen.set(r.source_key,result);imported++;
   }catch(error){
    issues++;
    if(row&&['IMPORTING','UPDATING'].includes(row.status)){
     try{await saveClaim(row,{status:'UNCERTAIN',lastError:String(error.message||'Accounting sync needs review.').slice(0,200)});}catch{}
    }
   }
  }
  return {state:issues?'REVIEW_REQUIRED':'RUNNING',imported,updated,issues,checked:Math.min(checked,25),total:source.sales.length};
 }finally{working=false;}
}
export async function checkWixSalesReadiness(){
 demand(typeof orders.importOrder==='function'&&typeof items.update==='function','Required Wix SDK packages are unavailable.');
 const result=await searchOrders({cursorPaging:{limit:1}});
 demand(Array.isArray(result.orders),'Wix Orders read permissions are unavailable.');
 return {ready:true,orderCountInProbe:result.orders.length,settings:await one(SETTINGS,'SETTINGS'),noChanges:true};
}
