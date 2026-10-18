
'use strict';
const $ = id => document.getElementById(id);
const progressReturnMode=new URLSearchParams(location.search).get('view')==='progress'||new URLSearchParams(location.hash.slice(1)).get('view')==='progress';
let config = null, activeSession = null, mediaRecorder = null, stream = null;
let chunks = [], takeBlob = null, takeUrl = null, startedAt = 0, takeDuration = 0, tick = null, busy = false;
let audioContext = null, analyser = null, meterSamples = null, meterFrame = null, recordingInterrupted = false, activeSectionId = 1;
let savedTakeUrl = null, savedPlaybackRequest = 0;

function setStatus(message, target='globalStatus') { $(target).textContent = message || ''; if(typeof guidedStatus==='function')guidedStatus(message); }
async function api(url, options={}) {
  const response = await fetch(url, { credentials:'same-origin', ...options });
  const type = response.headers.get('content-type') || '';
  const result = type.includes('application/json') ? await response.json() : null;
  if (!response.ok) throw new Error(result?.error || `Request failed (${response.status}).`);
  return result;
}
function csrfHeaders() { return { 'Content-Type':'application/json' }; }
function durationLabel(seconds) { const n=Math.max(0,Math.round(seconds||0)); return `${Math.floor(n/60)}:${String(n%60).padStart(2,'0')}`; }
function sessionTakes(section) { return Number(section)===9 ? (activeSession?.special_message?.takes || []) : (activeSession?.sections?.[String(section)]?.takes || []); }
function sectionFlag(count) {
  if(count===0)return {state:'none',label:'Not recorded'};
  if(count===1)return {state:'one',label:'1 recording saved'};
  return {state:'complete',label:`${count} recordings saved`};
}
function updateSectionFlag(section) {
  const count=sessionTakes(section.id).length;
  const flag=section.configured?sectionFlag(count):{state:'pending',label:'PROMPT PENDING'};
  $('sectionFlag').dataset.state=flag.state;
  $('sectionFlag').textContent=flag.label;
}
function configuredSections() { return (config?.sections || []).filter(section=>section.configured); }
function allSectionsHaveTakes() {
  const required=(config?.sections || []).filter(section=>!section.optional);
  return required.length===8 && required.every(section=>
    section.configured && sessionTakes(section.id).length>0
  );
}
function updateFinishStandard() {
  const ready=allSectionsHaveTakes();
  $('finishStandard').hidden=!ready;
  $('finishStandardTitle').textContent=config?.finish_standard?.title||'Finish Standard';
  $('finishStandardText').textContent=config?.finish_standard?.text||'';
  $('finish').disabled=activeSession.status!=='RECORDING'||!ready||busy||Boolean(takeBlob);
  $('finish').textContent='Review recordings →'; if(typeof guidedUpdate==='function')guidedUpdate();
  $('deleteSession').disabled=busy||!['RECORDING','READY_FOR_TRANSFER','DELETE_PENDING'].includes(activeSession.status);
}
function releaseMic() { if(stream){stream.getTracks().forEach(track=>track.stop());stream=null;} }
function clearSavedPlayback() {
  savedPlaybackRequest++;
  const player=$('savedPlayback');
  if(player){player.pause();player.removeAttribute('src');player.load();}
  if(savedTakeUrl){URL.revokeObjectURL(savedTakeUrl);savedTakeUrl=null;}
  if($('savedTakePlayback'))$('savedTakePlayback').hidden=true;
}
async function playSavedTake(sectionId,take) {
  const request=++savedPlaybackRequest;
  setStatus(`Loading saved Take ${take.take}…`,'sectionStatus');
  try {
    const response=await fetch(`/api/sessions/${encodeURIComponent(activeSession.session_id)}/clips/${encodeURIComponent(take.clip_id)}`,{credentials:'same-origin'});
    if(!response.ok){
      const type=response.headers.get('content-type')||'';
      const result=type.includes('application/json')?await response.json():null;
      throw new Error(result?.error||`Could not load this take (${response.status}).`);
    }
    const audio=await response.blob();
    if(request!==savedPlaybackRequest)return;
    if(savedTakeUrl)URL.revokeObjectURL(savedTakeUrl);
    savedTakeUrl=URL.createObjectURL(audio);
    const player=$('savedPlayback');
    $('savedPlaybackTitle').textContent=`Saved Take ${take.take} · Section ${sectionId}`;
    player.src=savedTakeUrl;
    player.load();
    $('savedTakePlayback').hidden=false;
    try {
      await player.play();
      if(request===savedPlaybackRequest)setStatus(`Playing Take ${take.take}.`,'sectionStatus');
    } catch(playError) {
      if(request===savedPlaybackRequest)setStatus(`Take ${take.take} is ready. If playback did not start, tap play below.`,'sectionStatus');
    }
  } catch(error) {
    if(request===savedPlaybackRequest)setStatus(error.message,'sectionStatus');
  }
}
function clearTick() { if(tick){clearInterval(tick);tick=null;} }
function setRecordingIndicator(state, title, detail) {
  const indicator=$('recordingIndicator');
  indicator.dataset.state=state;
  $('recordingStateText').textContent=title;
  $('recordingHelp').textContent=detail;
}
function resetAudioMeter() {
  if(meterFrame){cancelAnimationFrame(meterFrame);meterFrame=null;}
  analyser=null;meterSamples=null;
  for(const bar of $('audioMeter').children)bar.classList.remove('active');
  if(audioContext){const context=audioContext;audioContext=null;context.close().catch(()=>{});}
}
function animateAudioMeter() {
  if(!analyser||!meterSamples)return;
  analyser.getByteTimeDomainData(meterSamples);
  let sum=0;
  for(const value of meterSamples){const sample=(value-128)/128;sum+=sample*sample;}
  const level=Math.min(1,Math.sqrt(sum/meterSamples.length)*8);
  [...$('audioMeter').children].forEach((bar,index)=>bar.classList.toggle('active',level>(index+1)*0.075));
  meterFrame=requestAnimationFrame(animateAudioMeter);
}
async function startAudioMeter() {
  try {
    const AudioContextClass=window.AudioContext||window.webkitAudioContext;
    if(!AudioContextClass)throw new Error('Audio level display is not supported.');
    audioContext=new AudioContextClass();
    const source=audioContext.createMediaStreamSource(stream);
    analyser=audioContext.createAnalyser();analyser.fftSize=256;meterSamples=new Uint8Array(analyser.fftSize);source.connect(analyser);
    if(audioContext.state==='suspended')await audioContext.resume();
    animateAudioMeter();
  } catch(error) {
    resetAudioMeter();
    $('meterCaption').textContent='Recording is active. The microphone level display is unavailable in this browser.';
  }
}

