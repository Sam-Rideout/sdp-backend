"use strict";

// Dedicated browser recorder. Uses the EXISTING Project X message API only.
const PX_RATE = 24000;
const PX_LIMIT = 8;
const PX_CONSENT = "order-message-only-2026-10-15-v1";
const PX_ORDERS_URL = "https://www.sdpsongs.ca/orders";
const PX_SELECTION = new URLSearchParams(location.search).get("selection");
const PX_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const PX_BASE = PX_SELECTION && PX_UUID.test(PX_SELECTION)
  ? "/api/birthday-message/" + encodeURIComponent(PX_SELECTION) : null;
const el = id => document.getElementById(id);

let access = false;
let locked = true;
let busy = false;
let recording = false;
let starting = false;
let stopPromise = null;
let context = null;
let stream = null;
let source = null;
let processor = null;
let timer = null;
let startedAt = 0;
let sampleRate = 0;
let chunks = [];
let count = 0;
let savedState = null;
let previewBlob = null;
let previewDuration = 0;
let previewUrl = null;
let needsSave = false;

function status(message) { el("status").textContent = message; }
function clock(n) { return "00:" + String(Math.min(8,Math.max(0,Math.floor(n)))).padStart(2,"0"); }
function showTime(seconds) { el("timer").textContent = clock(seconds) + " / 00:08"; }
function buttonState() {
  const ready = access && !locked && !busy && !recording && !starting;
  const existing = Boolean(savedState?.audio_available && savedState?.clip_id);
  const playable = Boolean(previewBlob || existing);
  el("consent").disabled = !ready;
  el("start").disabled = !ready;
  el("stop").disabled = !recording || busy;
  el("rerecord").hidden = !playable;
  el("rerecord").disabled = !ready;
  el("play").hidden = !playable;
  el("play").disabled = !playable || recording || starting;
  el("skip").disabled = !ready;
  el("next").disabled = busy || recording || starting;
  el("retrySave").hidden = !needsSave;
  el("retrySave").disabled = !needsSave || !ready;
  el("player").hidden = !playable;
}
async function api(url, options = {}) {
  const response = await fetch(url, {credentials:"same-origin", ...options});
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `Project X request failed (${response.status}).`);
  }
  return data;
}
function savedAudioUrl(s) {
  return PX_BASE + "/audio/" + encodeURIComponent(s.clip_id);
}
function displaySaved(s, message) {
  savedState = s;
  if (!previewBlob) {
    if (s.audio_available && s.clip_id) {
      el("player").src = savedAudioUrl(s);
      showTime(Number(s.duration_seconds) || 0);
    } else {
      el("player").removeAttribute("src");
      el("player").load();
      showTime(0);
    }
  }
  if (message) status(message);
  buttonState();
}
async function connect() {
  if (!PX_BASE) throw new Error("Invalid song selection. Return to My Orders.");
  const ticket = new URLSearchParams(location.hash.slice(1)).get("ticket");
  if (ticket) {
    history.replaceState(null, "", location.pathname + location.search);
    await api("/api/session/exchange", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body:JSON.stringify({ticket})
    });
  }
  const state = await api(PX_BASE);
  el("songId").textContent = "Song ID: " + (state.song_id || PX_SELECTION);
  if (state.consent_version && state.consent_version !== PX_CONSENT) {
    throw new Error("Message consent has changed. Please contact Project X.");
  }
  access = true;
  locked = Boolean(state.locked);
  displaySaved(state,
    locked ? "This song is locked for processing. You can listen to an existing message."
      : state.audio_available ? "Your saved message is ready. You may listen or replace it."
      : state.choice === "SKIPPED" ? "You previously chose to skip the message. You can still record one while the order is open."
      : "Ready. Check consent, then start recording, or continue without a message.");
}
function makeWav(samples) {
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(bytes);
  const tag = (at,s) => { for (let i=0;i<s.length;i++) view.setUint8(at+i,s.charCodeAt(i)); };
  tag(0,"RIFF"); view.setUint32(4,bytes.byteLength-8,true); tag(8,"WAVE");
  tag(12,"fmt "); view.setUint32(16,16,true); view.setUint16(20,1,true);
  view.setUint16(22,1,true); view.setUint32(24,PX_RATE,true);
  view.setUint32(28,PX_RATE*2,true); view.setUint16(32,2,true);
  view.setUint16(34,16,true); tag(36,"data"); view.setUint32(40,samples.length*2,true);
  for (let i=0;i<samples.length;i++) {
    const s=Math.max(-1,Math.min(1,samples[i]));
    view.setInt16(44+i*2,s<0?Math.round(s*32768):Math.round(s*32767),true);
  }
  return new Blob([bytes],{type:"audio/wav"});
}
// Preserve natural speech rate. Only trim sufficiently quiet boundaries, never time-compress.
function trimBoundarySilence(samples, rate) {
  const windowSamples=Math.max(1,Math.round(rate*.01));
  const minVoiceRms=.007; // approximately -43 dBFS; deliberately conservative
  const frames=Math.ceil(samples.length/windowSamples);
  let first=-1,last=-1;
  for(let f=0;f<frames;f++){
    const begin=f*windowSamples,end=Math.min(samples.length,begin+windowSamples);
    let power=0;
    for(let i=begin;i<end;i++)power+=samples[i]*samples[i];
    const rms=Math.sqrt(power/(end-begin));
    if(rms>=minVoiceRms){if(first<0)first=f;last=f;}
  }
  if(first<0)return samples; // silence or very quiet speech: keep original
  const padding=Math.round(rate*.12);
  const begin=Math.max(0,first*windowSamples-padding);
  const end=Math.min(samples.length,(last+1)*windowSamples+padding);
  // Avoid aggressive changes on barely audible recordings.
  if(end-begin < rate*.2)return samples;
  return samples.subarray(begin,end);
}
function resample(samples, inputRate) {
  if(inputRate===PX_RATE)return samples;
  const n=Math.max(1,Math.round(samples.length*PX_RATE/inputRate));
  const output=new Float32Array(n);
  for(let i=0;i<n;i++){
    const at=i*inputRate/PX_RATE;
    const a=Math.min(samples.length-1,Math.floor(at));
    const b=Math.min(samples.length-1,a+1);
    const frac=at-a;
    output[i]=samples[a]*(1-frac)+samples[b]*frac;
  }
  return output;
}
async function releaseMic() {
  if(timer!==null){clearInterval(timer);timer=null;}
  if(processor){processor.onaudioprocess=null;try{processor.disconnect();}catch{}}
  if(source){try{source.disconnect();}catch{}}
  if(stream)stream.getTracks().forEach(t=>t.stop());
  if(context){try{await context.close();}catch{}}
  processor=null;source=null;stream=null;context=null;
}
async function start() {
  if(!access || locked || busy || recording || starting)return;
  if(!el("consent").checked){status("Please approve the message consent before recording.");return;}
  starting=true;
  buttonState();
  status("Requesting microphone access...");
  try{
    if(!navigator.mediaDevices?.getUserMedia)throw new Error("Microphone access is unavailable in this browser.");
    stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true}});
    context=new (window.AudioContext||window.webkitAudioContext)();
    await context.resume();
    sampleRate=context.sampleRate;
    if(!context.createScriptProcessor)throw new Error("This browser does not support this recording method.");
    source=context.createMediaStreamSource(stream);
    processor=context.createScriptProcessor(2048,1,1);
    chunks=[];count=0;
    processor.onaudioprocess=event=>{
      event.outputBuffer.getChannelData(0).fill(0);
      if(!recording)return;
      const input=event.inputBuffer.getChannelData(0);
      const left=Math.max(0,Math.floor(sampleRate*PX_LIMIT)-count);
      const take=Math.min(left,input.length);
      if(take>0){chunks.push(new Float32Array(input.subarray(0,take)));count+=take;}
      if(count>=Math.floor(sampleRate*PX_LIMIT))void stop();
    };
    source.connect(processor);
    processor.connect(context.destination);
    recording=true;
    starting=false;
    startedAt=performance.now();
    buttonState();
    showTime(0);
    status("Recording... Speak naturally. Stop when you're finished.");
    timer=setInterval(()=>{
      if(!recording)return;
      const elapsed=Math.min(PX_LIMIT,(performance.now()-startedAt)/1000);
      showTime(elapsed);
      if(elapsed>=PX_LIMIT)void stop();
    },75);
  }catch(error){
    starting=false;recording=false;
    await releaseMic();
    buttonState();
    status("Microphone unavailable: "+error.message+". Your previously saved message is unchanged.");
  }
}
async function stop() {
  if(stopPromise)return stopPromise;
  if(!recording)return;
  recording=false;
  busy=true;
  buttonState();
  stopPromise=(async()=>{
    try{
      await releaseMic();
      if(count<sampleRate*.1)throw new Error("The message is too short. Please try again.");
      const joined=new Float32Array(count);
      let at=0;for(const block of chunks){joined.set(block,at);at+=block.length;}
      const trimmed=trimBoundarySilence(joined,sampleRate);
      const converted=resample(trimmed,sampleRate);
      const duration=converted.length/PX_RATE;
      if(duration<.1 || duration>8.25)throw new Error("Please record a message of up to 8 seconds.");
      const blob=makeWav(converted);
      if(blob.size>2*1024*1024)throw new Error("Recording exceeds the upload limit.");
      // Replace the browser preview only after a complete valid recording exists.
      if(previewUrl)URL.revokeObjectURL(previewUrl);
      previewBlob=blob;previewDuration=duration;
      previewUrl=URL.createObjectURL(previewBlob);
      el("player").src=previewUrl;
      el("player").load();
      needsSave=true;
      showTime(duration);
      await upload();
    }catch(error){status("Recording could not be saved: "+error.message);}
    finally{chunks=[];count=0;busy=false;stopPromise=null;buttonState();}
  })();
  return stopPromise;
}
async function upload() {
  if(!access || locked || !previewBlob || !el("consent").checked)throw new Error("A consented recording is required.");
  if(previewDuration<.1 || previewDuration>8.25)throw new Error("Invalid message length.");
  const form=new FormData();
  form.append("audio",previewBlob,"personal-message.wav");
  form.append("duration_seconds",String(previewDuration));
  form.append("consent_version",PX_CONSENT);
  status("Saving your personal message...");
  try{
    const result=await api(PX_BASE+"/audio",{method:"POST",headers:{"X-PX-Message":"1"},body:form});
    needsSave=false;
    savedState=result;
    status("Personal message saved successfully. You can listen, re-record, or select Next.");
    return result;
  }catch(error){
    needsSave=true;
    status("Message is recorded but NOT saved. Select Retry Saving Message. "+error.message);
    throw error;
  }
}
async function retry() {
  if(!needsSave || !previewBlob || busy || recording || starting || locked || !access)return;
  busy=true;buttonState();
  try{await upload();}
  catch{/* upload already reports failure and keeps the recording */}
  finally{busy=false;buttonState();}
}
async function skip() {
  if(!access || locked || busy || recording || starting)return;
  if(!confirm("Continue without a personal message? This removes any message previously saved for this song."))return;
  busy=true;buttonState();status("Saving your choice...");
  try{
    await api(PX_BASE+"/skip",{method:"POST",headers:{"X-PX-Message":"1"}});
    needsSave=false;
    status("Personal message skipped. Returning to My Orders...");
    location.assign(PX_ORDERS_URL);
  }catch(error){status("Unable to skip: "+error.message);}
  finally{busy=false;buttonState();}
}
function play() {
  if(recording || starting || busy)return;
  const audio=el("player");
  if(audio.getAttribute("src")){audio.currentTime=0;void audio.play().catch(()=>status("Use the audio player to listen to your message."));}
}
function next() {
  if(busy || recording || starting)return;
  if(needsSave && !confirm("Your new recording has NOT been saved. Leave and discard this unsaved recording?"))return;
  location.assign(PX_ORDERS_URL);
}
function discardObjectUrl() {if(previewUrl)URL.revokeObjectURL(previewUrl);}
document.addEventListener("DOMContentLoaded",async()=>{
  el("start").addEventListener("click",start);
  el("stop").addEventListener("click",()=>{void stop();});
  el("rerecord").addEventListener("click",start);
  el("play").addEventListener("click",play);
  el("retrySave").addEventListener("click",()=>{void retry();});
  el("skip").addEventListener("click",()=>{void skip();});
  el("next").addEventListener("click",next);
  window.addEventListener("pagehide",discardObjectUrl);
  buttonState();
  try{await connect();}
  catch(error){access=false;locked=true;status(error.message);buttonState();}
});
