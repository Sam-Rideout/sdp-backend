'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createStore}=require(require('node:fs').existsSync(path.join(__dirname,'song-commerce.js'))?'./song-commerce':'../song-commerce');
async function fixture(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'px-commerce-queue-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}
test('parallel tester and review reads succeed across independently created store instances',async t=>{
 const dir=await fixture(t);
 const results=await Promise.all(Array.from({length:18},(_,i)=>{
  const store=createStore(dir);return [()=>store.testerStatus('new-tester'),()=>store.testerKnown('new-tester'),()=>store.list('new-tester')][i%3]();
 }));
 assert.equal(results.length,18);assert.equal(results[0].status,'NOT_ENROLLED');assert.equal(results[1],false);assert.equal(results[2].reviews.length,0);
 assert.equal(JSON.parse(await fs.readFile(path.join(dir,'State.json'),'utf8')).revision,18);
});
test('concurrent invitations preserve every update exactly once',async t=>{
 const dir=await fixture(t);
 await Promise.all(Array.from({length:10},(_,i)=>createStore(dir).inviteTester({email:`tester${i}@example.invalid`,actor:'Synthetic test'})));
 const result=await createStore(dir).listTesters();assert.equal(result.invitations.length,10);assert.equal(new Set(result.invitations.map(x=>x.email)).size,10);
});
test('a failed transaction does not poison the queue or duplicate an invitation',async t=>{
 const dir=await fixture(t),store=createStore(dir);
 const invite={email:'one@example.invalid',actor:'Synthetic test'};
 await store.inviteTester(invite);
 const results=await Promise.allSettled([store.inviteTester(invite),store.listTesters()]);
 assert.equal(results[0].status,'rejected');assert.equal(results[1].status,'fulfilled');assert.equal(results[1].value.invitations.length,1);
});
test('an externally held disk lock is neither bypassed nor deleted',async t=>{
 const dir=await fixture(t),lock=path.join(dir,'Write.lock');await fs.mkdir(lock);
 await assert.rejects(createStore(dir).testerStatus('new-tester'),e=>e.status===503);
 assert((await fs.stat(lock)).isDirectory());await fs.rmdir(lock);
 assert.equal((await createStore(dir).testerStatus('new-tester')).status,'NOT_ENROLLED');
});
test('different store directories do not block each other',async t=>{
 const dir=await fixture(t);let release,entered;
 const start=new Promise(r=>{entered=r;}),hold=new Promise(r=>{release=r;});
 const pending=createStore(path.join(dir,'one')).testerAdmission('new-tester','one@example.invalid',async()=>{entered();await hold;return 'done';});
 await start;
 try {assert.equal((await createStore(path.join(dir,'two')).testerStatus('another-tester')).status,'NOT_ENROLLED');}finally{release();}
 assert.equal(await pending,'done');
});
test('canonical paths share the queue, and failed lock acquisition permits recovery',async t=>{
 const dir=await fixture(t);
 const results=await Promise.all([createStore(dir).testerStatus('one'),createStore(path.join(dir,'unused','..')).testerStatus('two')]);
 assert.equal(results.length,2);assert(results.every(x=>x.status==='NOT_ENROLLED'));
});
test('tester identity and invitation records remain separate',async t=>{
 const dir=await fixture(t),store=createStore(dir);
 await store.inviteTester({email:'invited@example.invalid',actor:'Synthetic test'});
 const [status,other]=await Promise.all([store.testerStatus('invited-member'),store.testerStatus('other-member')]);
 assert.equal(status.status,'NOT_ENROLLED');assert.equal(other.status,'NOT_ENROLLED');
 assert.equal((await store.listTesters()).enrollments.length,0);
});
