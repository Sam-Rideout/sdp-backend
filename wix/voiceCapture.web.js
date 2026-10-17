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
    const member = await currentMember.getMember({ fieldsets: ['FULL'] });
    if (!member?._id) throw new Error('Sign in to your Project X account first.');

    const firstName = typeof member.contactDetails?.firstName === 'string' ? member.contactDetails.firstName.trim() : '';
    const lastName = typeof member.contactDetails?.lastName === 'string' ? member.contactDetails.lastName.trim() : '';
    const email = typeof member.loginEmail === 'string' ? member.loginEmail.trim().toLowerCase() : '';
    const validName = value => value.length <= 100 && !/[\u0000-\u001f\u007f]/.test(value);
    if (!validName(firstName) || !validName(lastName)) {
      throw new Error('Your profile names contain invalid characters or are too long.');
    }
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error('Your signed-in account needs a valid login email.');
    }

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
      email,
      customer_identity: {
        schema_version: 'PX-WIX-CUSTOMER-IDENTITY-1.0',
        member_id: member._id, email,
        first_name: firstName, last_name: lastName
      },
      iat: now,
      exp: now + 120,
      jti: randomBytes(24).toString('hex')
    };
    const body = base64url(JSON.stringify(claims));
    const signature = createHmac('sha256', key).update(body).digest('base64url');
    return { ticket: `${body}.${signature}` };
  }
);
