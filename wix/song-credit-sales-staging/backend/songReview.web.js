import {readPublicPricing,readMonthlyPlans,readCreditBundles} from 'backend/productPricing';
import {readSongJourney} from 'backend/songJourney';
import {webMethod,Permissions} from 'wix-web-module';
import {currentMember} from 'wix-members-backend';
import wixPayBackend from 'wix-pay-backend';
import {orders,checkout} from 'wix-pricing-plans-backend';
import {commerceCall,enqueueCommerce,drainCommerceOutbox,recordPaidCycle} from 'backend/songCommerce';
import {SONG_PLANS} from 'backend/songPlanConfig';

async function memberId() {
  const m=await currentMember.getMember({fieldsets:['FULL']});
  if(!m?._id)throw new Error('Sign in to review your song.');return m._id;
}

export const listSongReviews=webMethod(Permissions.SiteMember,async()=>{
  const owner=await memberId();
  try {
    // Expected closure is data, not an exception crossing the Wix web boundary.
    // Check availability before querying/retrying payment events.
    const result=await commerceCall(owner,'LIST');
    await drainCommerceOutbox();
    let catalog;
    try { catalog=await readPublicPricing(); } catch(error) {
      return {...result,available:true,pricing_unavailable:true,plans:{},products:{}};
    }
    return {...result,available:true,plans:catalog.plans,products:catalog.products,bundles:catalog.bundles};
  } catch(error) {
    if(error?.message==='Song review and checkout are not available yet. Please return to My Orders.') {
      let catalog;
      try { catalog=await readPublicPricing(); } catch(pricingError) { catalog=null; }
      return {available:false,code:'SONG_REVIEW_UNAVAILABLE',
        ...(catalog?{products:catalog.products,plans:catalog.plans,bundles:catalog.bundles}:{}),
        message:'Song review and checkout are not available yet. Please return to My Orders.'};
    }
    throw error; // Do not misreport an actual failure as an empty queue.
  }
});
export const getSongReview=webMethod(Permissions.SiteMember,async(reviewId)=>{
  const owner=await memberId();await drainCommerceOutbox();return commerceCall(owner,'GET',{review_id:reviewId});
});
export const approveWithCredit=webMethod(Permissions.SiteMember,async(reviewId,previewSha256)=>{
  return commerceCall(await memberId(),'APPROVE',{review_id:reviewId,preview_sha256:previewSha256,method:'CREDIT'});
});
export const createSongCheckout=webMethod(Permissions.SiteMember,async(reviewId,previewSha256)=>{
  const owner=await memberId();await drainCommerceOutbox();
  await commerceCall(owner,'APPROVE',{review_id:reviewId,preview_sha256:previewSha256,method:'PAYMENT'});
  const intent=await commerceCall(owner,'RESERVE_PAYMENT',{review_id:reviewId});
  if(!intent.create)return {paymentId:intent.payment_id};
  // Prices originate from the protected order quote, never browser arguments.
  const payment=await wixPayBackend.createPayment({items:[{name:intent.title,price:intent.amount_minor/100,quantity:1}],
    amount:intent.amount_minor/100,currency:'CAD'});
  // If the Render response is lost, this durable binding is retried instead of creating another payment.
  const binding={intent_id:intent.intent_id,payment:{id:payment.id,amount:payment.amount,currency:payment.currency}};
  await enqueueCommerce('BIND_PAYMENT',binding,['BIND_PAYMENT',intent.intent_id],owner,false);
  // Do not open checkout until the payment is bound to the exact approved song.
  const confirmed=await commerceCall(owner,'RESERVE_PAYMENT',{review_id:reviewId});
  if(confirmed.payment_id!==payment.id)throw new Error('Checkout is awaiting reconciliation. Please contact Project X.');
  return {paymentId:payment.id};
});
export const createSongCreditBundleCheckout=webMethod(Permissions.SiteMember,async(bundleKey,expectedAmountMinor)=>{
  const owner=await memberId();await drainCommerceOutbox();
  const bundles=await readCreditBundles(),bundle=bundles[bundleKey];
  if(!bundle || !Number.isSafeInteger(expectedAmountMinor) || bundle.amountMinor!==expectedAmountMinor)
    throw new Error('The bundle price changed. Refresh and review the current price before continuing.');
  const member=await currentMember.getMember();
  if(member?._id!==owner||typeof member.loginEmail!=='string')throw new Error('Your buyer account could not be confirmed.');
  const payload={bundle_key:bundleKey,bundle_price_minor:bundle.amountMinor,bundle_regular_minor:bundle.regularAmountMinor,
    buyer_email:member.loginEmail.trim().toLowerCase()};
  const intent=await commerceCall(owner,'RESERVE_BUNDLE',payload);
  if(!intent.create)return {paymentId:intent.payment_id};
  const payment=await wixPayBackend.createPayment({items:[{name:intent.title,price:intent.amount_minor/100,quantity:1}],
    amount:intent.amount_minor/100,currency:'CAD'});
  await enqueueCommerce('BIND_PAYMENT',{intent_id:intent.intent_id,payment:{id:payment.id,amount:payment.amount,currency:payment.currency}},
    ['BIND_PAYMENT',intent.intent_id],owner,false);
  const confirmed=await commerceCall(owner,'RESERVE_BUNDLE',payload);
  if(confirmed.payment_id!==payment.id)throw new Error('Bundle checkout is awaiting reconciliation. Please contact Project X.');
  return {paymentId:payment.id};
});
export const refreshSongCreditBalance=webMethod(Permissions.SiteMember,async()=>{
  const owner=await memberId();await drainCommerceOutbox();return commerceCall(owner,'LIST');
});

