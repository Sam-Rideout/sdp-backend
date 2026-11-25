import { authentication, currentMember } from 'wix-members-frontend';
import wixLocationFrontend from 'wix-location-frontend';
import { issueVoiceCaptureTicket } from 'backend/voiceCapture.web';

const CAPTURE_URL = 'https://sdp-backend-6xt7.onrender.com/voice-capture';

function bounded(promise) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Please try opening voice capture again.')), 20000);
  })]).finally(() => clearTimeout(timer));
}

$w.onReady(function () {
  const button = $w('#button5');
  let opening = false, revision = 0;
  button.label = 'Go To Voice Capture';
  authentication.onLogout(() => { revision++; });
  button.onClick(async () => {
    if (opening) return;
    opening = true; button.disable();
    let navigating = false;
    try {
      if (!authentication.loggedIn()) await authentication.promptLogin({mode:'login'});
      if (!authentication.loggedIn()) return;
      const version = revision;
      const before = await bounded(currentMember.getMember());
      if (!before?._id) throw new Error('Sign in could not be confirmed.');
      button.label = 'Checking your account…';
      const result = await bounded(issueVoiceCaptureTicket({requireNames:true}));
      const after = await bounded(currentMember.getMember());
      if (version !== revision || !authentication.loggedIn() || before._id !== after?._id) throw new Error('The account changed.');
      if (result.nameRequired === true) {
        wixLocationFrontend.to('/complete-profile');
      } else {
        if (typeof result.ticket !== 'string' || !result.ticket) throw new Error('Sign-in handoff unavailable.');
        wixLocationFrontend.to(CAPTURE_URL + '#ticket=' + encodeURIComponent(result.ticket));
      }
      navigating = true;
    } catch {
      button.label = 'Please Try Again';
    } finally {
      if (!navigating) { opening = false; button.enable(); }
    }
  });
});
