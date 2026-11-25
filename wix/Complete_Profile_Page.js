import { authentication, currentMember } from 'wix-members-frontend';
import wixLocationFrontend from 'wix-location-frontend';
import { getCustomerNameStatus, saveCustomerNames, issueVoiceCaptureTicket } from 'backend/voiceCapture.web';

const CAPTURE_URL = 'https://sdp-backend-6xt7.onrender.com/voice-capture';

function bounded(promise) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('The request took too long. Please try again.')), 20000);
  })]).finally(() => clearTimeout(timer));
}

$w.onReady(function () {
  const first = $w('#firstNameInput'), last = $w('#lastNameInput');
  const button = $w('#saveNamesButton'), status = $w('#nameStatusText');
  let revision = 0, busy = false, memberId = '';
  button.label = 'Save and Go To Voice Capture';
  button.disable(); first.disable(); last.disable();
  const current = version => version === revision && authentication.loggedIn();

  authentication.onLogout(() => {
    revision++; memberId = ''; first.value = ''; last.value = '';
    first.disable(); last.disable(); button.disable();
    status.text = 'You have signed out. Reload this page to sign in again.';
  });

  async function load() {
    const version = ++revision;
    status.text = 'Loading your account names…';
    try {
      if (!authentication.loggedIn()) await authentication.promptLogin({mode:'login'});
      if (!current(version)) return;
      const result = await bounded(getCustomerNameStatus());
      if (!current(version)) return;
      const member = await bounded(currentMember.getMember());
      if (!current(version) || member?._id !== result.memberId) throw new Error('The signed-in account changed. Reload this page.');
      memberId = result.memberId;
      first.value = result.firstName; last.value = result.lastName;
      if (!result.firstName) first.enable();
      if (!result.lastName) last.enable();
      status.text = result.complete ? 'Your names are saved. Continue to voice capture.' : 'Please enter your first and last names. Saving names does not accept an agreement.';
      button.enable();
    } catch (error) {
      if (version === revision) status.text = error?.message || 'Your account could not be loaded. Reload this page.';
    }
  }

  button.onClick(async () => {
    if (busy || !memberId || !authentication.loggedIn()) return;
    busy = true; button.disable();
    const version = revision;
    try {
      status.text = 'Saving your names…';
      const before = await bounded(currentMember.getMember());
      if (!current(version) || before?._id !== memberId) throw new Error('The signed-in account changed. Reload this page.');
      const saved = await bounded(saveCustomerNames({firstName:first.value, lastName:last.value}));
      if (!current(version) || saved.memberId !== memberId || saved.complete !== true) throw new Error('Your saved names could not be confirmed.');
      first.value = saved.firstName; last.value = saved.lastName;
      first.disable(); last.disable();
      status.text = 'Opening voice capture…';
      const handoff = await bounded(issueVoiceCaptureTicket({requireNames:true}));
      const after = await bounded(currentMember.getMember());
      if (!current(version) || after?._id !== memberId) throw new Error('The signed-in account changed. Reload this page.');
      if (handoff.nameRequired || typeof handoff.ticket !== 'string' || !handoff.ticket) throw new Error('Your names are saved, but the handoff could not be confirmed. Please try again.');
      wixLocationFrontend.to(CAPTURE_URL + '#ticket=' + encodeURIComponent(handoff.ticket));
    } catch (error) {
      if (current(version)) status.text = error?.message || 'Your names could not be saved. Please try again.';
    } finally {
      busy = false;
      if (current(version)) button.enable();
    }
  });
  load();
});
