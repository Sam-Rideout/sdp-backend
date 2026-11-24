// Private shared reader. There is no browser-supplied price or plan ID.
import wixData from 'wix-data';
import { plans } from 'wix-pricing-plans.v2';
import { elevate } from 'wix-auth';
import { SONG_PLANS } from 'backend/songPlanConfig';

const getPlan = elevate(plans.getPlan);
const PRODUCT_KEYS = ['VOICE_CLONE', 'ORIGINAL_MESSAGE', 'ORIGINAL_ONLY'];
function requireValue(ok) {
  if (!ok) throw new Error('Product pricing is temporarily unavailable. Please try again shortly.');
}
export function minorPrice(value) {
  requireValue((typeof value === 'number' || typeof value === 'string') &&
    /^\d{1,5}(\.\d{1,2})?$/.test(String(value)));
  const n = Math.round(Number(value) * 100);
  requireValue(Number.isSafeInteger(n) && n > 0 && n <= 10000000);
  return n;
}
export function effectiveOffer(row) {
  const regularAmountMinor=minorPrice(row.priceCad);
  requireValue(row.saleEnabled===undefined || typeof row.saleEnabled==='boolean');
  if(row.saleEnabled!==true)return {amountMinor:regularAmountMinor,regularAmountMinor,onSale:false};
  const amountMinor=minorPrice(row.salePriceCad);
  requireValue(amountMinor<regularAmountMinor);
  return {amountMinor,regularAmountMinor,onSale:true};
}
export async function readSongPrices() {
  const result = await wixData.query('PXProductPricing').limit(100)
    .find({ suppressAuth: true, consistentRead: true });
  requireValue(!result.hasNext() && result.items.length === PRODUCT_KEYS.length);
  const products = {};
  for (const key of PRODUCT_KEYS) {
    const matches = result.items.filter(row => row.productKey === key);
    requireValue(matches.length === 1 && matches[0].enabled === true &&
      typeof matches[0].title === 'string' && matches[0].title.trim().length > 0 &&
      matches[0].title.length <= 100);
    products[key] = { name: matches[0].title.trim(), ...effectiveOffer(matches[0]) };
  }
  return { schema_version: 'PX-PUBLIC-PRICING-1.0', currency: 'CAD', tax_included: true, products };
}
export async function readMonthlyPlans() {
  const entries = await Promise.all(Object.entries(SONG_PLANS).map(async ([key, configured]) => {
    const p = await getPlan(configured.planId);
    const pricing = p?.pricing;
    const cycle = pricing?.subscription?.cycleDuration;
    requireValue(p?._id === configured.planId && p.archived !== true &&
      pricing?.price?.currency === 'CAD' && cycle?.unit === 'MONTH' && cycle.count === 1 &&
      !pricing.freeTrialDays && !pricing.subscription.cycleCount);
    return [key, { planId: configured.planId, name: p.name, credits: configured.credits,
      amountMinor: minorPrice(pricing.price.value) }];
  }));
  return Object.fromEntries(entries);
}
export async function readCreditBundles() {
  const result = await wixData.query('PXCreditBundles').limit(100)
    .find({ suppressAuth: true, consistentRead: true });
  requireValue(!result.hasNext() && result.items.length === 1);
  const row=result.items[0];
  requireValue(row.bundleKey==='TWENTY' && row.credits===20 && row.enabled===true &&
    typeof row.title==='string' && row.title.trim() && row.title.length<=100);
  return {TWENTY:{name:row.title.trim(),credits:20,...effectiveOffer(row),oneTime:true}};
}
export async function readPublicPricing() {
  const [catalog, monthly, bundles] = await Promise.all([readSongPrices(), readMonthlyPlans(), readCreditBundles()]);
  return { ...catalog, plans: monthly, bundles };
}
