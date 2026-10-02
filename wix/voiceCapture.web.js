import { webMethod, Permissions } from 'wix-web-module';
import { currentMember } from 'wix-members-backend';
import { getSecret } from 'wix-secrets-backend';
import { createHmac, randomBytes } from 'crypto';

const SECRET_NAME = 'PX_VOICE_CAPTURE_HANDOFF_SECRET';

function base64url(value) {
  return Buffer.from(value).toString('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export const issueVoiceCaptureTicket = webMethod(
  Permissions.SiteMember,
  async () => {
    const member = await currentMember.getMember();
    if (!member?._id) throw new Error('Sign in to your Project X account first.');

    const key = await getSecret(SECRET_NAME);
    if (typeof key !== 'string' || Buffer.byteLength(key, 'utf8') < 32) {
      throw new Error('Voice capture sign-in has not been configured. Contact Project X.');
    }

    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: 'wix',
      aud: 'project-x-voice-capture',
      purpose: 'voice-capture-access',
      sub: member._id,
      iat: now,
      exp: now + 120,
      jti: randomBytes(24).toString('hex')
    };
    const body = base64url(JSON.stringify(claims));
    const signature = createHmac('sha256', key).update(body).digest('base64url');
    return { ticket: `${body}.${signature}` };
  }
);
