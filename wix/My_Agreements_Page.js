import { authentication, currentMember } from 'wix-members-frontend';
import wixLocationFrontend from 'wix-location-frontend';
import { issueVoiceCaptureTicket } from 'backend/voiceCapture.web';

function bounded(operation) {
    let timer;
    return Promise.race([
        Promise.resolve().then(operation),
        new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error('timeout')), 20000);
        })
    ]).finally(() => clearTimeout(timer));
}

$w.onReady(async function () {
    const status = $w('#textAgreementStatus');
    try {
        status.text = 'Opening your saved agreements…';
        if (!authentication.loggedIn()) {
            try { await authentication.promptLogin({ mode: 'login' }); }
            catch { status.text = 'Sign in to view your agreements, then reload this page.'; return; }
        }
        if (!authentication.loggedIn()) return;
        const member = await bounded(() => currentMember.getMember());
        if (!member?._id) throw new Error('account');
        const handoff = await bounded(() => issueVoiceCaptureTicket());
        const confirmed = await bounded(() => currentMember.getMember());
        if (!authentication.loggedIn() || confirmed?._id !== member._id ||
            typeof handoff?.ticket !== 'string' || !handoff.ticket.trim()) throw new Error('account');
        wixLocationFrontend.to('https://sdp-backend-6xt7.onrender.com/my-agreements#ticket=' + encodeURIComponent(handoff.ticket));
    } catch {
        status.text = 'Your agreements could not be opened. Please reload and try again.';
    }
});
