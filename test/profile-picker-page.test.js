'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../wix/Song_Catalog_Item_Page.js'),'utf8').replace(/^import .*;$/gm,'');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
async function page(overrides={}){
 let logged=true, login,logout,item={_id:'catalog-one',pxSongId:'PX000320'},changeIndex;
 const calls=[],navigation=[];
 const button={disable(){this.disabled=true;},enable(){this.disabled=false;},onClick(fn){this.click=fn;}};
 const picker={options:[],disable(){this.disabled=true;},enable(){this.disabled=false;},onChange(fn){this.change=fn;}};
 const status={text:''};const dataset={getCurrentItem:()=>item,onReady:fn=>fn(),onCurrentIndexChanged:fn=>changeIndex=fn};
 const elements={'#chooseSongButton':button,'#voiceProfileDropdown':picker,'#songSelectionStatus':status,'#dynamicDataset':dataset};
 const $w=id=>elements[id];$w.onReady=fn=>fn();
 const result={status:'READY',defaultVoiceProfileId:'Two',profiles:[{voiceProfileId:'Two',label:'Voice profile 1',status:'READY',selectable:true},{voiceProfileId:'One',label:'Voice profile 2',status:'READY',selectable:true}]};
 const context={$w,console:{error(){}},encodeURIComponent,Date,authentication:{loggedIn:()=>logged,promptLogin:async()=>{},onLogin:fn=>login=fn,onLogout:fn=>logout=fn},wixLocationFrontend:{to:url=>navigation.push(url)},issueVoiceCaptureTicket:async()=>({ticket:'capture-ticket'}),getVoiceProfileStatus:async()=>result,createSongSelectionRequest:async()=>({requestId:'a'.repeat(48)}),selectSong:async(...args)=>{calls.push(args);return {ok:true,status:'SELECTED',voiceProfileId:args[2],selectionId:'10000000-0000-4000-8000-000000000001',pxSongId:'PX000320'};},...overrides};
 vm.runInNewContext(source,context);await flush();
 return {button,picker,status,calls,navigation,result,logout(){logged=false;logout();},login(){logged=true;login();},changeSong(){item={_id:'catalog-two',pxSongId:'PX000321'};changeIndex();}};
}
test('page lists available profiles and sends the chosen ID to selection',async()=>{
 const p=await page();assert.equal(p.picker.options.length,2);assert.equal(p.picker.value,'Two');
 p.picker.value='One';p.picker.change();await p.button.click();assert.equal(p.calls[0][2],'One');assert.equal(p.navigation.length,1);
});
test('logout clears all profile choices and disables the picker',async()=>{
 const p=await page();p.logout();assert.equal(p.picker.options.length,0);assert.equal(p.picker.disabled,true);assert.equal(p.button.label,'Sign In to Choose');
});
test('account change while request token is pending cannot save a song',async()=>{
 let release;const p=await page({createSongSelectionRequest:()=>new Promise(resolve=>release=resolve)});
 const click=p.button.click();p.logout();release({requestId:'a'.repeat(48)});await click;assert.equal(p.calls.length,0);assert.equal(p.navigation.length,0);
});
test('dataset change while request token is pending cannot save the old song',async()=>{
 let release;const p=await page({createSongSelectionRequest:()=>new Promise(resolve=>release=resolve)});
 const click=p.button.click();p.changeSong();release({requestId:'a'.repeat(48)});await click;assert.equal(p.calls.length,0);assert.equal(p.navigation.length,0);
});
test('profile choice is held while saving, and mismatched response cannot navigate',async()=>{
 let release;const p=await page({selectSong:()=>new Promise(resolve=>release=resolve)});
 const click=p.button.click();await flush();assert.equal(p.picker.disabled,true);
 p.picker.value='One';p.picker.change();assert.equal(p.picker.value,'Two');
 release({ok:true,status:'SELECTED',voiceProfileId:'One',selectionId:'10000000-0000-4000-8000-000000000001',pxSongId:'PX000320'});
 await click;assert.equal(p.navigation.length,0);
});
