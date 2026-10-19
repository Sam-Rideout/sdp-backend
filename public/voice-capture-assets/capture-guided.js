'use strict';
let guidedView='loading',guidedMicPassed=false,guidedMicBusy=false,guidedCreating=false;
let guidedInitialBrowser=null,guidedSetupReady=false,guidedTestSetupSignature="";
let guidedTestRecorder=null,guidedTestStream=null,guidedTestUrl=null,guidedTestTimer=null,guidedTestGeneration=0;
const guidedCards=['guidedIntro','startCard','guidedMic','captureCard','guidedReview','phoneTrainingCard','progressReturnCard','transferCompleteCard'];
function guidedStatus(message){$('guidedNotice').textContent=message||'';}
function guidedLocked(){return busy||Boolean(takeBlob)||guidedCreating||guidedMicBusy;}
function guidedPauseAudio(){document.querySelectorAll('audio').forEach(player=>player.pause());}
function guidedCanMove(){if(guidedLocked()){setStatus('Finish the current action, or retry or discard the unsaved take before continuing.');return false;}return true;}
function guidedShow(id,force=false){
 if(!force&&!guidedCanMove())return false;
 guidedPauseAudio();guidedCards.forEach(name=>$(name).hidden=name!==id);guidedView=id;
 guidedJourney();$('guidedMain').focus({preventScroll:true});window.scrollTo({top:0,behavior:'auto'});return true;
}
function guidedJourney(){
 const position=['guidedIntro','startCard','guidedMic','loading'].includes(guidedView)?0:guidedView==='captureCard'?1:2;
 $('guidedJourney').innerHTML=['Get ready','Record your voice','Review & finish'].map((s,i)=>`<div class="nav-step ${i===position?'active':i<position?'done':''}" ${i===position?'aria-current="step"':''}><span class="num">${i<position?'✓':'0'+(i+1)}</span><span>${s}<small>${['Consent & microphone setup','One section at a time','Your recordings together'][i]}</small></span></div>`).join('');
}
const setupComplete=()=>Boolean($('setupDevice').value&&$('setupMic').value&&$('setupListening').value);
const setupSignature=()=>[$('setupDevice').value,$('setupMic').value,$('setupListening').value].join('|');
function setupReported(prefix){return {device_type:$(prefix+'Device').value,microphone_type:$(prefix+'Mic').value,listening_setup:$(prefix+'Listening').value};}
function browserAudioMetadata(stream){
 const track=stream?.getAudioTracks?.()[0];const settings=track?.getSettings?.()||{};
 const label=typeof track?.label==='string'?track.label.trim().slice(0,120):'';
 const bounded=(v,min,max)=>Number.isInteger(v)&&v>=min&&v<=max?v:null;
 return {microphone_label:label||null,sample_rate:bounded(settings.sampleRate,8000,192000),channel_count:bounded(settings.channelCount,1,8),echo_cancellation:typeof settings.echoCancellation==='boolean'?settings.echoCancellation:null,noise_suppression:typeof settings.noiseSuppression==='boolean'?settings.noiseSuppression:null,auto_gain_control:typeof settings.autoGainControl==='boolean'?settings.autoGainControl:null};
}
window.PXGetSessionRecordingSetup=()=>({schema_version:'PX-RECORDING-SETUP-1.0',reported:setupReported('setup'),browser:guidedInitialBrowser||{microphone_label:null,sample_rate:null,channel_count:null,echo_cancellation:null,noise_suppression:null,auto_gain_control:null}});
window.PXBuildRecordingSetup=stream=>({schema_version:'PX-RECORDING-SETUP-1.0',reported:setupReported('takeSetup'),browser:browserAudioMetadata(stream)});
window.PXRestoreRecordingSetup=value=>{
 const r=value?.reported,b=value?.browser;if(r&&b){for(const [id,key] of [['setupDevice','device_type'],['setupMic','microphone_type'],['setupListening','listening_setup']])$(id).value=r[key]||'';guidedInitialBrowser=b;}
 for(const [from,to] of [['setupDevice','takeSetupDevice'],['setupMic','takeSetupMic'],['setupListening','takeSetupListening']])$(to).value=$(from).value;
};
function guidedSetupSelectors(){
 if(guidedSetupReady)return;guidedSetupReady=true;
 for(const [from,to] of [['setupDevice','takeSetupDevice'],['setupMic','takeSetupMic'],['setupListening','takeSetupListening']]){
  const target=$(to);if(!target.options.length)target.innerHTML=$(from).innerHTML;
  if(!target.value)target.value=$(from).value;
  $(from).addEventListener('change',()=>{if(guidedTestSetupSignature&&guidedTestSetupSignature!==setupSignature())guidedTestClear();if(!activeSession||activeSession.status!=='RECORDING')$(to).value=$(from).value;guidedConsentUpdate();});
  target.addEventListener('change',()=>{if(target.value)guidedConsentUpdate();});
 }
}
function guidedConsentUpdate(){
 if(!config)return;guidedSetupSelectors();
 document.querySelectorAll('.recording-setup-panel,.recording-setup-details').forEach(el=>{el.hidden=config.recording_setup_enabled!==true;});
 const accepted=config.capture_mode==='LIMITED_HELPER_PILOT'?$('pilotUnderstood').checked:(customerConsentAccepted()&&(config.recording_setup_enabled!==true||setupComplete()));
 $('guidedConsentNext').disabled=!config.capture_enabled||!accepted||guidedLocked();
 $('create').disabled=!config.capture_enabled||!accepted||!guidedMicPassed||guidedLocked();
}
function guidedSessionList(){
 $('startCard').hidden=guidedView!=='startCard';
 $('guidedNoSessions').hidden=!$('existingWrap').hidden;
 $('guidedBegin').disabled=!config?.capture_enabled;
 if(config&&!config.capture_enabled&&!progressReturnMode)setStatus($('setupBlock').textContent||'New recording sessions are not currently available. You can resume an existing session.');
}
function guidedSelected(){
 guidedShow('captureCard',true);guidedLesson(config.sections.find(s=>s.id===Number(activeSectionId)));
}
function guidedProgress(id='phoneTrainingCard'){guidedShow(id,true);}
function guidedResetIntro(){
 guidedTestClear();for(const id of ['ageOwnVoice','deleteAfterOrder','futurePurchases','developmentUse','pilotUnderstood'])$(id).checked=false;guidedInitialBrowser=null;for(const id of ['setupDevice','setupMic','setupListening','takeSetupDevice','takeSetupMic','takeSetupListening'])$(id).value='';
 $('guidedMessageDraft').value='';history.replaceState(null,'',location.pathname);guidedShow('guidedIntro',true);guidedSessionList();syncConsentControls();
}
function guidedLesson(section){
 if(!section)return;
 const message=Number(section.id)===9,lesson=GUIDED_LESSONS[section.id-1];
 $('guidedLessonTitle').textContent=message?'Your personal birthday message':lesson?.title||section.title;
 $('guidedLessonLead').textContent=message?'Add a short, spoken message in your own voice. It will play at the end of the birthday song.':lesson?.lede||'';
 $('guidedTiming').textContent=message?'Optional · up to 8 seconds':lesson?.timing||'';
 $('guidedPrompt').innerHTML=message?'<p>Keep it short, warm and personal. For example:</p><blockquote class="mic-phrase">“Happy birthday! Sending you lots of love on your special day.”</blockquote>':lesson?.prompt||'';
 $('guidedMessageNotice').hidden=!message;$('guidedMessageDraftLabel').hidden=!message;
 $('guidedDemoPanel').hidden=message;
 const demo=$('guidedDemo'),src='/voice-capture-assets/section-'+String(section.id).padStart(2,'0')+'-male.mp3';
 if(!message&&demo.getAttribute('src')!==src){demo.pause();demo.src=src;demo.load();}
 if(message){demo.pause();demo.removeAttribute('src');demo.load();}
 $('guidedDemoLabel').textContent=message?'':'Male reference · Sam’s recording';
 guidedUpdate();
}
function guidedUpdate(){
 const counts=Array.from({length:8},(_,i)=>sessionTakes(i+1).length),count=counts.filter(Boolean).length;
 $('guidedSectionMeter').innerHTML=counts.map((n,i)=>`<span class="${n?'kept':i===activeSectionId-1?'active':''}"></span>`).join('');
 $('guidedSectionMeter').setAttribute('aria-label',count+' of 8 training sections saved');
 const editable=activeSession?.status==='RECORDING',locked=guidedLocked();
 $('guidedNext').disabled=!editable||locked||(activeSectionId<9&&sessionTakes(activeSectionId).length===0);
 $('guidedNext').textContent=activeSectionId===9?(sessionTakes(9).length?'Continue with saved message →':'Continue without a message →'):'Keep saved takes & next →';
 $('guidedPrevious').disabled=locked;$('guidedSections').disabled=locked;
 $('guidedSubmit').disabled=!editable||locked||!allSectionsHaveTakes();
 $('guidedReviewBack').disabled=locked;
 if(guidedView==='guidedReview')guidedRenderReview();
}
function guidedGoSection(id){
 if(!guidedCanMove()||!activeSession)return;
 const target=config.sections.find(s=>s.id===id&&s.configured);if(!target)return;
 activeSectionId=id;$('sectionSelect').value=String(id);showSection(id);guidedShow('captureCard');
}
function guidedOpenSections(){
 if(!guidedCanMove())return;
 const list=$('sectionPickerList'),open=list.hidden;updateReadableSectionPicker();list.hidden=!open;
 $('guidedSections').textContent=open?'Hide sections':'Review sections';
}
function guidedRenderReview(){
 const counts=Array.from({length:8},(_,i)=>sessionTakes(i+1).length),saved=counts.filter(Boolean).length;
 const box=$('guidedReviewSummary');box.replaceChildren();
 const retention=activeSession?.consent?.retention_choice||activeSession?.consent?.retention_policy;
 const choice=retention==='DELETE_AFTER_ORDER'?'Delete after this order':retention==='FUTURE_PURCHASES'?'Keep for future purchases':'See the consent saved with this recording session.';
 for(const text of [saved+' of 8 training sections saved.',sessionTakes(9).length?'Birthday message: '+sessionTakes(9).length+' saved take(s), separate from training.':'Birthday message: not included.', 'Storage choice: '+choice]){const p=document.createElement('p');p.textContent=text;box.appendChild(p);}
 const grid=$('guidedReviewSections');grid.replaceChildren();
 counts.forEach((n,i)=>{const b=document.createElement('button');b.type='button';b.textContent='Section '+(i+1)+' · '+(n?'✓ '+n+' saved take(s)':'Not recorded');b.disabled=guidedLocked();b.addEventListener('click',()=>guidedGoSection(i+1));grid.appendChild(b);});
}
function guidedOpenReview(){if(!guidedCanMove()||!activeSession)return;guidedRenderReview();guidedShow('guidedReview');guidedUpdate();}
function guidedTestRelease(){
 clearTimeout(guidedTestTimer);guidedTestTimer=null;
 if(guidedTestStream)guidedTestStream.getTracks().forEach(t=>t.stop());guidedTestStream=null;
}
function guidedTestClear(){
 guidedTestGeneration++;guidedTestRelease();guidedMicPassed=false;guidedTestSetupSignature='';guidedInitialBrowser=null;
 const p=$('guidedTestPlayer');p.pause();p.removeAttribute('src');p.load();p.hidden=true;
 if(guidedTestUrl)URL.revokeObjectURL(guidedTestUrl);guidedTestUrl=null;
 $('guidedTestRetry').hidden=true;$('guidedTestRecord').disabled=false;$('guidedTestStop').disabled=true;
 $('guidedMicStatus').textContent='This short check stays on your device and is not uploaded.';guidedConsentUpdate();
}
async function guidedRecordTest(){
 if(guidedLocked()||guidedView!=='guidedMic')return;
 guidedTestClear();guidedPauseAudio();guidedMicBusy=true;const generation=guidedTestGeneration;
 $('guidedTestRecord').disabled=true;$('guidedMicBack').disabled=true;guidedConsentUpdate();
 try{
  if(self!==top||!isSecureContext||!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder)throw new Error('Open this recorder directly in a supported HTTPS browser.');
  const testStream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:{ideal:1},echoCancellation:{ideal:false},noiseSuppression:{ideal:false},autoGainControl:{ideal:false}},video:false});
  guidedInitialBrowser=browserAudioMetadata(testStream);guidedTestSetupSignature=setupSignature();
  if(generation!==guidedTestGeneration){testStream.getTracks().forEach(t=>t.stop());return;}
  guidedTestStream=testStream;
  const mime=['audio/webm;codecs=opus','audio/mp4','audio/webm','audio/ogg;codecs=opus'].find(t=>MediaRecorder.isTypeSupported(t));
  const recorder=mime?new MediaRecorder(testStream,{mimeType:mime}):new MediaRecorder(testStream);guidedTestRecorder=recorder;const parts=[];
  recorder.ondataavailable=e=>{if(e.data?.size)parts.push(e.data);};
  recorder.onerror=()=>{guidedMicPassed=false;$('guidedMicStatus').textContent='The microphone test was interrupted. Please try again.';guidedStopTest();};
  recorder.onstart=()=>{$('guidedMicStatus').textContent='Recording test · speak the sentence above. Stops after eight seconds.';$('guidedTestStop').disabled=false;guidedTestTimer=setTimeout(guidedStopTest,8000);};
  recorder.onstop=()=>{
   guidedTestRelease();guidedMicBusy=false;$('guidedTestStop').disabled=true;$('guidedMicBack').disabled=false;
   if(generation!==guidedTestGeneration)return;
   const blob=new Blob(parts,{type:recorder.mimeType||parts[0]?.type||'audio/webm'});
   if(!blob.size){$('guidedMicStatus').textContent='No test audio was captured. Please try again.';$('guidedTestRecord').disabled=false;guidedConsentUpdate();return;}
   guidedTestUrl=URL.createObjectURL(blob);const player=$('guidedTestPlayer');player.src=guidedTestUrl;player.hidden=false;player.load();
   $('guidedTestRetry').hidden=false;$('guidedMicStatus').textContent='Play your test back before continuing. It stays on this device.';guidedConsentUpdate();
  };
  recorder.start(500);
 }catch(error){guidedTestRelease();guidedMicBusy=false;guidedMicPassed=false;$('guidedMicBack').disabled=false;$('guidedTestRecord').disabled=false;$('guidedMicStatus').textContent=error.name==='NotAllowedError'?'Microphone permission was blocked. Allow access in your browser settings and try again.':error.message;guidedConsentUpdate();}
}
function guidedStopTest(){if(guidedTestRecorder&&guidedTestRecorder.state!=='inactive'){clearTimeout(guidedTestTimer);$('guidedTestStop').disabled=true;guidedTestRecorder.stop();}}
$('guidedBegin').addEventListener('click',()=>{if(config?.capture_enabled)guidedShow('startCard');});
$('guidedConsentBack').addEventListener('click',()=>guidedShow('guidedIntro'));
$('guidedConsentNext').addEventListener('click',()=>{const accepted=config?.capture_mode==='LIMITED_HELPER_PILOT'?$('pilotUnderstood').checked:customerConsentAccepted();if(config?.capture_enabled&&accepted){guidedShow('guidedMic');$('create').hidden=false;guidedConsentUpdate();}});
$('guidedMicBack').addEventListener('click',()=>guidedShow(activeSession?'captureCard':'startCard'));
$('guidedTestRecord').addEventListener('click',guidedRecordTest);$('guidedTestStop').addEventListener('click',guidedStopTest);
$('guidedTestRetry').addEventListener('click',()=>{if(!guidedMicBusy)guidedTestClear();});
$('guidedTestPlayer').addEventListener('ended',()=>{if(guidedTestUrl&&!guidedMicBusy){guidedMicPassed=true;$('guidedMicStatus').textContent='✓ Test playback complete. If your voice is clear, continue; otherwise choose Try Again.';guidedConsentUpdate();}});
$('guidedSections').addEventListener('click',guidedOpenSections);
$('guidedPrevious').addEventListener('click',()=>{if(activeSectionId>1)guidedGoSection(activeSectionId-1);else if(guidedCanMove())guidedShow('guidedIntro');});
$('guidedNext').addEventListener('click',()=>{if(!guidedCanMove()||activeSession?.status!=='RECORDING')return;if(activeSectionId<9&&!sessionTakes(activeSectionId).length)return;if(activeSectionId<8)guidedGoSection(activeSectionId+1);else if(activeSectionId===8&&config.sections.some(s=>s.id===9&&s.configured))guidedGoSection(9);else guidedOpenReview();});
$('guidedReviewBack').addEventListener('click',()=>guidedGoSection(activeSectionId));
$('guidedSubmit').addEventListener('click',finishSession);
document.querySelectorAll('audio').forEach(player=>player.addEventListener('play',()=>{if(busy||guidedMicBusy){player.pause();return;}document.querySelectorAll('audio').forEach(other=>{if(other!==player)other.pause();});}));
window.addEventListener('pagehide',()=>{guidedTestGeneration++;guidedTestRelease();if(guidedTestUrl)URL.revokeObjectURL(guidedTestUrl);});
document.addEventListener('visibilitychange',()=>{if(document.hidden&&guidedMicBusy)guidedStopTest();});
guidedSetupSelectors();guidedJourney();
initialize().then(()=>{if(!progressReturnMode&&config&&$('account').textContent==='Signed in to Project X.'&&!activeSession)guidedShow('guidedIntro',true);guidedSessionList();guidedConsentUpdate();});