export const refreshPurchasedPlan=webMethod(Permissions.SiteMember,async(orderId)=>{
  const owner=await memberId();
  const order=await orders.getOrder(orderId,{suppressAuth:true});
  if(order.buyer?.memberId!==owner)throw new Error('Subscription not found.');
  await recordPaidCycle(order);await drainCommerceOutbox();return commerceCall(owner,'LIST');
});

function checkedPlanPrice(order,owner,plan,phase){
  const cycle=order?.pricing?.subscription?.cycleDuration;
  // The authoritative cycle prices are in pricing.prices. Wix can omit the
  // older priceDetails object entirely, including on an online preview.
  const prices=Array.isArray(order?.pricing?.prices)?order.pricing.prices:[];
  const applicable=prices.filter(row=>{
    const from=row.duration?.cycleFrom;
    const count=row.duration?.numberOfCycles;
    return Number.isInteger(from)&&from>=1&&from<=1&&
      (count===undefined||(Number.isInteger(count)&&count>0&&from+count>1));
  });
  const price=applicable.length===1?applicable[0].price:undefined;
  const total=price?.total;
  const amount=typeof total==='string'&&total.trim()!==''?Number(total):
    typeof total==='number'?total:NaN;
  const quotedMinor=Number.isFinite(amount)?Math.round(amount*100):NaN;
  const legacy=order?.priceDetails;
  const checks={
    member:order?.buyer?.memberId===owner,
    plan:order?.planId===plan.planId,
    cyclePrice:applicable.length===1,
    currency:price?.currency==='CAD',
    total:quotedMinor===plan.amountMinor,
    billingPeriod:cycle?.unit==='MONTH',
    billingCount:cycle?.count===1,
    consistentCurrency:legacy?.currency===undefined||legacy.currency===price?.currency,
    consistentTotal:legacy?.total===undefined||
      (Number.isFinite(Number(legacy.total))&&Math.round(Number(legacy.total)*100)===quotedMinor)
  };
  const failed=Object.keys(checks).filter(key=>!checks[key]);
  if(failed.length){
    console.error('Project X monthly checkout verification:',JSON.stringify({
      phase,failed,
      expected:{amountMinor:plan.amountMinor,currency:'CAD',billingUnit:'MONTH',billingCount:1},
      actual:{memberMatches:checks.member,planMatches:checks.plan,
        applicablePrices:applicable.length,total:total??null,currency:price?.currency??null,
        billingUnit:cycle?.unit??null,billingCount:cycle?.count??null}
    }));
    throw new Error('Monthly checkout verification failed: '+failed.join(', ')+'. No payment was started.');
  }
  return {currency:price.currency,total:String(total)};
}

