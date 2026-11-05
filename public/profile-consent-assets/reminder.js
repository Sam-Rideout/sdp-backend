(()=>{'use strict';
 window.PXShowConsentReminder=(expiresAt,action='signed')=>{
  const date=Number.isFinite(Date.parse(expiresAt))?new Intl.DateTimeFormat('en-CA',{dateStyle:'full',timeStyle:'long',timeZone:'America/Halifax'}).format(new Date(expiresAt)):'90 calendar days from signing';
  window.alert(`Consent ${action}.\n\nYour voice profile consent expires: ${date}.\n\nUnless you re-sign before that deadline, your profile becomes unavailable and its associated voice data is scheduled for deletion.\n\nWe will email you three days beforehand with a direct link to the consent page. If you have not renewed, we will send a last-chance email one day before deletion. Re-signing keeps your existing profile for a fresh 90 days—no re-recording or retraining is needed.`);
 };
})();
