import { authentication } from 'wix-members-frontend';
import wixLocationFrontend from 'wix-location-frontend';
import { issueVoiceCaptureTicket } from 'backend/voiceCapture.web';
import { getVoiceProfileStatus, createSongSelectionRequest, selectSong } from 'backend/songSelection.web';

const CAPTURE_URL = 'https://sdp-backend-6xt7.onrender.com/voice-capture';
const MY_ORDERS_URL = 'https://brightlight506.wixstudio.com/sdp-songs/blank-7';

$w.onReady(() => {
  const button = $w('#chooseSongButton');
  const statusText = $w('#songSelectionStatus');
  const dataset = $w('#dynamicDataset');
  const picker = $w('#voiceProfileDropdown');
  let state = 'CHECKING', version = 0, accountVersion = 0, busy = false;
  let datasetReady = false, song = null, pending = null, selected = null;
  let profiles = [], chosenProfileId = '';

  function validSong() {
    return Boolean(song && typeof song._id === 'string' && song._id &&
      typeof song.pxSongId === 'string' && /^PX[0-9]{6}$/.test(song.pxSongId));
  }
  function chosenProfile() {
    return profiles.find(p => p.voiceProfileId === chosenProfileId && p.selectable && p.status === 'READY');
  }
  function syncPickerValue() {
    if (chosenProfileId) picker.value = chosenProfileId;
    else picker.selectedIndex = undefined;
  }
  function clearProfiles() {
    profiles = []; chosenProfileId = ''; picker.options = []; syncPickerValue(); picker.disable();
  }
  function profileLabel(profile) {
    return profile.label;
  }
  function openOrders() {
    if (!MY_ORDERS_URL.startsWith('https://') || !selected ||
      typeof selected.selectionId !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(selected.selectionId)) {
      throw new Error('My Orders navigation is not configured or the selection identity is invalid.');
    }
    const separator = MY_ORDERS_URL.includes('?') ? '&' : '?';
    wixLocationFrontend.to(`${MY_ORDERS_URL}${separator}selection=${encodeURIComponent(selected.selectionId)}`);
  }
  function render(nextState) {
    state = nextState; button.disable(); picker.disable(); button.label = 'Choose This Song';
    const messages = {
      CHECKING:'Checking your voice profiles...',
      SIGNED_OUT:'You can browse and listen. Sign in to choose a song.',
      MISSING:'Create your voice profile before choosing a song.',
      RECORDING:'Finish and submit your voice recordings before choosing a song.',
      PROCESSING:'Your voice profile is being prepared. Please check back later.',
      READY:'Choose the voice profile you want to use for this song.',
      FAILED:'Your voice profile needs attention. Please contact Project X.',
      REVOKED:'Your voice profile is unavailable. Please contact Project X.',
      ERROR:'We could not check your voice profiles. Tap to try again.'
    };
    statusText.text = messages[nextState] || messages.ERROR;
    const labels = {SIGNED_OUT:'Sign In to Choose',MISSING:'Create Voice Profile',
      RECORDING:'Resume Voice Recording',ERROR:'Check Voice Profiles'};
    if (labels[nextState]) button.label = labels[nextState];
    if (nextState === 'READY') {
      if (!chosenProfile()) { statusText.text = 'No selectable voice profile is available. Please check again.'; return; }
      if (!busy) picker.enable();
      if (!datasetReady) { statusText.text = 'Loading this song...'; return; }
      if (!validSong()) { statusText.text = 'This song is missing its Project X song ID. Please contact Project X.'; return; }
      if (selected && selected.itemId === song._id && selected.voiceProfileId === chosenProfileId) {
        button.label = 'View My Orders'; statusText.text = `Your selection is saved: ${selected.pxSongId}.`;
        if (!busy) button.enable(); return;
      }
      const profile = chosenProfile();
      statusText.text = `Selected: ${profileLabel(profile)}.\nFull title: ${profile.technicalTitle || profile.label}\nChoose this song to continue.`;
    }
    if (!busy && ['SIGNED_OUT','MISSING','RECORDING','READY','ERROR'].includes(nextState)) button.enable();
  }
  function readSong() {
    try {
      const next = dataset.getCurrentItem();
      if (!song || !next || next._id !== song._id || next.pxSongId !== song.pxSongId) { pending = null; selected = null; }
      song = next;
    } catch (error) { console.error('Could not read the displayed song:',error); song = null; }
    render(state);
  }
  async function refreshAccess() {
    const requestVersion = ++version;
    if (!authentication.loggedIn()) { clearProfiles(); render('SIGNED_OUT'); return; }
    render('CHECKING');
    try {
      const result = await getVoiceProfileStatus();
      if (requestVersion !== version) return;
      if (!authentication.loggedIn()) { clearProfiles(); render('SIGNED_OUT'); return; }
      profiles = Array.isArray(result.profiles) ? result.profiles.filter(p =>
        p.selectable === true && p.status === 'READY' && typeof p.voiceProfileId === 'string' && p.voiceProfileId) : [];
      const previous = chosenProfileId;
      if (!profiles.some(p => p.voiceProfileId === chosenProfileId)) {
        chosenProfileId = profiles.some(p => p.voiceProfileId === result.defaultVoiceProfileId)
          ? result.defaultVoiceProfileId : profiles[0]?.voiceProfileId || '';
      }
      if (previous && previous !== chosenProfileId) { pending = null; selected = null; }
      picker.options = profiles.map(p => ({label:profileLabel(p),value:p.voiceProfileId}));
      syncPickerValue();
      render(result.status === 'READY' && !chosenProfile() ? 'ERROR' : result.status);
    } catch (error) {
      if (requestVersion !== version) return;
      console.error('Could not check voice profiles:',error);
      clearProfiles(); render(authentication.loggedIn() ? 'ERROR' : 'SIGNED_OUT');
    }
  }
  picker.onChange(() => {
    if (busy) { syncPickerValue(); return; }
    const next = profiles.find(p => p.voiceProfileId === picker.value && p.selectable);
    if (!next) { syncPickerValue(); return; }
    if (next.voiceProfileId !== chosenProfileId) {
      ++version; chosenProfileId = next.voiceProfileId; pending = null; selected = null;
    }
    render(state);
  });
  button.onClick(async () => {
    if (busy) return;
    busy = true; button.disable(); picker.disable();
    const actionAccount = accountVersion, actionItem = song && song._id, actionProfile = chosenProfileId;
    const stillCurrent = () => actionAccount === accountVersion && authentication.loggedIn() &&
      song && song._id === actionItem && chosenProfileId === actionProfile;
    let notice = '', navigating = false;
    try {
      if (!authentication.loggedIn()) { await authentication.promptLogin({mode:'login'}); }
      else if (state === 'MISSING' || state === 'RECORDING') {
        const {ticket} = await issueVoiceCaptureTicket();
        if (actionAccount !== accountVersion || !authentication.loggedIn()) return;
        ++version; wixLocationFrontend.to(`${CAPTURE_URL}#ticket=${encodeURIComponent(ticket)}`); navigating = true;
      } else if (state === 'READY' && validSong() && chosenProfile()) {
        if (selected && selected.itemId === actionItem && selected.voiceProfileId === actionProfile) {
          openOrders(); navigating = true; return;
        }
        ++version; statusText.text = 'Saving your song and voice-profile selection...'; button.label = 'Saving Selection...';
        if (!pending || pending.itemId !== actionItem || pending.voiceProfileId !== actionProfile) {
          const request = await createSongSelectionRequest();
          if (!stillCurrent()) return;
          pending = {itemId:actionItem,voiceProfileId:actionProfile,requestId:request.requestId};
        }
        const result = await selectSong(actionItem,pending.requestId,actionProfile);
        if (!stillCurrent()) return;
        if (result.ok === true && result.status === 'SELECTED' && result.voiceProfileId === actionProfile) {
          selected = {itemId:actionItem,voiceProfileId:actionProfile,pxSongId:result.pxSongId,selectionId:result.selectionId};
          statusText.text = 'Your selection is saved. Opening My Orders...'; openOrders(); navigating = true;
        } else { notice = 'Your selection could not be confirmed. Please try again.'; }
      }
    } catch (error) {
      console.error('Could not complete action:',error);
      notice = selected ? 'Your selection is saved. Tap View My Orders to continue.' : 'The action could not be confirmed. Please try again.';
    } finally {
      busy = false;
      if (!navigating) await refreshAccess();
      if (notice && actionAccount === accountVersion && state === 'READY' && song && song._id === actionItem) statusText.text = notice;
    }
  });
  authentication.onLogin(() => {
    ++accountVersion; pending = null; selected = null; clearProfiles(); refreshAccess();
  });
  authentication.onLogout(() => {
    ++accountVersion; ++version; pending = null; selected = null; clearProfiles(); render('SIGNED_OUT');
  });
  dataset.onReady(() => { datasetReady = true; readSong(); });
  dataset.onCurrentIndexChanged(() => { if (datasetReady) readSong(); });
  clearProfiles(); refreshAccess();
});