function updateSectionMenuColor() {
  const menu=$('sectionSelect');
  menu.dataset.state=menu.selectedOptions[0]?.dataset.state||'pending';
}
function renderSections(selectedId=activeSectionId) {
  const menu=$('sectionSelect'); const sections=config.sections; menu.innerHTML='';
  const sectionOptions=document.createElement('optgroup'); sectionOptions.label='Sections';
  for(const section of sections) {
    const option=document.createElement('option'); option.value=String(section.id);
    const count=sessionTakes(section.id).length;
    const flag=section.configured?sectionFlag(count):{state:'pending',label:'PROMPT PENDING'};
    option.dataset.state=flag.state;
    option.textContent=`${flag.label} · Section ${section.id}: ${section.title}`;
    option.disabled=!section.configured; sectionOptions.appendChild(option);
  }
  menu.appendChild(sectionOptions);
  const next=sections.find(item=>item.id===Number(selectedId)&&item.configured)||configuredSections()[0];
  if(next){activeSectionId=next.id;menu.value=String(next.id);updateSectionMenuColor();showSection(next.id);}
}
function handleSectionMenuChange() {
  if(busy){$('sectionSelect').value=String(activeSectionId);return;}
  if(takeBlob){$('sectionSelect').value=String(activeSectionId);setStatus('Save or discard this take before choosing another section.','sectionStatus');return;}
  activeSectionId=Number($('sectionSelect').value);
  updateSectionMenuColor();showSection(activeSectionId);
}

function showSection(id) {
  const section=config.sections.find(item=>item.id===Number(id));
  if(!section||!section.configured) return;
  $('sectionTitle').textContent=section.optional ? 'Section 9 · Optional' : `Section ${section.id} of 8`;
  $('savedTakeHeading').textContent=`Saved takes · Section ${section.id}`;
  updateSectionFlag(section);
  updateReadableSectionPicker();
  $('promptTitle').textContent=section.title;
  $('instructions').textContent=section.instructions;
  $('sectionStatus').textContent=`${sessionTakes(section.id).length} saved take${sessionTakes(section.id).length===1?'':'s'} for this section.`;
  clearSavedPlayback();
  const takes=sessionTakes(section.id),takeList=$('takeList');
  takeList.innerHTML='';
  for(const take of takes) {
    const item=document.createElement('li');
    const label=document.createElement('span');
    label.textContent=`Take ${take.take} · ${durationLabel(take.duration_seconds)} · ${activeSession.status==='TRANSFERRED_AUDIO_DELETED'?'transferred':'saved'}`;
    const actions=document.createElement('div');actions.className='take-actions';
    const listen=document.createElement('button');
    listen.type='button';listen.className='quiet';listen.textContent='Listen';
    listen.setAttribute('aria-label',`Listen to Take ${take.take} from Section ${section.id}`);
    listen.disabled=activeSession.status==='TRANSFERRED_AUDIO_DELETED';
    listen.addEventListener('click',()=>playSavedTake(section.id,take));
    const remove=document.createElement('button');
    remove.type='button';remove.className='danger';remove.textContent='Delete';
    remove.setAttribute('aria-label',`Delete Take ${take.take} from Section ${section.id}`);
    remove.disabled=activeSession.status!=='RECORDING'||busy;
    remove.addEventListener('click',()=>deleteSavedTake(section.id,take.clip_id));
    actions.append(listen,remove);item.append(label,actions);takeList.appendChild(item);
  }
  $('noSavedTakes').hidden=takes.length>0;
  $('record').disabled=activeSession.status!=='RECORDING'||busy;
  updateFinishStandard();
  if(typeof guidedLesson==='function')guidedLesson(section);
}

async function refreshSessions() {
  const data=await api('/api/sessions'); const sessions=data.sessions||[];
  const wrap=$('existingWrap'), select=$('sessions'); select.innerHTML='';
  const resumable=sessions.filter(item=>['RECORDING','READY_FOR_TRANSFER'].includes(item.status)||(item.program==='CUSTOMER'&&item.phone_training?.accepted===true&&item.status==='TRANSFERRED_AUDIO_DELETED'));
  if(resumable.length) {
    wrap.hidden=false;
    for(const item of resumable){const option=document.createElement('option'); option.value=item.session_id; option.textContent=`${new Date(item.created_at).toLocaleString()} · ${item.status.replaceAll('_',' ')}`; select.appendChild(option);}
  } else wrap.hidden=true;
  $('startCard').hidden=progressReturnMode;
  if(typeof guidedSessionList==='function')guidedSessionList();
  return sessions;
}

function retentionChoice() {
  if($('deleteAfterOrder').checked) return 'DELETE_AFTER_ORDER';
  if($('futurePurchases').checked) return 'FUTURE_PURCHASES';
  return '';
}

function customerConsentAccepted() {
  return Boolean(retentionChoice()) && $('ageOwnVoice').checked;
}

function syncConsentControls(changedId='') {
  if(changedId==='deleteAfterOrder'&&$('deleteAfterOrder').checked) $('futurePurchases').checked=false;
  if(changedId==='futurePurchases'&&$('futurePurchases').checked) $('deleteAfterOrder').checked=false;
  const accepted=config?.capture_mode==='LIMITED_HELPER_PILOT' ? $('pilotUnderstood').checked : customerConsentAccepted();
  $('create').disabled=!config?.capture_enabled||!accepted||!guidedMicPassed; if(typeof guidedConsentUpdate==='function')guidedConsentUpdate();
}

async function selectSession(id) {
  if(busy||takeBlob){setStatus('Wait for saving to finish, or retry or discard the unsaved take before changing sessions.','sectionStatus');return;}
  const data=await api(`/api/sessions/${encodeURIComponent(id)}`); if(data?.session?.session_id!==id)throw new Error('The recording-session response did not match. Please reopen your session.'); activeSession=data.session;
  $('transferCompleteCard').hidden=true;
  if(activeSession.program==='CUSTOMER'&&activeSession.phone_training?.accepted===true){showPhoneTraining(activeSession);return;}
  $('phoneTrainingCard').hidden=true;
  if(activeSession.status==='TRANSFERRED_AUDIO_DELETED'){showTransferComplete(activeSession);return;}
  $('startCard').hidden=true; $('captureCard').hidden=false;
  $('sessionLabel').textContent=`Session ${activeSession.session_id} · ${activeSession.status.replaceAll('_',' ')}`;
  renderSections();
  if(activeSession.status!=='RECORDING'){
    $('sectionStatus').textContent='This session is complete and waiting for verified transfer to the Project X library.';
    $('sectionSelect').disabled=true; $('record').disabled=true; $('finish').disabled=true;
  } else {$('sectionSelect').disabled=false;}
  if(typeof guidedSelected==='function')guidedSelected();
}

// PX_DIRECT_PROGRESS_RETURN
function showProgressReturn(message) {
  $('startCard').hidden=true;
  $('captureCard').hidden=true;
  $('transferCompleteCard').hidden=true;
  $('phoneTrainingCard').hidden=true;
  $('progressReturnCard').hidden=false;
  $('progressReturnStatus').textContent=message;
  if(typeof guidedProgress==='function')guidedProgress('progressReturnCard');
}

