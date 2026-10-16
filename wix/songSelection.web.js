import { webMethod, Permissions } from 'wix-web-module';
import { currentMember } from 'wix-members-backend';
import { getSecret } from 'wix-secrets-backend';
import { fetch } from 'wix-fetch';
import wixData from 'wix-data';
import { createHmac, randomBytes } from 'crypto';

const SECRET_NAME = 'PX_VOICE_CAPTURE_HANDOFF_SECRET';
const BACKEND_URL = 'https://sdp-backend-6xt7.onrender.com';
const COLLECTION_ID = 'SongCatalog';
const PROFILE_STATES = new Set(['MISSING','RECORDING','PROCESSING','READY','FAILED','REVOKED']);
const validText = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 200;

function base64url(value) {
  return Buffer.from(value).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
async function requireMemberId() {
  const member = await currentMember.getMember({fieldsets:['FULL']});
  if (!validText(member?._id) || member._id.length < 3) throw new Error('Sign in to your Project X account first.');
  return member._id;
}
async function signedTicket(memberId, purpose, extraClaims = {}) {
  const key = await getSecret(SECRET_NAME);
  if (typeof key !== 'string' || Buffer.byteLength(key, 'utf8') < 32) {
    throw new Error('Project X sign-in has not been configured. Contact Project X.');
  }
  const now = Math.floor(Date.now() / 1000);
  const claims = {...extraClaims,iss:'wix',aud:'project-x-catalog',purpose,sub:memberId,
    iat:now,exp:now+120,jti:randomBytes(24).toString('hex')};
  const body = base64url(JSON.stringify(claims));
  const signature = base64url(createHmac('sha256',key).update(body).digest());
  return `${body}.${signature}`;
}
async function postTicket(endpoint,ticket) {
  let response;
  try {
    response = await fetch(`${BACKEND_URL}${endpoint}`,{method:'POST',
      headers:{'Content-Type':'application/json'},body:JSON.stringify({ticket})});
  } catch { throw new Error('Could not reach Project X. Please try again.'); }
  let result;
  try { result = await response.json(); }
  catch { throw new Error(`Project X returned an unreadable response (HTTP ${response.status}).`); }
  if (!response.ok) {
    const detail = validText(result?.error) ? result.error : 'The request could not be completed.';
    throw new Error(`Project X (HTTP ${response.status}): ${detail}`);
  }
  return result;
}

export const getVoiceProfileStatus = webMethod(Permissions.SiteMember,async () => {
  const memberId = await requireMemberId();
  const ticket = await signedTicket(memberId,'voice-profile-status');
  const result = await postTicket('/api/wix/voice-profile-status',ticket);
  if (!result || !PROFILE_STATES.has(result.status)) throw new Error('Project X returned an invalid voice-profile status.');
  const profiles = result.profiles === undefined ? [] : result.profiles;
  if (!Array.isArray(profiles) || profiles.some(p => !p || !PROFILE_STATES.has(p.status)
    || typeof p.selectable !== 'boolean' || !validText(p.label)
    || (p.selectable && (p.status !== 'READY' || !validText(p.voice_profile_id))))) {
    throw new Error('Project X returned an invalid voice-profile list.');
  }
  return {status:result.status,
    defaultVoiceProfileId:validText(result.default_voice_profile_id) ? result.default_voice_profile_id : '',
    profiles:profiles.map(p => ({voiceProfileId:validText(p.voice_profile_id) ? p.voice_profile_id : '',
      label:p.label,status:p.status,selectable:p.selectable,
      createdAt:typeof p.created_at === 'string' ? p.created_at : '',
      updatedAt:typeof p.updated_at === 'string' ? p.updated_at : '',
      deletionRequested:p.deletion_requested === true,
      deletionStatus:typeof p.deletion_status === 'string' ? p.deletion_status : '',
      previewAvailable:false}))};
});

export const requestVoiceProfileDeletion = webMethod(Permissions.SiteMember,async (voiceProfileId,confirmed) => {
  const memberId = await requireMemberId();
  if (!validText(voiceProfileId) || confirmed !== true) throw new Error('Choose and confirm the exact voice profile to delete.');
  const ticket = await signedTicket(memberId,'profile-deletion-request',{voice_profile_id:voiceProfileId,confirm_profile_deletion:true});
  const result = await postTicket('/api/wix/request-profile-deletion',ticket);
  if (result?.ok !== true || result.voice_profile_id !== voiceProfileId || !['REQUESTED','CLAIMED','PARTIAL','DELETED'].includes(result.status)) throw new Error('The profile deletion response did not match your selection.');
  return {ok:true,status:result.status,voiceProfileId:result.voice_profile_id,requestId:result.request_id,accountDeleted:false,physicalDeletionVerified:result.physical_deletion_verified === true};
});

export const createSongSelectionRequest = webMethod(Permissions.SiteMember,async () => {
  await requireMemberId();
  return {requestId:randomBytes(24).toString('hex')};
});

export const selectSong = webMethod(Permissions.SiteMember,async (catalogItemId,requestId,voiceProfileId) => {
  const memberId = await requireMemberId();
  if (!validText(catalogItemId)) throw new Error('The song catalog item is invalid.');
  if (typeof requestId !== 'string' || !/^[a-f0-9]{48}$/.test(requestId)) {
    throw new Error('The selection request is invalid. Start a new selection.');
  }
  if (voiceProfileId !== undefined && !validText(voiceProfileId)) throw new Error('Choose an available voice profile.');
  const song = await wixData.get(COLLECTION_ID,catalogItemId);
  if (!song || song._id !== catalogItemId) throw new Error('This song was not found in the catalog.');
  if (typeof song.pxSongId !== 'string' || !/^PX[0-9]{6}$/.test(song.pxSongId)) {
    throw new Error('This song is missing a valid Project X song ID.');
  }
  const extraClaims = {request_id:requestId,catalog_item_id:song._id,px_song_id:song.pxSongId};
  // The browser chooses an ID. Render independently verifies current ownership,
  // readiness and eligibility; this signature is not profile-release authority.
  if (voiceProfileId !== undefined) extraClaims.voice_profile_id = voiceProfileId;
  const ticket = await signedTicket(memberId,'song-selection',extraClaims);
  const result = await postTicket('/api/wix/song-selection',ticket);
  if (!result || result.ok !== true || result.status !== 'SELECTED'
    || result.px_song_id !== song.pxSongId || !validText(result.selection_id)
    || (voiceProfileId !== undefined && result.voice_profile_id !== voiceProfileId)) {
    throw new Error('Project X could not confirm the saved song selection.');
  }
  return {ok:true,status:'SELECTED',selectionId:result.selection_id,pxSongId:result.px_song_id,
    voiceProfileId:validText(result.voice_profile_id) ? result.voice_profile_id : ''};
});
