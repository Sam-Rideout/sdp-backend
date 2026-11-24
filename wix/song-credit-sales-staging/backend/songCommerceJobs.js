import {reconcileSongSubscriptions,drainCommerceOutbox} from 'backend/songCommerce';
import {syncWixSalesRecords} from 'backend/pxWixSales';
async function accounting(){
  try{return await syncWixSalesRecords();}
  catch(error){console.warn('Project X Wix Orders accounting needs review.');return {state:'REVIEW_REQUIRED'};}
}
// Existing job names and schedules are retained. Accounting does not govern delivery.
export async function reconcileMonthlySongCredits(){
  const result=await reconcileSongSubscriptions();return {...result,accounting:await accounting()};
}
export async function retrySongPaymentEvents(){
  const result=await drainCommerceOutbox();return {...result,accounting:await accounting()};
}