function progressSessionCandidates(sessions) {
  return sessions.filter(item=>item.program==='CUSTOMER' &&
    item.phone_training?.accepted===true &&
    ['READY_FOR_TRANSFER','TRANSFERRED_AUDIO_DELETED'].includes(item.status))
    .sort((a,b)=>{
      const time=item=>{const value=Date.parse(item.phone_training.accepted_at||item.created_at);return Number.isFinite(value)?value:0;};
      return time(b)-time(a)||a.session_id.localeCompare(b.session_id);
    });
}

async function returnToVoiceProgress(sessions) {
  showProgressReturn('Finding your voice-profile progress…');
  const candidates=progressSessionCandidates(sessions);
  const picker=$('progressSessions');
  picker.replaceChildren();
  $('progressSessionChoices').hidden=true;
  $('chooseOtherProgress').hidden=true;
  for(const item of candidates) {
    const option=document.createElement('option');
    option.value=item.session_id;
    const time=new Date(item.phone_training.accepted_at||item.created_at);
    option.textContent='Submitted '+(Number.isFinite(time.getTime())?time.toLocaleString():'date unavailable');
    picker.appendChild(option);
  }
  if(!candidates.length) {
    $('progressReturnStatus').textContent='No submitted voice-profile session was found for this signed-in account. Return to Project X if you want to begin recording.';
    return;
  }
  if(candidates.length>20) {
    $('progressSessionChoices').hidden=false;
    $('progressReturnStatus').textContent='Choose the submitted recording whose progress you want to view.';
    return;
  }
  let chosen=candidates[0];
  if(candidates.length>1) {
    // Prefer the newest active preparation over completed/failed older profiles.
    // All IDs come from the signed-in owner's /api/sessions response.
    for(const candidate of candidates) {
      const snapshot=await api(`/api/sessions/${encodeURIComponent(candidate.session_id)}/phone-flow`,{cache:'no-store'});
      if(snapshot.session_id!==candidate.session_id ||
          !['QUEUED','PREPARING','TRAINING','KEY_SELECTION','CERTIFYING','SOURCE_REVIEW','READY','FAILED','REVIEW_REQUIRED'].includes(snapshot.phase)) {
        throw new Error('Your processing-session status could not be verified.');
      }
      if(['QUEUED','PREPARING','TRAINING','KEY_SELECTION','CERTIFYING','SOURCE_REVIEW'].includes(snapshot.phase)) {chosen=candidate;break;}
    }
  }
  await openProgressSession(chosen.session_id);
}

async function openProgressSession(id) {
  // Never accept an arbitrary URL/session ID as authority to resume.
  const options=Array.from($('progressSessions').options);
  if(!options.some(option=>option.value===id))throw new Error('Choose one of your submitted recording sessions.');
  await selectSession(id);
  $('progressReturnCard').hidden=true;
  $('chooseOtherProgress').hidden=options.length<2;
}
// PX_DIRECT_PROGRESS_RETURN_END


async function initialize() {
  try {
    if(progressReturnMode) {
      document.title='Project X — Voice Profile Progress';
      $('capturePageTitle').textContent='Voice Profile Progress';
      $('capturePageIntroduction').hidden=true;
      showProgressReturn('Checking your sign-in and finding your processing session…');
    }
    const hash=new URLSearchParams(location.hash.slice(1)); const ticket=hash.get('ticket');
    if(ticket){history.replaceState(null,'',location.pathname+(progressReturnMode?'?view=progress':'')); await api('/api/session/exchange',{method:'POST',headers:csrfHeaders(),body:JSON.stringify({ticket})});}
    config=await api('/api/config');
    // Keep the eight required training prompts unchanged.
    if(config.special_message)config.sections.push(config.special_message);
    const pilotMode=config.capture_mode==='LIMITED_HELPER_PILOT';
    $('customerConsentPanel').hidden=pilotMode;
    $('pilotConsentPanel').hidden=!pilotMode;
    if(pilotMode){
      $('pilotNotice').textContent=config.pilot_consent_notice||'';
      $('pilotConsentDocument').href=config.pilot_consent_document_path||'/pilot-consent';
      if(!config.pilot_access){
        $('pilotAccessMessage').hidden=false;
        $('pilotAccessMessage').textContent='This Wix sign-in email is not on the pilot invitation list. Send this email address to Sam to request an invitation.';
        if(config.account_email){
          $('pilotEmail').textContent=config.account_email;
          $('pilotEmailRow').hidden=false;
        }
      }
    }
    $('consentNotice').textContent=config.consent_notice;
    $('deleteChoiceText').textContent=config.consent_choices?.delete_after_order||'';
    $('futureChoiceText').textContent=config.consent_choices?.future_purchases||'';
    $('developmentChoiceText').textContent=config.consent_choices?.development_use||'';
    $('consentDocument').href=config.consent_document_path||'/consent';
    $('consentDraft').hidden=!config.consent_draft;
    if(!config.capture_enabled) $('setupBlock').textContent=pilotMode
      ? (!config.prompts_ready ? 'Pilot recording is disabled until all eight prompts are available.' : 'Pilot access is limited to invited Wix sign-in emails.')
      : ((config.customer_capture_access ?? config.customer_test_access) === false
        ? 'Customer capture is currently available only to the approved account training test.'
        : config.consent_draft
        ? 'New sessions are disabled until the consent wording and all eight section prompts are approved.'
        : 'New sessions are disabled until all eight section prompts are configured.');
    $('setupBlock').hidden=config.capture_enabled;
    if(config.capture_enabled && config.supplied_recordings_enabled){const a=document.createElement('a');a.href='/voice-recording-upload';a.textContent='Use an existing voice recording instead';$('startCard').appendChild(a);}
    $('deleteAfterOrder').addEventListener('change',()=>syncConsentControls('deleteAfterOrder'));
    $('futurePurchases').addEventListener('change',()=>syncConsentControls('futurePurchases'));
    $('developmentUse').addEventListener('change',()=>syncConsentControls('developmentUse'));
    $('ageOwnVoice').addEventListener('change',()=>syncConsentControls('ageOwnVoice'));
    $('pilotUnderstood').addEventListener('change',()=>syncConsentControls('pilotUnderstood'));
    syncConsentControls();
    $('create').addEventListener('click',async()=>{
      if(busy||takeBlob||guidedCreating||!guidedMicPassed||!config.capture_enabled||(pilotMode?!$('pilotUnderstood').checked:!customerConsentAccepted()))return; guidedCreating=true;
      $('create').disabled=true; setStatus('Creating your session…','account');
      const selectedRetention=retentionChoice();
      const consentBody=pilotMode
        ? {pilot_consent:{accepted:true,version:config.pilot_consent_version,understood:$('pilotUnderstood').checked}}
        : {consent:{accepted:true,version:config.consent_version,retention_choice:selectedRetention,development_use:$('developmentUse').checked,adult_confirmed:$('ageOwnVoice').checked,own_voice_confirmed:$('ageOwnVoice').checked}};
      try{const data=await api('/api/sessions',{method:'POST',headers:csrfHeaders(),body:JSON.stringify(consentBody)});await selectSession(data.session.session_id);setStatus('Signed in. Your new session is ready.','account');}
      catch(error){setStatus(error.message);}finally{guidedCreating=false;syncConsentControls();guidedUpdate();}
    });
    const ownedSessions=await refreshSessions();
    $('account').textContent='Signed in to Project X.';
    if(progressReturnMode)await returnToVoiceProgress(ownedSessions);
    $('deleteSession').addEventListener('click',()=>deleteEntireSession(activeSession?.session_id));
    $('deleteSelectedSession').addEventListener('click',()=>deleteEntireSession($('sessions').value));
    $('resume').addEventListener('click',async()=>{try{await selectSession($('sessions').value);}catch(error){setStatus(error.message);}});
    $('sectionSelect').addEventListener('change',handleSectionMenuChange);
    $('record').addEventListener('click',startRecording);
    $('stop').addEventListener('click',()=>stopRecording(false));
    $('saveTake').addEventListener('click',saveTake);
    $('discardTake').addEventListener('click',discardTake);
    $('finish').addEventListener('click',guidedOpenReview);
    $('closeSavedPlayback').addEventListener('click',clearSavedPlayback);
    $('logout').addEventListener('click',async()=>{if(busy||takeBlob){setStatus('Finish saving or discard the unsaved take before signing out.','sectionStatus');return;}clearSavedPlayback();await api('/api/session/logout',{method:'POST'});location.reload();});
  }catch(error){if(progressReturnMode)showProgressReturn('Could not reopen progress. Use Refresh voice-profile progress to try again, or return to Project X and reopen this page after signing in.');$('account').textContent=error.message; if(error.message.includes('Sign in')) $('account').textContent='You must be signed in to your Project X account to continue. Return to the Project X website, sign in, then reopen Voice Capture.';}
}

