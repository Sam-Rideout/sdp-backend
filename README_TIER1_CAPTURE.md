# Project X Tier 1 segmented capture (review build)

This source is based on `Sam-Rideout/sdp-backend` main at commit
`b27c2dae02b41f91c2aa94763a804795104fa768`. It adds member handoff, resumable
capture sessions, separately stored section takes, consent-version evidence,
and a verified Render-to-PC transfer flow.

## Current readiness

This is a review build and is **not ready to invite participants**:

- All eight exercise prompts from the current Tier 1 training script are in
  `config/capture-sections.json`. The page keeps each recording as a separate
  section/take and encourages repeating at least three numbered sections.
- The consent notice in that file is marked **DRAFT**. Replace it with the
  final approved notice and increment `consent_version` before enabling capture.
- The app refuses to create a recording session unless
  `VOICE_CONSENT_APPROVED=true` is set in Render.
- No recording is processed into a voice model by this app. It stores the
  participant's separate capture takes for the downstream, consent-governed
  workflow.

## Capture and file layout

The participant signs in through Wix, records a section, listens, and chooses
**Save this take**. Every saved take is a separate original browser audio file;
a retake gets a new take number and does not overwrite earlier audio. Each
session has a JSON manifest containing the Wix member ID, section/take numbers,
timestamps, byte counts, audio hashes, and the version/hash of the consent
notice accepted at session creation.

Render stores active audio beneath the persistent disk path
`/var/data/project-x-voice-capture/sessions/<session-id>/`. Member APIs require
the signed-in Wix member's short-lived handoff ticket and an HttpOnly session
cookie. The local transfer utility downloads individual clips, verifies every
SHA-256 locally, optionally creates a combined `Listening_Copy.wav` when
`ffmpeg` is installed on the PC, then asks Render to verify the same manifest
and clip hashes. Render deletes the audio only after that check succeeds. The
non-audio manifest and consent/transfer metadata remain on Render.

## Render environment variables

Keep the existing build and start commands (`npm install`, `node server.js`)
and attach the persistent disk mounted at `/var/data`.

Set these variables in the Render service:

| Variable | Value |
|---|---|
| `VOICE_DATA_DIR` | `/var/data/project-x-voice-capture` |
| `WIX_HANDOFF_SECRET` | A random secret of at least 32 characters; must exactly match the Wix Secret Manager value below. |
| `VOICE_TRANSFER_TOKEN` | A separate random secret of at least 32 characters; enter this only in the PC transfer utility when prompted. |
| `VOICE_CONSENT_APPROVED` | Keep `false` until the final consent wording and all participant prompts are ready. Set to `true` only after updating them. |
| `VOICE_CONSENT_VERSION` | Optional; if set, it overrides the consent version in `config/capture-sections.json`. Keep it unique for each wording change. |

Generate two independent secrets, for example with Python:

```powershell
py -3 -c "import secrets; print(secrets.token_urlsafe(48))"
```

Run that command twice. Do not put either secret in Wix page code, GitHub, a
public ZIP, or a participant-facing URL. The Wix secret is stored in Wix
Secrets Manager and Render environment variables; the transfer secret is only
stored in Render and entered privately in the PC utility.

## Wix member handoff

1. Add `wix/voiceCapture.web.js` as a Wix backend web module with that exact
   filename. It restricts ticket issuance to `Permissions.SiteMember`.
2. In Wix Secrets Manager, add `PX_VOICE_CAPTURE_HANDOFF_SECRET` with the same
   value as Render's `WIX_HANDOFF_SECRET`.
3. Connect the existing Start/Resume button using
   `wix/START_BUTTON_PAGE_CODE.txt`. Replace `#startRecordingButton` with the
   actual element ID in Wix Studio. Keep the direct Render `/voice-capture`
   address in the code.
4. Publish the Wix site and test using a real signed-in member; Velo member
   identity is not fully representative in Preview.

The one-use ticket lasts 120 seconds and is placed in the URL fragment, then
removed from the browser address bar immediately after exchange. Render
persists replay markers on the attached disk so a ticket cannot be reused after
a restart.

## Transfer to the PC master library

Install Python 3 on the PC. After a session is marked **READY FOR TRANSFER**,
run:

```powershell
py -3 .\tools\transfer_voice_session.py SESSION_ID
```

The default local master path is
`D:\Working\Project_X\PX_Voice_Library\<Wix-member-ID>\<session-id>\` on
Windows. Use `--destination` to choose a different local folder. The utility
retains each original clip in `Section_##\Take_##.<format>`, saves the session
manifest and transfer verification receipt, then requests Render deletion.
It stops before requesting deletion if download, local write, hash validation,
or manifest validation fails. If `ffmpeg` is installed, it also creates a
convenience listening WAV; the originals remain unchanged.

The Render transfer API is not exposed to ordinary participant sessions and
requires `VOICE_TRANSFER_TOKEN`.

## Tests

Install dependencies and run:

```sh
npm ci
npm test
node --check server.js
```

The API regression test covers one-use Wix tickets, member-bound session
creation, separate take upload, transfer hash verification, and the rule that
Render audio cannot be deleted using an incomplete verification list.