export const createMonthlySongCheckout=webMethod(Permissions.SiteMember,async(planKey,expectedAmountMinor)=>{
  const owner=await memberId();
  const livePlans=await readMonthlyPlans(),plan=livePlans[planKey];
  if(!plan?.planId)throw new Error('Monthly plans are not available yet.');
  if(!Number.isSafeInteger(expectedAmountMinor)||expectedAmountMinor!==plan.amountMinor)
    throw new Error('The monthly price changed. Refresh and review the current terms before continuing.');
  // Wix currently enforces a maximum page size of 50. Check every page
  // before creating checkout so an older active subscription is not missed.
  let checkedAllOrders=false;
  for(let skip=0;skip<1000;skip+=50){
    const existing=await orders.listCurrentMemberOrders(
      {orderStatuses:['ACTIVE','PENDING','PAUSED']},{},{limit:50,skip});
    if(existing.some(o=>o.planId===plan.planId))
      throw new Error('You already have this monthly plan. Manage it below.');
    if(existing.length<50){checkedAllOrders=true;break;}
  }
  if(!checkedAllOrders)throw new Error('Your subscription history requires Project X review.');
  // Preview calls do not create an order or payment. Refuse an extra tax charge before checkout.
  const preview=await checkout.previewOnlineOrder(plan.planId);
  if(preview.purchaseLimitExceeded)throw new Error('This plan cannot be purchased again right now.');
  checkedPlanPrice(preview.order,owner,plan,'PREVIEW');
  const intent=await commerceCall(owner,'RESERVE_PLAN',{plan_key:planKey,plan_price_minor:plan.amountMinor});
  if(intent.amount_minor!==expectedAmountMinor)throw new Error('An earlier subscription checkout has different terms. Please contact Project X before continuing.');
  if(!intent.create)return {orderId:intent.order_id,paymentId:intent.payment_id};
  const order=await checkout.createOnlineOrder(plan.planId);
  const verifiedPrice=checkedPlanPrice(order,owner,plan,'CREATED_ORDER');
  const binding={_id:order._id,planId:order.planId,wixPayOrderId:order.wixPayOrderId,
    buyer:{memberId:order.buyer.memberId},priceDetails:verifiedPrice};
  await enqueueCommerce('BIND_PLAN',{intent_id:intent.intent_id,order:binding},['BIND_PLAN',intent.intent_id],owner,false);
  const bound=await commerceCall(owner,'RESERVE_PLAN',{plan_key:planKey,plan_price_minor:plan.amountMinor});
  if(bound.payment_id!==order.wixPayOrderId)throw new Error('Subscription checkout is awaiting reconciliation.');
  return {orderId:order._id,paymentId:order.wixPayOrderId};
});

export const listMySongPlans=webMethod(Permissions.SiteMember,async()=>{
  await memberId();const result=[];
  for(let skip=0;skip<1000;skip+=50){
    const page=await orders.listCurrentMemberOrders({}, {}, {limit:50,skip});
    for(const order of page){
      if(Object.values(SONG_PLANS).some(p=>p.planId&&p.planId===order.planId))
        result.push({orderId:order._id,name:order.planName,status:order.status,
          renewalStopped:order.autoRenewCanceled===true,
          paidThrough:order.endDate&&Number.isFinite(new Date(order.endDate).getTime())
            ?new Date(order.endDate).toISOString():null,
          canCancel:order.status==='ACTIVE'&&!order.autoRenewCanceled});
    }
    if(page.length<50)return result;
  }
  throw new Error('Your subscription history requires Project X review.');
});

export const cancelMySongPlan=webMethod(Permissions.SiteMember,async(orderId)=>{
  const owner=await memberId();const order=await orders.getOrder(orderId,{suppressAuth:true});
  if(order.buyer?.memberId!==owner||!Object.values(SONG_PLANS).some(p=>p.planId&&p.planId===order.planId))
    throw new Error('Song subscription not found.');
  await orders.requestCurrentMemberOrderCancellation(orderId,'NEXT_PAYMENT_DATE');
  return {requested:true,message:'Renewal cancellation requested for the next payment date. Your paid subscription remains active until the end of the current paid period. Your earned song credits remain usable.'};
});

export const getSongJourney=webMethod(Permissions.SiteMember,async()=>readSongJourney(await memberId()));
