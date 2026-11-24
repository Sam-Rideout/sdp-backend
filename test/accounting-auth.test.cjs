const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {attach}=require('../song-commerce-routes');
async function fixture(t){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'px-accounting-auth-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const routes=new Map(),app={post:(url,...handlers)=>routes.set(url,handlers),get:(url,...handlers)=>routes.set(url,handlers)};
 attach(app,{dataDir:directory,config:{enabled:true,public_processing:true},transferAuth:()=>{},express:{raw:()=>()=>{}},verifySigned:x=>x,consumeTicket:async()=>true});
 return async(endpoint,ticket)=>{let error,body;const response={set:()=>response,json:x=>{body=x;return response;}};await routes.get(endpoint).at(-1)({body:{ticket}},response,e=>error=e);return {error,body};};
}
function ticket(purpose,sub='wix-backend'){const now=Math.floor(Date.now()/1000);return {iss:'wix',aud:'project-x-commerce',purpose,sub,iat:now,exp:now+60,jti:crypto.randomBytes(24).toString('hex'),operation:'SALES_RECORDS'};}
test('anonymous and ordinary member requests cannot export every buyer sales record',async t=>{const run=await fixture(t);assert.ok((await run('/api/wix/song-commerce-event',null)).error);assert.ok((await run('/api/wix/song-commerce',ticket('member-operation','member-one'))).error);});
test('a signed event for a different principal cannot export sales',async t=>{const run=await fixture(t);assert.ok((await run('/api/wix/song-commerce-event',ticket('provider-event','member-one'))).error);});
test('only the authenticated Wix backend provider operation can read the export',async t=>{const run=await fixture(t),r=await run('/api/wix/song-commerce-event',ticket('provider-event'));assert.equal(r.error,undefined);assert.equal(r.body.result.schema_version,'PX-WIX-SALES-1.0');assert.deepEqual(r.body.result.sales,[]);});
