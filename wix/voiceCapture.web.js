import { webMethod, Permissions } from 'wix-web-module';
import { currentMember } from 'wix-members-backend';
import { members } from 'wix-members.v2';
import { elevate } from 'wix-auth';
import { getSecret } from 'wix-secrets-backend';
import { createHmac, randomBytes } from 'crypto';

const SECRET_NAME = 'PX_VOICE_CAPTURE_HANDOFF_SECRET';
const readMember = elevate(members.getMember);

function name(value) {
  if (typeof value !== 'string') throw new Error('Enter your first and last names.');
  const result = value.trim();
  if (!result || result.length > 100 || /[\u0000-\u001f\u007f]/.test(result)) {
    throw new Error('Enter valid first and last names, each at most 100 characters.');
  }
  return result;
}

async function ownMember() {
  const signedIn = await currentMember.getMember({ fieldsets: ['FULL'] });
  if (!signedIn?._id) throw new Error('Sign in to your Project X account first.');
  // The elevated read can only target the ID derived from this caller's session.
  const member = await readMember(signedIn._id, { fieldsets: ['FULL'] });
  if (member?._id !== signedIn._id || !member.loginEmail ||
      member.loginEmail.trim().toLowerCase() !== signedIn.loginEmail?.trim().toLowerCase()) {
    throw new Error('Your signed-in account could not be confirmed.');
  }
  return member;
}

function names(member) {
  return {
    firstName: typeof member.contact?.firstName === 'string' ? member.contact.firstName.trim() : '',
    lastName: typeof member.contact?.lastName === 'string' ? member.contact.lastName.trim() : ''
  };
}

function nameStatus(member) {
  const value = names(member);
  let complete = false;
  try { name(value.firstName); name(value.lastName); complete = true; } catch { /* Missing names need completion. */ }
  return {memberId:member._id, ...value, complete};
}

export const getCustomerNameStatus = webMethod(Permissions.SiteMember,
  async () => nameStatus(await ownMember()));

export const saveCustomerNames = webMethod(Permissions.SiteMember, async (input, expectedMemberId) => {
  if (!input || Object.keys(input).some(key => !['firstName','lastName'].includes(key))) {
    throw new Error('Only your first and last names can be saved here.');
  }
  const requested = {firstName:name(input.firstName), lastName:name(input.lastName)};
  const member = await ownMember();
  if (typeof expectedMemberId !== 'string' || member._id !== expectedMemberId) {
    throw new Error('The signed-in account changed. Please reload this page.');
  }
  const existing = names(member), contact = {};
  for (const key of ['firstName','lastName']) {
    if (existing[key] && existing[key] !== requested[key]) {
      throw new Error('An existing account name differs. Contact Project X to correct it.');
    }
    if (!existing[key]) contact[key] = requested[key];
  }
  if (Object.keys(contact).length) await members.updateMember(member._id, {contact});
  const confirmed = await ownMember();
  if (confirmed._id !== member._id || names(confirmed).firstName !== requested.firstName ||
      names(confirmed).lastName !== requested.lastName) {
    throw new Error('Your saved names could not be confirmed. Please reload this page.');
  }
  return nameStatus(confirmed);
});

function base64url(value) {
  return Buffer.from(value).toString('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export const issueVoiceCaptureTicket = webMethod(
  Permissions.SiteMember,
  async (options = {}) => {
    const member = await ownMember();
    if (!member?._id) throw new Error('Sign in to your Project X account first.');

    const {firstName, lastName} = names(member);
    // Default handoffs still allow old accounts to read agreements and recordings.
    if (options?.requireNames === true && !nameStatus(member).complete) return {nameRequired:true};
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