async function startRecording() {
  if(busy||guidedMicBusy||!activeSession||activeSession.status!=='RECORDING')return;
  guidedPauseAudio();
  if(takeBlob){setStatus('Retry saving or discard the unsaved take before recording again.','sectionStatus');return;}
  startedAt=0; busy=true; updateFinishStandard(); $('record').disabled=true; $('stop').disabled=true; $('review').hidden=true; $('sectionSelect').disabled=true;$('timer').textContent='00:00';
  setRecordingIndicator('starting','Connecting to microphone','Recording has not started yet. Allow microphone access if your browser asks.');
  setStatus('Opening microphone…','sectionStatus');
  try{
    if(self!==top)throw new Error('Open this recorder directly in the browser, not inside a frame.');
    if(!isSecureContext)throw new Error('Microphone recording requires HTTPS.');
    if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder)throw new Error('Recording is not supported in this browser.');
    stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:{ideal:1},echoCancellation:{ideal:false},noiseSuppression:{ideal:false},autoGainControl:{ideal:false}},video:false});
    const types=['audio/webm;codecs=opus','audio/mp4','audio/webm','audio/ogg;codecs=opus'];
    const mimeType=types.find(type=>MediaRecorder.isTypeSupported(type));
    mediaRecorder=mimeType?new MediaRecorder(stream,{mimeType}):new MediaRecorder(stream);
    chunks=[]; mediaRecorder.ondataavailable=event=>{if(event.data?.size)chunks.push(event.data);};
    mediaRecorder.onerror=()=>stopRecording(true);
    recordingInterrupted=false;
    mediaRecorder.onstart=()=>{
      startedAt=Date.now();$('timer').textContent='00:00';
      $('stop').disabled=false;
      setRecordingIndicator('recording','Recording in progress','Speak or sing now. Press “Stop recording” when this take is complete.');
      $('meterCaption').textContent='Recording is active · moving bars show sound reaching the microphone.';
      setStatus('Recording is active. Tap Stop when you finish this take.','sectionStatus');
      tick=setInterval(()=>{
        const sec=Math.floor((Date.now()-startedAt)/1000);$('timer').textContent=durationLabel(sec);
        const limit=activeSectionId===9 ? 8 : 300;
        if((Date.now()-startedAt)/1000>=limit)stopRecording(false);
      },250);
      void startAudioMeter();
    };
    mediaRecorder.onstop=()=>{
      takeDuration=startedAt?(Date.now()-startedAt)/1000:0;
      releaseMic();clearTick();resetAudioMeter();busy=false;$('stop').disabled=true;
      $('sectionSelect').disabled=activeSession.status!=='RECORDING';
      $('timer').textContent=durationLabel(takeDuration);
      const blob=new Blob(chunks,{type:mediaRecorder.mimeType||chunks[0]?.type||'audio/webm'});chunks=[];
      if(!blob.size){setRecordingIndicator('error','No audio captured','Recording stopped without audio. Check the microphone and try again.');setStatus('No audio was recorded. Please try again.','sectionStatus');$('record').disabled=false;return;}
      takeBlob=blob; updateFinishStandard(); if(takeUrl)URL.revokeObjectURL(takeUrl);takeUrl=URL.createObjectURL(blob);
      $('playback').src=takeUrl;$('review').hidden=false;$('record').disabled=true;
      const stoppedMessage=recordingInterrupted?'Recording stopped unexpectedly. Saving the recovered take…':'Recording stopped. Saving your take…';
      setRecordingIndicator('ready','Saving…',stoppedMessage);
      $('meterCaption').textContent='The microphone level display activates during recording; moving bars show sound reaching the microphone.';
      void saveTake();
      recordingInterrupted=false;
    };
    mediaRecorder.start(1000);
  }catch(error){releaseMic();clearTick();resetAudioMeter();busy=false;$('record').disabled=false;$('stop').disabled=true;$('sectionSelect').disabled=activeSession.status!=='RECORDING';setRecordingIndicator('error','Recording did not start','No take is being recorded. Correct the issue below and try again.');setStatus(error.name==='NotAllowedError'?'Microphone permission was blocked. Allow it in browser settings and try again.':error.message,'sectionStatus');guidedUpdate();}
}

function stopRecording(interrupted) {
  if(!mediaRecorder||mediaRecorder.state==='inactive')return;
  if(interrupted)recordingInterrupted=true;
  $('stop').disabled=true;clearTick();resetAudioMeter();
  const elapsed=startedAt?Math.floor((Date.now()-startedAt)/1000):0;$('timer').textContent=durationLabel(elapsed);
  setRecordingIndicator('stopping','Finishing recording…','The microphone is closing and the take is being prepared.');
  setStatus(interrupted?'Recording interrupted; preparing the take…':'Preparing your take…','sectionStatus');
  try{mediaRecorder.stop();}catch(error){releaseMic();clearTick();resetAudioMeter();busy=false;$('record').disabled=false;$('sectionSelect').disabled=activeSession.status!=='RECORDING';setRecordingIndicator('error','Could not finish recording','No take is currently recording. Please try again.');setStatus('Could not finish the recording. Please try again.','sectionStatus');}
}

