import {webMethod,Permissions} from 'wix-web-module';
import {checkWixSalesReadiness,syncWixSalesRecords} from 'backend/pxWixSales';
import {commerceCall} from 'backend/songCommerce';
export const checkSalesRecords=webMethod(Permissions.Admin,async()=>{
  const readiness=await checkWixSalesReadiness();
  const data=await commerceCall('wix-backend','SALES_RECORDS',{},true);
  return {readiness,records:data.sales.map(r=>({reference:r.source_key,kind:r.kind,amountCad:r.amount_minor/100,currency:r.currency,fulfilled:r.fulfilled})),issues:data.issues,noChanges:true};
});
export const reconcileSalesRecords=webMethod(Permissions.Admin,async()=>syncWixSalesRecords());
