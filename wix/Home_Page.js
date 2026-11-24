import { authentication, currentMember } from 'wix-members-frontend';
import wixLocationFrontend from 'wix-location-frontend';
import { getVoiceProfileStatus } from 'backend/songSelection.web';
import { issueVoiceCaptureTicket } from 'backend/voiceCapture.web';

const CAPTURE_URL = 'https://sdp-backend-6xt7.onrender.com/voice-capture';
const OCCASION_URL = '/occasion';
const BEFORE_YOU_BEGIN_URL = '/blank-6';
const MY_ORDERS_URL = '/orders';

function homeDestination(result) {
    const states = ['MISSING', 'RECORDING', 'PROCESSING', 'READY', 'FAILED', 'REVOKED'];
    if (!result || !states.includes(result.status) || !Array.isArray(result.profiles)) {
        throw new Error('Voice profile status could not be confirmed.');
    }

    const ready = result.profiles.filter(profile =>
        profile && profile.status === 'READY' && profile.selectable === true &&
        profile.deletionRequested !== true &&
        typeof profile.voiceProfileId === 'string' && profile.voiceProfileId.trim()
    );

    // An available certified profile takes priority over a newer unfinished session.
    if (ready.length) {
        if (result.defaultVoiceProfileId &&
            !ready.some(profile => profile.voiceProfileId === result.defaultVoiceProfileId)) {
            throw new Error('Available voice profile could not be confirmed.');
        }
        return 'OCCASION';
    }
    if (result.status === 'READY') {
        throw new Error('Your ready profile is not currently available.');
    }
    if (result.hasProcessingProfile === true || result.status === 'PROCESSING') {
        return 'PROGRESS';
    }
    if (result.status === 'RECORDING') return 'RESUME_RECORDING';
    if (['MISSING', 'REVOKED'].includes(result.status)) return 'BEFORE_YOU_BEGIN';
    // A failed profile needs its existing guidance, not an automatic new recording.
    if (result.status === 'FAILED') return 'MY_ORDERS';
    throw new Error('Voice profile route is unavailable.');
}

const LOOKUP_TIMEOUT_MS = 20000;

async function checkedRequest(operation) {
    let timer;
    try {
        return await Promise.race([
            Promise.resolve().then(operation),
            new Promise((resolve, reject) => {
                timer = setTimeout(() => reject(new Error('Project X took too long to respond. Please try again.')), LOOKUP_TIMEOUT_MS);
            })
        ]);
    } finally {
        clearTimeout(timer);
    }
}

$w.onReady(function () {
    const button = $w('#createVoiceProfileButton');
    const normalLabel = 'Create My Gift Song';
    let opening = false;
    let accountVersion = 0;

    async function confirmAccount(memberId, version) {
        const member = await checkedRequest(() => currentMember.getMember());
        if (version !== accountVersion || !authentication.loggedIn() || member?._id !== memberId) {
            throw new Error('The signed-in account changed. Please try again.');
        }
    }

    // Attach the actual action before styling or optional event subscriptions.
    button.onClick(async function () {
        if (opening) return;
        opening = true;
        let failed = false;
        let navigating = false;
        let stage = 'checking sign-in';

        try {
            button.label = 'Checking your sign-in…';
            button.disable();
            if (!authentication.loggedIn()) {
                stage = 'opening sign-in';
                button.label = 'Sign in to continue';
                try {
                    await authentication.promptLogin({ mode: 'login' });
                } catch {
                    return; // Closing the sign-in window cancels this click.
                }
            }
            if (!authentication.loggedIn()) return;

            stage = 'confirming your account';
            button.label = 'Checking your account…';
            const version = accountVersion;
            const member = await checkedRequest(() => currentMember.getMember());
            if (!member?._id) throw new Error('Your sign-in could not be confirmed.');

            stage = 'checking your voice profile';
            button.label = 'Checking your voice profile…';
            const result = await checkedRequest(() => getVoiceProfileStatus());
            await confirmAccount(member._id, version);
            const destination = homeDestination(result);

            let url;
            if (destination === 'OCCASION') url = OCCASION_URL;
            else if (destination === 'BEFORE_YOU_BEGIN') url = BEFORE_YOU_BEGIN_URL;
            else if (destination === 'MY_ORDERS') url = MY_ORDERS_URL;
            else {
                stage = 'opening your recorder';
                button.label = destination === 'PROGRESS'
                    ? 'Opening your profile progress…' : 'Opening your saved recordings…';
                const handoff = await checkedRequest(() => issueVoiceCaptureTicket());
                await confirmAccount(member._id, version);
                if (typeof handoff?.ticket !== 'string' || !handoff.ticket.trim()) {
                    throw new Error('Voice capture handoff unavailable.');
                }
                url = CAPTURE_URL + (destination === 'PROGRESS' ? '?view=progress' : '') +
                    '#ticket=' + encodeURIComponent(handoff.ticket);
            }

            stage = 'opening the next page';
            wixLocationFrontend.to(url);
            navigating = true;
        } catch (error) {
            failed = true;
            button.label = 'Could not continue — try again';
            // Log the failing step only; never log a member record or signed ticket.
            console.error('PX Home: could not continue while ' + stage + '.');
        } finally {
            if (!navigating) {
                opening = false;
                button.enable();
                if (!failed) button.label = normalLabel;
            }
        }
    });

    button.label = normalLabel;
    button.enable();
    try {
        button.customClassList.add('px-home-start-button');
    } catch {
        console.warn('PX Home: button styling could not be applied.');
    }
    try {
        if (typeof authentication.onLogout === 'function') {
            authentication.onLogout(() => { accountVersion += 1; });
        }
    } catch {
        // Fresh member checks still protect each navigation if this optional hook fails.
        console.warn('PX Home: logout notification is unavailable; account checks remain active.');
    }
});