async function saveTake() {
  if(!takeBlob||busy)return;
  busy=true;updateFinishStandard();$('sectionSelect').disabled=true;$('record').disabled=true;$('saveTake').disabled=true;$('discardTake').disabled=true;setRecordingIndicator('ready','Saving…','Your recording has stopped. Keep this page open while the take saves.');setStatus('Saving your take…','sectionStatus');
  try{
    const form=new FormData();form.append('section',String(activeSectionId));form.append('duration_seconds',String(takeDuration));
    const ext=takeBlob.type.includes('mp4')?'m4a':takeBlob.type.includes('ogg')?'ogg':takeBlob.type.includes('wav')?'wav':'webm';
    form.append('audio',takeBlob,`recording.${ext}`);
    const data=await api(`/api/sessions/${encodeURIComponent(activeSession.session_id)}/clips`,{method:'POST',body:form});
    activeSession=data.session;takeBlob=null;if(takeUrl){URL.revokeObjectURL(takeUrl);takeUrl=null;} $('playback').removeAttribute('src');$('playback').load();$('review').hidden=true;
    setRecordingIndicator('idle','Saved','Your take is saved. Choose a section and press “Record a take” when ready.');$('timer').textContent='00:00';
    $('meterCaption').textContent='The microphone level display activates during recording; moving bars show sound reaching the microphone.';
    showSection(activeSectionId);renderSections(activeSectionId);setStatus(`Saved as take ${data.clip.take}. You can record another take or choose another section.`, 'sectionStatus');
  }catch(error){setRecordingIndicator('error','Not saved — retry','Your recording is still on this page. Keep it open and use Retry saving.');setStatus(`Saving failed: ${error.message} Your take is still here. Use Retry saving without recording again.`,'sectionStatus');}
  finally{busy=false;const message=$('sectionStatus').textContent;renderSections(activeSectionId);setStatus(message,'sectionStatus');$('sectionSelect').disabled=activeSession.status!=='RECORDING'||Boolean(takeBlob);$('record').disabled=activeSession.status!=='RECORDING'||Boolean(takeBlob);$('saveTake').disabled=!takeBlob;$('discardTake').disabled=!takeBlob;}
}

function discardTake() {
  if(!takeBlob||busy)return;
  if(!confirm('Discard this unsaved take? It will be removed from this page and will not be uploaded.'))return;
  takeBlob=null;takeDuration=0;startedAt=0;
  if(takeUrl){URL.revokeObjectURL(takeUrl);takeUrl=null;}
  $('playback').removeAttribute('src');$('playback').load();$('review').hidden=true;
  $('timer').textContent='00:00';
  setRecordingIndicator('idle','Take discarded','This unsaved take was removed and was not uploaded. Record another take when ready.');
  setStatus('Unsaved take discarded. It was not uploaded to Render.','sectionStatus');
  $('record').disabled=activeSession?.status!=='RECORDING';$('sectionSelect').disabled=activeSession?.status!=='RECORDING';updateFinishStandard();
}

async function deleteSavedTake(sectionId,clipId) {
  if(busy||activeSession?.status!=='RECORDING')return;
  const clip=sessionTakes(sectionId).find(item=>item.clip_id===clipId);
  if(!clip)return;
  const confirmed=confirm(`Delete saved Take ${clip.take} from Section ${sectionId}? It will be removed from this session and active Render storage. Encrypted backups may retain a copy under the retention terms in your notice.`);
  if(!confirmed)return;
  busy=true;updateFinishStandard();$('sectionSelect').disabled=true;$('record').disabled=true;
  setStatus(`Deleting saved Take ${clip.take}…`,'sectionStatus');
  let resultMessage='';
  try {
    const data=await api(`/api/sessions/${encodeURIComponent(activeSession.session_id)}/clips/${encodeURIComponent(clip.clip_id)}`,{method:'DELETE'});
    activeSession=data.session;
    renderSections(sectionId);
    resultMessage=`Saved Take ${clip.take} deleted from this session and active Render storage. Backups may retain a copy under the notice terms.`;
  } catch(error) {
    resultMessage=error.message;
    try {
      const latest=await api(`/api/sessions/${encodeURIComponent(activeSession.session_id)}`);
      activeSession=latest.session;
      renderSections(sectionId);
    } catch { /* Keep the current view if the session refresh also fails. */ }
  } finally {
    busy=false;
    showSection(sectionId);
    $('sectionSelect').disabled=activeSession.status!=='RECORDING';
    $('record').disabled=activeSession.status!=='RECORDING';
    setStatus(resultMessage,'sectionStatus');
  }
}

