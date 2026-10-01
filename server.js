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
    stage: 'Microphone test'
  });
});

const recorderPage = String.raw`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta
    name="viewport"
    content="width=device-width, initial-scale=1, viewport-fit=cover"
  >
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

    * {
      box-sizing: border-box;
    }

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
      min-height: 460px;
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
      padding: 18px 18px 14px;
      border-bottom: 1px solid var(--border);
    }

    .brand {
      margin: 0 0 12px;
      font-size: 13px;
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
      margin: 0 0 14px;
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
      letter-spacing: 0.5px;
    }

    .pitch p:last-child {
      margin-bottom: 0;
    }

    .tip {
      color: var(--muted);
      font-size: 14px;
    }

    footer {
      flex-shrink: 0;
      padding: 14px 18px 16px;
      border-top: 1px solid var(--border);
    }

    .status-line {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 12px;
    }

    #status {
      margin: 0;
      font-size: 14px;
      line-height: 1.4;
      overflow-wrap: anywhere;
    }

    .timer {
      flex-shrink: 0;
      font-variant-numeric: tabular-nums;
    }

    button {
      width: 100%;
      min-height: 48px;
      padding: 12px;
      border: none;
      border-radius: 10px;
      font: inherit;
      font-weight: bold;
      cursor: pointer;
    }

    #testMic {
      background: var(--blue);
      color: #142A3D;
    }

    button:focus-visible {
      outline: 3px solid var(--text);
      outline-offset: 3px;
    }

    button:disabled {
      cursor: default;
      opacity: 0.65;
    }

    .navigation {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      margin-top: 10px;
    }

    .navigation button {
      border: 1px solid var(--border);
      background: transparent;
      color: var(--muted);
    }

    .notice {
      margin: 12px 0 0;
      font-size: 13px;
      line-height: 1.4;
      color: var(--muted);
    }
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
        Record in a quiet room, without music or effects.
        Keep a steady distance from the microphone.
        Stop if your voice feels uncomfortable.
      </p>
    </main>

    <footer>
      <div class="status-line">
        <p id="status" role="status" aria-live="polite">
          Ready to test your microphone.
        </p>
        <span class="timer" aria-label="Recording time">00:00</span>
      </div>

      <button id="testMic" type="button">Test microphone</button>

      <div class="navigation">
        <button type="button" disabled>Previous</button>
        <button type="button" disabled>Save &amp; Next</button>
      </div>

      <p class="notice">
        Microphone test only. Nothing is recorded or saved.
        Recording and saving will be added after this test.
      </p>
    </footer>
  </div>

  <script>
    'use strict';

    const testButton = document.getElementById('testMic');
    const status = document.getElementById('status');

    testButton.addEventListener('click', async () => {
      let stream = null;

      testButton.disabled = true;
      status.textContent = 'Requesting microphone permission…';

      try {
        if (window.self !== window.top) {
          throw new Error(
            'Open this Render page directly in your browser to test the microphone.'
          );
        }

        if (!window.isSecureContext) {
          throw new Error(
            'Microphone access requires a secure HTTPS page.'
          );
        }

        if (
          !navigator.mediaDevices ||
          !navigator.mediaDevices.getUserMedia
        ) {
          throw new Error(
            'This browser does not support microphone access. Try Chrome or Safari.'
          );
        }

        stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: false
        });

        const audioTrack = stream.getAudioTracks()[0];

        if (!audioTrack || audioTrack.readyState !== 'live') {
          throw new Error('No active microphone was found.');
        }

        status.textContent =
          'Microphone access works. Nothing was recorded or saved.';

        testButton.textContent = 'Test microphone again';

      } catch (error) {
        if (
          error.name === 'NotAllowedError' ||
          error.name === 'PermissionDeniedError'
        ) {
          status.textContent =
            'Microphone permission was blocked. Allow microphone access in your browser settings, then try again.';
        } else if (error.name === 'NotFoundError') {
          status.textContent =
            'No microphone was found. Check your device and try again.';
        } else if (error.name === 'NotReadableError') {
          status.textContent =
            'The microphone could not be opened. Close other apps using it and try again.';
        } else {
          status.textContent = error.message ||
            'Microphone test failed. Please try again.';
        }
      } finally {
        if (stream) {
          stream.getTracks().forEach(track => track.stop());
        }

        testButton.disabled = false;
      }
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
