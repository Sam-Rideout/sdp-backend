'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..');
const selection='12345678-1234-4123-8123-123456789abc';
const clip='abcdef01-1234-4123-8123-123456789abc';
const saved={ok:true,selection_id:selection,choice:'RECORDED',audio_available:true,clip_id:clip};
function fixture(initial={ok:true,choice:'NONE',locked:false}) {
  const nodes=new Map(),events={},requests=[],navigation=[];
  let processAudio,clock=0,tick,reply=async()=>saved,closed=0;
  function node(id){if(!nodes.has(id))nodes.set(id,{checked:false,disabled:false,hidden:false,textContent:'',src:'',load(){},play:async()=>{},removeAttribute(k){this[k]=''},getAttribute(k){return this[k]},addEventListener(name,fn){events[id+':'+name]=fn}});return nodes.get(id);}
  class AudioContext {
    sampleRate=24000;destination={};
    async resume(){} async close(){closed++;}
    createMediaStreamSource(){return {connect(){},disconnect(){}};}
    createScriptProcessor(){return {set onaudioprocess(fn){processAudio=fn},connect(){},disconnect(){}};}
  }
  const ctx={console,Blob,FormData,DataView,ArrayBuffer,Float32Array,URLSearchParams,
    URL:{createObjectURL:()=> 'blob:synthetic',revokeObjectURL(){}},
    location:{search:'?selection='+selection,hash:'',assign:u=>navigation.push(u)},
    document:{getElementById:node,addEventListener:(n,fn)=>events[n]=fn},
    window:{AudioContext,addEventListener:(n,fn)=>events[n]=fn},
    navigator:{mediaDevices:{getUserMedia:async()=>({getTracks:()=>[{stop(){}}]})}},
    performance:{now:()=>clock},setInterval:fn=>{tick=fn;return 1},clearInterval(){},
    confirm:()=>true,
    fetch:async(url,options={})=>{requests.push({url,options});const data=options.method==='POST'?await reply():initial;return {ok:true,json:async()=>data}}};
  vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(root,'public/personal-message-v2.js'),'utf8'),ctx);
  const run=code=>vm.runInContext(code,ctx);
  return {ctx,node,events,requests,navigation,run,closed:()=>closed,
    init:()=>events.DOMContentLoaded(),reply:fn=>reply=fn,
    begin:async()=>{node('consent').checked=true;await run('start()')},
    feed(n,value=.1){const input=new Float32Array(n).fill(value);processAudio({inputBuffer:{getChannelData:()=>input},outputBuffer:{getChannelData:()=>new Float32Array(n)}})},
    tick(ms){clock=ms;tick()},
    finish:()=>run('stopPromise'),posts:()=>requests.filter(r=>r.options.method==='POST')};
}
async function speech(f){await f.begin();f.feed(2048);f.feed(2048);}
test('Stop automatically saves once, releases microphone, and enables Next only after confirmation',async()=>{
 const f=fixture();await f.init();let resolve;f.reply(()=>new Promise(r=>resolve=r));await speech(f);
 const saving=f.run('stop(false)');await new Promise(setImmediate);
 assert.equal(f.posts().length,1);assert.equal(f.node('next').disabled,true);assert.equal(f.closed(),1);
 f.run('next()');assert.equal(f.navigation.length,0);f.run('stop(true)');assert.equal(f.posts().length,1);
 resolve(saved);await saving;assert.equal(f.node('next').disabled,false);assert.match(f.node('status').textContent,/saved automatically/);
 assert.equal(f.posts()[0].options.body.get('consent_version'),'order-message-only-2026-10-15-v1');
 assert.ok(Number(f.posts()[0].options.body.get('duration_seconds'))<=8);
 f.run('next()');assert.equal(f.navigation.length,1);
});
test('silence after speech automatically stops and saves without a Save click',async()=>{
 const f=fixture();await f.init();await speech(f);f.feed(24000,0);await f.finish();
 assert.equal(f.posts().length,1);assert.equal(f.node('next').disabled,false);
});
test('sample cap saves the eight-second take at natural speed instead of discarding it',async()=>{
 const f=fixture();await f.init();await speech(f);f.feed(192000);await f.finish();
 assert.equal(f.posts().length,1);assert.equal(Number(f.posts()[0].options.body.get('duration_seconds')),8);
 assert.equal(f.posts()[0].options.body.get('audio').size,44+192000*2);
 assert.match(f.node('status').textContent,/last words are complete/);
});
test('wall-clock cap and simultaneous Stop share a single save',async()=>{
 const f=fixture();await f.init();await speech(f);f.tick(8000);const pending=f.finish();f.run('stop(false)');await pending;
 assert.equal(f.posts().length,1);assert.equal(f.node('next').disabled,false);
});
test('failed automatic save preserves the preview, blocks Next, and supports single retry',async()=>{
 const f=fixture(saved);await f.init();f.reply(async()=>{throw Error('Offline')});await speech(f);await f.run('stop(false)');
 assert.equal(f.run('needsSave'),true);assert.equal(f.node('retrySave').hidden,false);assert.equal(f.node('player').src,'blob:synthetic');
 f.run('next()');assert.equal(f.navigation.length,0);assert.equal(f.node('next').disabled,true);
 const original=f.posts()[0].options.body.get('audio');f.reply(async()=>saved);await f.run('retry()');
 assert.equal(f.posts().length,2);assert.deepEqual(await f.posts()[1].options.body.get('audio').arrayBuffer(),await original.arrayBuffer());
 assert.equal(f.run('needsSave'),false);assert.equal(f.node('retrySave').hidden,true);assert.equal(f.node('next').disabled,false);
});
test('missing consent prevents recording and retry explains consent without losing audio',async()=>{
 const f=fixture();await f.init();await f.run('start()');assert.equal(f.run('recording'),false);assert.equal(f.posts().length,0);
 f.reply(async()=>{throw Error('Offline')});await speech(f);await f.run('stop()');f.node('consent').checked=false;await f.run('retry()');
 assert.equal(f.posts().length,1);assert.match(f.node('status').textContent,/Approve the message consent/);assert.equal(f.run('needsSave'),true);
});
test('silence-only take does not replace an existing saved message',async()=>{
 const f=fixture(saved);await f.init();await f.begin();f.feed(4000,0);await f.run('stop()');
 assert.equal(f.posts().length,0);assert.equal(f.run('savedState.clip_id'),clip);assert.equal(f.node('next').disabled,false);
});
test('unmatched save response cannot authorize Next; leaving unsaved audio warns',async()=>{
 const f=fixture();await f.init();f.reply(async()=>({...saved,selection_id:'different'}));await speech(f);await f.run('stop()');
 assert.equal(f.run('needsSave'),true);assert.equal(f.node('next').disabled,true);
 let warned=false;f.events.beforeunload({preventDefault(){warned=true}});assert.equal(warned,true);
});
test('locked message cannot record; skip still saves an explicit choice and returns to orders',async()=>{
 const locked=fixture({...saved,locked:true});await locked.init();await locked.begin();assert.equal(locked.run('recording'),false);
 const f=fixture();await f.init();f.reply(async()=>({ok:true}));await f.run('skip()');
 assert.match(f.posts()[0].url,/\/skip$/);assert.equal(f.navigation[0],'https://www.sdpsongs.ca/orders');
});
test('Next is the only highlighted action and the obsolete Save step is removed',()=>{
 const html=fs.readFileSync(path.join(root,'public/personal-message-v2.html'),'utf8');
 assert.match(html,/<button id="next" class="full primary" disabled>/);
 assert.equal((html.match(/class="[^"]*primary/g)||[]).length,1);
 assert.doesNotMatch(html,/id="save"|Stop and Review|will be discarded/);
 assert.match(html,/personal-message-v2.js\?v=20261122-autosave-1/);
});