async function deleteEntireSession(id) {
  if(busy||!id)return;
  if(!confirm('Delete this entire session and all its saved recordings, including the optional birthday message? Any unsaved take on this page will also be discarded. This cannot be undone. Active Render storage will be deleted; local copies and snapshots are not deleted by this action.'))return;
  busy=true;
  $('deleteSession').disabled=true;$('deleteSelectedSession').disabled=true;$('resume').disabled=true;$('create').disabled=true;
  $('record').disabled=true;$('sectionSelect').disabled=true;$('finish').disabled=true;
  setStatus('Deleting the session…');
  let deleted=false;
  try {
    await api(`/api/sessions/${encodeURIComponent(id)}`,{method:'DELETE'});
    deleted=true;
    if(activeSession?.session_id===id){
      clearSavedPlayback();releaseMic();clearTick();resetAudioMeter();takeBlob=null;
      if(takeUrl){URL.revokeObjectURL(takeUrl);takeUrl=null;}
      $('playback').removeAttribute('src');$('playback').load();$('review').hidden=true;
      activeSession=null;$('captureCard').hidden=true;
    }
    await refreshSessions();
    if(!activeSession)guidedResetIntro();
    setStatus('Session deleted from active Render storage. Local copies and snapshots were not deleted.');
  } catch(error){setStatus(deleted ? 'Session deleted, but the session list could not refresh. Reload the page.' : error.message);}
  finally {
    busy=false;$('deleteSelectedSession').disabled=false;$('resume').disabled=false;syncConsentControls();
    if(activeSession){renderSections(activeSectionId);$('sectionSelect').disabled=activeSession.status!=='RECORDING';}
    $('deleteSession').disabled=!activeSession||!['RECORDING','READY_FOR_TRANSFER','DELETE_PENDING'].includes(activeSession.status);
  }
}
async function finishSession() {
  if(busy||takeBlob||!activeSession||activeSession.status!=='RECORDING'||!allSectionsHaveTakes()){setStatus('Save at least one take in all eight training sections before submitting.');return;}
  const phoneTraining=activeSession?.program==='CUSTOMER';
  if(!confirm(phoneTraining?'Submit my saved recordings and start preparation? I approve my saved takes in Sections 1–8 for voice-model training. Section 9 stays separate. Preparation and key selection are automatic. I cannot add recordings after submitting.':'Finish this session? Section 9 is optional. You will no longer be able to add recordings to it.'))return;
  busy=true;updateFinishStandard();$('sectionSelect').disabled=true;$('record').disabled=true;
  let message='';
  try{const data=await api(`/api/sessions/${encodeURIComponent(activeSession.session_id)}/complete`,{method:'POST',headers:csrfHeaders(),body:JSON.stringify(phoneTraining?{start_training:true}:{})});activeSession=data.session;message='Your recordings have been submitted for transfer. This screen will update when transfer completes.';if(phoneTraining)showPhoneTraining(activeSession);}
  catch(error){message=error.message;try{const sid=activeSession.session_id;const latest=await api(`/api/sessions/${encodeURIComponent(sid)}`,{cache:'no-store'});if(latest?.session?.session_id===sid&&latest.session.status!=='RECORDING'){activeSession=latest.session;message='Your saved session status was refreshed after the interrupted response.';if(activeSession.phone_training?.accepted===true)showPhoneTraining(activeSession);else if(activeSession.status==='TRANSFERRED_AUDIO_DELETED')showTransferComplete(activeSession);}}catch{message='Submission could not be confirmed. Reopen Voice Profile Progress before trying again.';}}
  finally{busy=false;renderSections(activeSectionId);$('sectionSelect').disabled=activeSession.status!=='RECORDING';$('sessionLabel').textContent=`Session ${activeSession.session_id} · ${activeSession.status.replaceAll('_',' ')}`;setStatus(message,'sectionStatus');}
}

window.addEventListener('beforeunload',event=>{if(busy||guidedCreating||guidedMicBusy||takeBlob||mediaRecorder?.state==='recording'){event.preventDefault();event.returnValue='';}});
document.addEventListener('visibilitychange',()=>{if(document.hidden&&mediaRecorder?.state==='recording')stopRecording(true);});
window.addEventListener('pagehide',()=>{if(mediaRecorder?.state==='recording')stopRecording(true);releaseMic();clearTick();resetAudioMeter();if(takeUrl)URL.revokeObjectURL(takeUrl);clearSavedPlayback();});
// PX_AUTOMATIC_TRANSFER_SCREEN_REFRESH_V3
let transferScreenRefreshBusy=false;
let transferCompleteTimer=null, transferCompleteSessionId='', transferEndBusy=false;
function cancelTransferCompleteTimer() {
  if(transferCompleteTimer!==null)clearTimeout(transferCompleteTimer);
  transferCompleteTimer=null;
}
function showTransferComplete(session) {
  if(session.program==='CUSTOMER'&&session.phone_training?.accepted===true){showPhoneTraining(session);return;}
  if(transferCompleteSessionId===session.session_id&&!$('transferCompleteCard').hidden)return;
  cancelTransferCompleteTimer();
  transferCompleteSessionId=session.session_id;
  activeSession=session;
  clearSavedPlayback();releaseMic();clearTick();resetAudioMeter();
  $('captureCard').hidden=true;
  $('startCard').hidden=true;
  $('transferCompleteCard').hidden=false;
  if(typeof guidedProgress==='function')guidedProgress('transferCompleteCard');
  $('transferCompleteSession').textContent=`Session ${session.session_id}`;
  $('transferCompleteCard').scrollIntoView({behavior:'smooth',block:'start'});
  $('transferCompleteHelp').textContent='You can return to Project X or start another recording session.';
  $('startAfterTransfer').disabled=false;
  setStatus('');

}
async function startAfterCompletedTransfer() {
  if(transferEndBusy||activeSession?.status!=='TRANSFERRED_AUDIO_DELETED')return;
  transferEndBusy=true;
  cancelTransferCompleteTimer();
  const completedId=activeSession.session_id;
  $('startAfterTransfer').disabled=true;
  try {
    await refreshSessions();
    if(activeSession?.session_id!==completedId)return;
    activeSession=null;
    transferCompleteSessionId='';
    $('captureCard').hidden=true;
    $('transferCompleteCard').hidden=true;
    $('startCard').hidden=false;
    $('startCard').scrollIntoView({behavior:'smooth',block:'start'});
    guidedResetIntro();setStatus('Your previous transfer is complete. You can start a new session below.');
  } catch(error) {
    $('transferCompleteHelp').textContent='Could not load the new-session screen. Tap Start another recording session to try again.';
  } finally {transferEndBusy=false;$('startAfterTransfer').disabled=false;}
}
async function refreshCompletedTransferScreen() {
  if(transferScreenRefreshBusy||busy||!activeSession)return;
  if(activeSession.program==='CUSTOMER'&&activeSession.phone_training?.accepted===true){await refreshPhoneTraining();return;}
  if(activeSession.status==='TRANSFERRED_AUDIO_DELETED') {showTransferComplete(activeSession);return;}
  if(activeSession.status!=='READY_FOR_TRANSFER')return;
  const sessionId=activeSession.session_id;
  transferScreenRefreshBusy=true;
  try {
    const data=await api(`/api/sessions/${encodeURIComponent(sessionId)}`,{cache:'no-store'});
    if(!activeSession||activeSession.session_id!==sessionId||busy)return;
    if(!data?.session||data.session.session_id!==sessionId)throw new Error('Session status response did not match.');
    if(data.session.status==='TRANSFERRED_AUDIO_DELETED')showTransferComplete(data.session);
    else setStatus('Recordings submitted. Waiting for verified transfer. This screen checks automatically.','sectionStatus');
  } catch(error) {
    if(activeSession?.session_id===sessionId&&!busy)
      setStatus('Your recordings are submitted. We could not refresh transfer status yet; checking again shortly.','sectionStatus');
  } finally {transferScreenRefreshBusy=false;}
}
$('startAfterTransfer').addEventListener('click',startAfterCompletedTransfer);
setInterval(()=>{if(activeSession?.status==='READY_FOR_TRANSFER')refreshCompletedTransferScreen();},10000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshCompletedTransferScreen();});


