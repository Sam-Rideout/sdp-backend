'use strict';

const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'microphone=(self)');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    application: 'Project X Voice Capture',
    stage: 'Recording and playback test'
  });
});

const recorderPage = String.raw`
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport"
      content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Project X — Tier 1 Voice Capture</title>

<style>
  :root {
    color-scheme: dark;
    --background: #3B4148;
    --panel: #30363D;
    --text: #F0E9E3;
    --muted: #D1CBC5;
    --blue: #9BCFFF;
    --red: #FFB4AB;
    --border: #717982;
  }

  * { box-sizing: border-box; }

  html, body {
    margin: 0;
    min-height: 100%;
    background: var(--background);
    color: var(--text);
    font-family: Arial, Helvetica, sans-serif;
  }

  body {
    padding: 12px;
    padding-top: max(12px, env(safe-area-inset-top));
    padding-bottom: max(12px, env(safe-area-inset-bottom));
  }

  .capture {
    width: 100%;
    max-width: 520px;
    height: calc(100vh - 24px);
    height: calc(
      100dvh - max(12px, env(safe-area-inset-top))
      - max(12px, env(safe-area-inset-bottom))
    );
    min-height: 520px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 18px;
    background: var(--panel);
  }

  header {
    flex-shrink: 0;
    padding: 16px 18px 12px;
    border-bottom: 1px solid var(--border);
  }

  .brand {
    margin: 0 0 10px;
    font-size: 12px;
    font-weight: bold;
    color: var(--muted);
  }

  .section-meta {
    display: flex;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 6px 12px;
    font-size: 13px;
    color: var(--muted);
  }

  h1 {
    margin: 10px 0;
    font-size: 25px;
    line-height: 1.15;
  }

  .flag {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
  }

  .flag-symbol {
    color: var(--red);
    font-size: 19px;
  }

  main {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 16px 18px;
    overscroll-behavior-y: contain;
  }

  p {
    margin: 0 0 14px;
    font-size: 16px;
    line-height: 1.5;
  }

  .pitch {
    margin-bottom: 14px;
    padding: 14px;
    border: 1px solid var(--border);
    border-radius: 12px;
  }

  h2 {
    margin: 0 0 8px;
    font-size: 18px;
  }

  .vowels {
    margin: 0 0 8px;
    font-size: 22px;
    font-weight: bold;
  }

  .pitch p:last-child { margin-bottom: 0; }

  .tip {
    color: var(--muted);
    font-size: 14px;
  }

  footer {
    flex-shrink: 0;
    padding: 12px 18px 14px;
    border-top: 1px solid var(--border);
  }

  .status-line {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 12px;
    margin-bottom: 10px;
  }

  #status {
    margin: 0;
    font-size: 14px;
    line-height: 1.4;
    overflow-wrap: anywhere;
  }

  #timer {
    flex-shrink: 0;
    font-variant-numeric: tabular-nums;
  }

  .buttons, .navigation {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }

  button {
    width: 100%;
    min-height: 46px;
    padding: 10px;
    border: none;
    border-radius: 10px;
    font: inherit;
    font-weight: bold;
    cursor: pointer;
  }

  #record {
    background: var(--blue);
    color: #142A3D;
  }

  #stop {
    background: var(--red);
    color: #381713;
  }

  button:focus-visible {
    outline: 3px solid var(--text);
    outline-offset: 3px;
  }

  button:disabled {
    cursor: default;
    opacity: 0.45;
  }

  #playback {
    margin-top: 10px;
  }

  audio {
    display: block;
    width: 100%;
    height: 42px;
  }

  .navigation {
    margin-top: 10px;
  }

  .navigation button {
    border: 1px solid var(--border);
    background: transparent;
    color: var(--muted);
  }

  .notice {
    margin: 10px 0 0;
    font-size: 12px;
    line-height: 1.4;
    color: var(--muted);
  }

  [hidden] { display: none !important; }
</style>
</head>

<body>
<div class="capture">
  <header>
    <p class="brand">PROJECT X · VOICE CAPTURE · TIER 1</p>

    <div class="section-meta">
      <span>Section 1 of 8</span>
      <span>About 2 minutes, plus breaths</span>
    </div>

    <h1>Sustained Vowels</h1>

    <div class="flag">
      <span class="flag-symbol" aria-hidden="true">⚑</span>
      <span>Not completed · 0 saved passes</span>
    </div>
  </header>

  <main aria-label="Recording instructions">
    <p>
      Sing each vowel on one steady note.
      Hold each sound for about <strong>3 seconds</strong>,
      taking a short breath between sounds.
    </p>

    <p>
      At <strong>each pitch</strong>, sing the complete
      <strong>Ah – Eh – Oh – Oo</strong> sequence
      <strong>three times</strong>.
    </p>

    <section class="pitch">
      <h2>1. Medium pitch</h2>
      <p>Use a comfortable note in the middle of your range.</p>
      <p class="vowels">Ah – Eh – Oh – Oo</p>
      <p>Repeat this complete sequence <strong>3 times</strong>.</p>
    </section>

    <section class="pitch">
      <h2>2. High pitch</h2>
      <p>
        Choose a higher note that you can sing comfortably.
        Keep it steady and avoid straining.
      </p>
      <p class="vowels">Ah – Eh – Oh – Oo</p>
      <p>Repeat this complete sequence <strong>3 times</strong>.</p>
    </section>

    <section class="pitch">
      <h2>3. Low pitch</h2>
      <p>
        Choose a lower note that you can sing comfortably.
        Keep your voice natural and clear.
      </p>
      <p class="vowels">Ah – Eh – Oh – Oo</p>
      <p>Repeat this complete sequence <strong>3 times</strong>.</p>
    </section>

    <p class="tip">
      Record in a quiet room without music or effects.
      Keep a steady distance from the microphone.
      Stop if your voice feels uncomfortable.
    </p>

    <p class="tip">
      Keep this page open and your phone unlocked while recording.
      Tap Stop after completing all three pitches.
    </p>
  </main>

  <footer>
    <div class="status-line">
      <p id="status" role="status" aria-live="polite">
        Ready to record.
      </p>
      <span id="timer" aria-label="Recording time">00:00</span>
    </div>

    <div class="buttons">
      <button id="record" type="button">Record</button>
      <button id="stop" type="button" disabled>Stop</button>
    </div>

    <div id="playback" hidden>
      <audio id="audio" controls preload="metadata"
             aria-label="Listen to your recording"></audio>
    </div>

    <div class="navigation">
      <button type="button" disabled>Previous</button>
      <button type="button" disabled>Save &amp; Next</button>
    </div>

    <p class="notice">
      Test version: audio is not uploaded or saved.
      Closing or refreshing this page loses your recording.
      Saving will require tapping Save &amp; Next once enabled.
    </p>
  </footer>
</div>

<script>
'use strict';

const recordButton = document.getElementById('record');
const stopButton = document.getElementById('stop');
const status = document.getElementById('status');
const timer = document.getElementById('timer');
const audio = document.getElementById('audio');
const playback = document.getElementById('playback');

let stream = null;
let recorder = null;
let chunks = [];
let recordingUrl = null;
let timerInterval = null;
let startTime = 0;
let busy = false;
let stopping = false;
let interrupted = false;
let recordingFailed = false;

function releaseMicrophone() {
  if (stream) {
    stream.getTracks().forEach(track => track.stop());
    stream = null;
  }
}

function clearTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

function updateTimer() {
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  const minutes = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const seconds = String(elapsed % 60).padStart(2, '0');

  timer.textContent = minutes + ':' + seconds;

  if (elapsed >= 300) {
    stopRecording('limit');
  }
}

function stopRecording(reason) {
  if (!recorder || recorder.state === 'inactive' || stopping) {
    return;
  }

  stopping = true;
  interrupted = reason === 'interrupted';
  stopButton.disabled = true;
  status.textContent = 'Preparing your recording…';
  clearTimer();

  try {
    recorder.stop();
  } catch (error) {
    releaseMicrophone();
    busy = false;
    stopping = false;
    recordButton.disabled = false;
    status.textContent = 'Could not finish the recording. Please try again.';
  }
}

function microphoneError(error) {
  if (error.name === 'NotAllowedError') {
    return 'Microphone permission was blocked. Allow access in your browser settings and try again.';
  }

  if (error.name === 'NotFoundError') {
    return 'No microphone was found.';
  }

  if (error.name === 'NotReadableError') {
    return 'The microphone could not be opened. Close other apps using it and try again.';
  }

  return error.message || 'Recording could not start. Please try again.';
}

recordButton.addEventListener('click', async () => {
  if (busy) return;

  if (recordingUrl) {
    const replace = window.confirm(
      'Replace this unsaved recording with a new take?'
    );

    if (!replace) return;
  }

  busy = true;
  recordButton.disabled = true;
  stopButton.disabled = true;
  audio.pause();
  status.textContent = 'Opening microphone…';

  try {
    if (window.self !== window.top) {
      throw new Error('Open this Render page directly in your browser.');
    }

    if (!window.isSecureContext) {
      throw new Error('Recording requires a secure HTTPS page.');
    }

    if (!navigator.mediaDevices ||
        !navigator.mediaDevices.getUserMedia ||
        !window.MediaRecorder) {
      throw new Error('Recording is unavailable in this browser. Try Chrome or Safari.');
    }

    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: { ideal: 1 },
        echoCancellation: { ideal: false },
        noiseSuppression: { ideal: false },
        autoGainControl: { ideal: false }
      },
      video: false
    });

    if (document.hidden) {
      throw new Error('Keep this page visible, then tap Record again.');
    }

    const preferredTypes = [
      'audio/webm;codecs=opus',
      'audio/mp4',
      'audio/webm',
      'audio/ogg;codecs=opus'
    ];

    const mimeType = preferredTypes.find(type =>
      MediaRecorder.isTypeSupported(type)
    );

    recorder = mimeType
      ? new MediaRecorder(stream, { mimeType: mimeType })
      : new MediaRecorder(stream);

    chunks = [];
    stopping = false;
    interrupted = false;
    recordingFailed = false;

    recorder.addEventListener('dataavailable', event => {
      if (event.data && event.data.size > 0) {
        chunks.push(event.data);
      }
    });

    recorder.addEventListener('error', () => {
      recordingFailed = true;
      stopRecording('error');
    });

    recorder.addEventListener('stop', () => {
      clearTimer();
      releaseMicrophone();

      const type = recorder.mimeType ||
        (chunks[0] ? chunks[0].type : '');

      const blob = new Blob(chunks, { type: type });
      chunks = [];

      busy = false;
      stopping = false;
      stopButton.disabled = true;
      recordButton.disabled = false;

      if (!blob.size || recordingFailed) {
        status.textContent =
          'Recording failed. Please make another take.';
        recordButton.textContent = recordingUrl
          ? 'Record Again'
          : 'Record';
        return;
      }

      if (recordingUrl) {
        URL.revokeObjectURL(recordingUrl);
      }

      recordingUrl = URL.createObjectURL(blob);
      audio.src = recordingUrl;
      audio.load();
      playback.hidden = false;
      recordButton.textContent = 'Record Again';

      status.textContent = interrupted
        ? 'Recording interrupted. Listen to the take; you may need to record again. Not saved.'
        : 'Ready to listen. This recording has not been saved.';
    });

    stream.getAudioTracks().forEach(track => {
      track.addEventListener('ended', () => {
        stopRecording('interrupted');
      });
    });

    recorder.start(1000);

    if (recordingUrl) {
      URL.revokeObjectURL(recordingUrl);
      recordingUrl = null;
      audio.removeAttribute('src');
      audio.load();
    }

    playback.hidden = true;
    startTime = Date.now();
    timer.textContent = '00:00';
    timerInterval = setInterval(updateTimer, 250);

    stopButton.disabled = false;
    status.textContent = 'Recording… Complete the exercise, then tap Stop.';

  } catch (error) {
    clearTimer();
    releaseMicrophone();
    busy = false;
    stopping = false;
    recordButton.disabled = false;
    stopButton.disabled = true;
    status.textContent = microphoneError(error);
  }
});

stopButton.addEventListener('click', () => {
  stopRecording('user');
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopRecording('interrupted');
  }
});

audio.addEventListener('error', () => {
  status.textContent =
    'Playback could not open this recording. Please try another take.';
});

window.addEventListener('beforeunload', event => {
  if (busy || recordingUrl) {
    event.preventDefault();
    event.returnValue = '';
  }
});

window.addEventListener('pagehide', () => {
  stopRecording('interrupted');
  clearTimer();
  releaseMicrophone();
});
</script>
</body>
</html>
`;

app.get('/', (req, res) => {
  res.type('html').send(recorderPage);
});

app.get('/voice-capture', (req, res) => {
  res.type('html').send(recorderPage);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Project X Voice Capture listening on port ${PORT}`);
});
