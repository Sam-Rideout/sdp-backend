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
  const button = $w('#button5');
  const first = $w('#firstNameInput'), last = $w('#lastNameInput');
  const status = $w('#nameStatusText');
  let revision = 0, opening = null, form = null;

  function clearNames() {
    form = null;
    first.value = ''; last.value = '';
    first.disable(); last.disable();
    first.collapse(); last.collapse();
  }
  function message(text) {
    status.text = text;
    if (text) status.expand();
    else status.collapse();
  }
  function label() {
    button.label = form ? 'Save and Go To Voice Capture' : 'Go To Voice Capture';
  }
  clearNames(); message(''); label();

  authentication.onLogout(() => {
    revision++; opening = null;
    clearNames(); message(''); label(); button.enable();
  });

  button.onClick(async () => {
    if (opening) return;
    const action = {revision};
    opening = action; button.disable(); message('');
    let navigating = false;
    const current = () => opening === action && action.revision === revision && authentication.loggedIn();
    async function confirmAccount(memberId) {
      const member = await bounded(currentMember.getMember());
      if (!current() || member?._id !== memberId) throw new Error('The signed-in account changed. Please try again.');
    }

    try {
      if (!authentication.loggedIn()) await authentication.promptLogin({mode:'login'});
      if (!current()) return;
      const member = await bounded(currentMember.getMember());
      if (!current()) return;
      if (!member?._id) throw new Error('Your sign-in could not be confirmed.');

      if (form && form.memberId !== member._id) {
        clearNames();
        throw new Error('The signed-in account changed. Please try again.');
      }
      if (form) {
        button.label = 'Saving your names…';
        const saved = await bounded(saveCustomerNames({firstName:first.value, lastName:last.value}, member._id));
        await confirmAccount(member._id);
        if (saved.memberId !== member._id || saved.complete !== true) throw new Error('Your saved names could not be confirmed. Please try again.');
        clearNames();
      }

      button.label = 'Checking your account…';
      const result = await bounded(issueVoiceCaptureTicket({requireNames:true}));
      await confirmAccount(member._id);
      if (result?.nameRequired === true) {
        const details = await bounded(getCustomerNameStatus());
        await confirmAccount(member._id);
        if (details.memberId !== member._id) throw new Error('Your account names could not be confirmed.');
        if (details.complete) throw new Error('Your names are saved. Please try Go To Voice Capture again.');
        form = details;
        first.value = details.firstName; last.value = details.lastName;
        if (!details.firstName) { first.enable(); first.expand(); }
        if (!details.lastName) { last.enable(); last.expand(); }
        message('Please enter your missing account name details, then select Save and Go To Voice Capture. Saving names does not accept an agreement.');
        return;
      }
      if (typeof result?.ticket !== 'string' || !result.ticket) throw new Error('Voice capture sign-in is unavailable. Please try again.');
      wixLocationFrontend.to(CAPTURE_URL + '#ticket=' + encodeURIComponent(result.ticket));
      navigating = true;
    } catch (error) {
      if (opening === action && action.revision === revision) message(error?.message || 'Voice capture could not be opened. Please try again.');
    } finally {
      if (opening === action && !navigating) {
        opening = null; label(); button.enable();
      }
    }
  });
});