// Customer phone flow keeps transfer, training, Key Finder and certification together.
let phoneRefreshBusy=false, phoneSnapshot=null, phoneOptionsRevision='', phoneChoiceBusy=false;
const phoneLabels={QUEUED:'Recordings submitted. Waiting for verified transfer.',PREPARING:'Transfer verified. Preparing your training recording.',TRAINING:'Training your voice model.',KEY_SELECTION:'Preparing the best pitch for your voice profile.',CERTIFYING:'Checking your completed voice model.',READY:'Voice Profile Ready — certification passed.',FAILED:'Processing did not succeed. Project X will review this test.',REVIEW_REQUIRED:'This test needs Project X review. No new training will start automatically.'};
const phonePreparationStages={QUEUED:'Waiting for preparation',CHECKING_RECORDINGS:'Checking and preparing your recordings',ANALYZING_VOICE:'Analyzing your voice',CALIBRATING:'Preparing your voice profile',TRAINING:'Training your voice profile',BUILDING_INDEX:'Building your voice profile index',PREPARING_PREVIEWS:'Preparing voice previews',VERIFYING:'Verifying your voice profile'};
let phonePreparationClockOffset=0,phoneRefreshFailed=false;
function renderPhonePreparation(){
  const snapshot=phoneSnapshot,p=snapshot?.preparation;
  $('phoneChooseSong').hidden=snapshot?.phase!=='READY';
  if(!p){$('phonePreparationTime').textContent='';$('phonePreparationCheckBack').textContent='Waiting for a preparation update.';return;}
  const now=Date.now()+phonePreparationClockOffset,submitted=Date.parse(p.submitted_at),finished=Date.parse(p.finished_at),updated=Date.parse(p.progress_updated_at);
  const terminal=['READY','FAILED','REVIEW_REQUIRED'].includes(snapshot.phase);
  const recentWorker=Date.parse(p.worker_updated_at||p.updated_at);
  const queuedTooLong=snapshot.phase==='QUEUED'&&Number.isFinite(submitted)&&now-submitted>600000;
  const updatesDelayed=!terminal&&(phoneRefreshFailed||(!Number.isFinite(recentWorker)||now-recentWorker>120000)&&snapshot.phase!=='QUEUED');
  const blockedKey=!terminal&&snapshot.phase==='KEY_SELECTION';
  const alert=p.alert?.message||(queuedTooLong?'Your recordings were submitted. Preparation is taking longer to start than expected. Please check back shortly.':updatesDelayed?'Recent processing updates are unavailable. Your submission is recorded; preparation may still be running. Please check back shortly.':blockedKey?'Preparation is waiting for Project X to complete the pitch settings. No new recording is needed.':'');
  const stage=phonePreparationStages[p.stage_code]||phoneLabels[snapshot.phase]||'Preparing your voice profile.';
  $('phoneTrainingStatus').textContent=alert?'Preparation delayed. Last reported stage: '+stage:stage;
  const fresh=Number.isFinite(updated)&&now-updated<=120000;
  const end=terminal?(Number.isFinite(finished)?finished:updated):now;
  if(Number.isFinite(submitted)&&Number.isFinite(end)){
    const seconds=Math.max(0,Math.floor((end-submitted)/1000)),hours=Math.floor(seconds/3600);
    const clock=(hours?hours+':':'')+String(Math.floor(seconds%3600/60)).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0');
    $('phonePreparationTime').textContent=(snapshot.phase==='READY'?'Time from submission to ready: ':alert?'Time since submission (updates delayed): ':'Time since submission: ')+clock;
  }else $('phonePreparationTime').textContent='';
  if(snapshot.phase==='READY')$('phonePreparationCheckBack').textContent='Your voice profile is ready. You can now choose your birthday song.';
  else if(terminal)$('phonePreparationCheckBack').textContent='Additional recordings have not been requested. Contact Project X at sdp.projectx.contact@gmail.com.';
  else if(alert)$('phonePreparationCheckBack').textContent=alert;
  else $('phonePreparationCheckBack').textContent='Allow 1 to 2 hours for preparation once processing begins. This is an estimate; waiting time or technical issues can make it longer. Check back in about 10 minutes, or leave this page open for automatic updates.'+(!fresh&&snapshot.phase!=='QUEUED'?' A recent progress update is not available; preparation may still be running.':'');
}
setInterval(()=>{if(!$('phoneTrainingCard').hidden)renderPhonePreparation();},1000);
function showPhoneTraining(session){
  cancelTransferCompleteTimer();activeSession=session;phoneSnapshot=null;
  clearSavedPlayback();releaseMic();clearTick();resetAudioMeter();
  $('captureCard').hidden=true;$('startCard').hidden=true;$('transferCompleteCard').hidden=true;
  $('phoneTrainingCard').hidden=false;
  if(typeof guidedProgress==='function')guidedProgress();
  $('phoneTrainingSession').textContent=`Session ${session.session_id}`;
  $('phoneTrainingStatus').textContent=phoneLabels.QUEUED;
  $('phoneTrainingCard').scrollIntoView({behavior:'smooth',block:'start'});
  refreshPhoneTraining();
}
async function refreshPhoneTraining(){
  if(phoneRefreshBusy||!activeSession?.phone_training?.accepted||$('phoneTrainingCard').hidden)return;
  phoneRefreshBusy=true;const sid=activeSession.session_id;
  try{
    const snapshot=await api(`/api/sessions/${encodeURIComponent(sid)}/phone-flow`,{cache:'no-store'});
    if(activeSession?.session_id!==sid||snapshot.session_id!==sid)return;
    phoneSnapshot=snapshot;phoneRefreshFailed=false;
    const preparationChecked=Date.parse(snapshot.preparation?.checked_at);
    phonePreparationClockOffset=Number.isFinite(preparationChecked)?preparationChecked-Date.now():0;
    $('phoneTrainingStatus').textContent=phonePreparationStages[snapshot.preparation?.stage_code]||phoneLabels[snapshot.phase]||'Processing your voice profile.';
    $('phoneTrainingProgress').textContent=snapshot.preparation?.stage_code==='TRAINING'&&snapshot.epoch?`Training progress: ${snapshot.epoch} of 300 passes. Verification still follows training.`:'';
    renderPhonePreparation();
    $('phoneTrainingHelp').textContent=snapshot.phase==='READY'?'Your voice profile is ready. Return to My Orders or choose a song.':'You can leave and return to this session or My Orders after signing in to the same account.';
    const revision=JSON.stringify([sid,snapshot.phase,snapshot.package_id,snapshot.selection_pending,snapshot.options]);
    if(revision!==phoneOptionsRevision){
      phoneOptionsRevision=revision;const wrap=$('phoneKeyOptions');wrap.replaceChildren();
      if(snapshot.phase==='KEY_SELECTION'&&activeSession?.program==='LIMITED_HELPER_PILOT'){
        const guidance=document.createElement('p');guidance.textContent=`Round ${snapshot.round}: listen to each preview, then choose one. A suggested key is only a starting point.`;wrap.appendChild(guidance);
        for(const option of snapshot.options){
          const card=document.createElement('div');card.className='option';
          const label=document.createElement('h3');label.textContent=`${option.label}${option.key?' · '+option.key:''}${option.suggested?' · Suggested start':''}`;
          const audio=document.createElement('audio');audio.controls=true;audio.preload='none';audio.src=option.url;audio.style.width='100%';
          audio.addEventListener('play',()=>wrap.querySelectorAll('audio').forEach(other=>{if(other!==audio)other.pause();}));
          const button=document.createElement('button');button.className='primary';button.type='button';button.textContent='Choose this preview';button.disabled=snapshot.selection_pending||phoneChoiceBusy;
          button.addEventListener('click',()=>choosePhoneKey(sid,snapshot.package_id,option.shift));
          card.append(label,audio,button);wrap.appendChild(card);
        }
        if(snapshot.selection_pending){const pending=document.createElement('p');pending.textContent='Applying your choice…';wrap.appendChild(pending);}
      }
    }
    $('phoneTrainingEnd').hidden=!['READY','FAILED','REVIEW_REQUIRED'].includes(snapshot.phase);
  }catch(error){if(activeSession?.session_id===sid){phoneRefreshFailed=true;renderPhonePreparation();$('phoneTrainingHelp').textContent='We could not refresh progress. Your submission is recorded. This page will retry automatically; please do not submit again.';}}
  finally{phoneRefreshBusy=false;}
}
async function choosePhoneKey(sid,packageId,shift){
  if(phoneChoiceBusy||activeSession?.session_id!==sid)return;
  phoneChoiceBusy=true;$('phoneKeyOptions').querySelectorAll('button').forEach(b=>b.disabled=true);
  try{await api(`/api/sessions/${encodeURIComponent(sid)}/phone-key`,{method:'POST',headers:csrfHeaders(),body:JSON.stringify({package_id:packageId,shift})});}
  catch(error){$('phoneTrainingHelp').textContent=error.message;}
  finally{phoneChoiceBusy=false;phoneOptionsRevision='';await refreshPhoneTraining();}
}
$('phoneTrainingEnd').addEventListener('click',async()=>{
  if(!phoneSnapshot||!['READY','FAILED','REVIEW_REQUIRED'].includes(phoneSnapshot.phase))return;
  $('phoneTrainingEnd').disabled=true;
  try{await refreshSessions();activeSession=null;phoneSnapshot=null;phoneOptionsRevision='';$('phoneKeyOptions').replaceChildren();$('phoneTrainingCard').hidden=true;$('startCard').hidden=false;$('startCard').scrollIntoView({behavior:'smooth',block:'start'});guidedResetIntro();setStatus('You can begin a new recording session or return to Project X.');}
  catch(error){$('phoneTrainingHelp').textContent='Could not refresh the page. Tap Start another recording session to try again.';}
  finally{$('phoneTrainingEnd').disabled=false;}
});
setInterval(refreshPhoneTraining,5000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshPhoneTraining();});

