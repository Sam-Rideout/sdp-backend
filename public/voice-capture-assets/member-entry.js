'use strict';
// Only exchange a Wix-issued ticket here. Never load the recorder before authentication.
(async () => {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const ticket = fragment.get('ticket');
  if (!ticket) return;
  fragment.delete('ticket');
  const progress = new URLSearchParams(location.search).get('view') === 'progress' ||
    fragment.get('view') === 'progress';
  const destination = location.pathname + (progress ? '?view=progress' : '');
  history.replaceState(null, '', destination);
  const status = document.getElementById('signInStatus');
  status.textContent = 'Connecting your signed-in Project X account…';
  try {
    const response = await fetch('/api/session/exchange', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket })
    });
    if (!response.ok) throw new Error('Sign-in was not accepted.');
    location.replace(destination);
  } catch (_) {
    status.textContent = 'Your sign-in link could not be confirmed. Return to Project X and open voice recording again.';
  }
})();