// PX_READABLE_SECTION_PICKER
function sectionPickerTitle(section) {
  return String(section.title||'').replace(/^\s*\d+:\d+\s*[â€“â€”-]\s*\d+:\d+\s*[Â·:]\s*/, '').trim();
}
function closeSectionPicker() {
  $('sectionPickerList').hidden=true;
  $('sectionPickerToggle').setAttribute('aria-expanded','false');
}
function updateReadableSectionPicker() {
  const toggle=$('sectionPickerToggle');
  toggle.disabled=$('sectionSelect').disabled||busy;
  if(toggle.disabled)closeSectionPicker();
  const section=config?.sections?.find(item=>item.id===Number(activeSectionId));
  if(!section)return;
  $('sectionPickerSelected').textContent=`Section ${section.id}${section.optional?' Â· Optional':''}: ${sectionPickerTitle(section)}`;
  const selectedFlag=sectionFlag(sessionTakes(section.id).length);
  toggle.dataset.state=selectedFlag.state;
  $('sectionPickerStatus').textContent=selectedFlag.label;
  const list=$('sectionPickerList');list.replaceChildren();
  for(const item of config.sections) {
    if(!item.configured)continue;
    const row=document.createElement('button');row.type='button';row.className='section-picker-row';
    row.setAttribute('aria-pressed',String(item.id===Number(activeSectionId)));
    row.dataset.state=sectionFlag(sessionTakes(item.id).length).state;
    const number=document.createElement('span');number.className='section-picker-number';number.textContent=`Section ${item.id}${item.optional?' Â· Optional':''}`;
    const title=document.createElement('span');title.className='section-picker-title';title.textContent=sectionPickerTitle(item);
    const progress=document.createElement('span');progress.className='section-picker-progress';progress.textContent=sectionFlag(sessionTakes(item.id).length).label;
    row.append(number,title,progress);
    row.addEventListener('click',()=>{
      if($('sectionSelect').disabled||busy)return;
      $('sectionSelect').value=String(item.id);
      closeSectionPicker();handleSectionMenuChange();updateReadableSectionPicker();toggle.focus();
    });
    list.appendChild(row);
  }
}
$('sectionPickerToggle').addEventListener('click',()=>{
  if($('sectionSelect').disabled||busy)return;
  const opening=$('sectionPickerList').hidden;
  updateReadableSectionPicker();$('sectionPickerList').hidden=!opening;
  $('sectionPickerToggle').setAttribute('aria-expanded',String(opening));
  if(opening)$('sectionPickerList').querySelector('button[aria-pressed="true"]')?.focus();
});
$('sectionPickerList').addEventListener('keydown',event=>{
  if(event.key==='Escape'){closeSectionPicker();$('sectionPickerToggle').focus();}
});
new MutationObserver(updateReadableSectionPicker).observe($('sectionSelect'),{attributes:true,attributeFilter:['disabled']});

// Return links also work on signed-out and error screens.
document.querySelectorAll('.return-project-x').forEach(link=>{
  link.addEventListener('click',event=>{
    if(busy||takeBlob||mediaRecorder?.state==='recording'){
      event.preventDefault();
      setStatus(takeBlob&&!busy
        ? 'Retry saving or discard the unsaved take before returning to Project X.'
        : 'Finish the current action and wait for your take to save before returning to Project X.');
    }
  });
});
$('chooseOtherProgress').addEventListener('click',()=>{
  showProgressReturn('Choose the submitted recording whose progress you want to view.');
  $('progressSessionChoices').hidden=false;
});
$('openProgressSession').addEventListener('click',async()=>{
  try{await openProgressSession($('progressSessions').value);}
  catch(error){showProgressReturn(error.message);$('progressSessionChoices').hidden=false;}
});
let progressReturnBusy=false;
$('retryProgressReturn').addEventListener('click',async()=>{
  if(progressReturnBusy)return;
  progressReturnBusy=true;$('retryProgressReturn').disabled=true;
  try{const sessions=await refreshSessions();await returnToVoiceProgress(sessions);}
  catch(error){showProgressReturn('Could not refresh your progress. Return to Project X and sign in again if needed.');}
  finally{progressReturnBusy=false;$('retryProgressReturn').disabled=false;}
});
// Initialization is started by capture-guided.js after the page is wired.
