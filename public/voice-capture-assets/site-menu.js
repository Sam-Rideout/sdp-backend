'use strict';
// UI-only navigation. Existing recorder listeners remain authoritative.
(() => {
  const toggle = document.getElementById('pxMenuToggle');
  const menu = document.getElementById('pxSiteMenu');
  if (!toggle || !menu) return;
  const setOpen = open => {
    menu.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Close site menu' : 'Open site menu');
  };
  toggle.addEventListener('click', () => setOpen(menu.hidden));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !menu.hidden) {
      setOpen(false);
      toggle.focus();
    }
  });
  document.addEventListener('click', event => {
    if (!menu.hidden && !menu.contains(event.target) && !toggle.contains(event.target)) setOpen(false);
  });
  document.addEventListener('click', event => {
    const link = event.target.closest('a[data-px-navigation]');
    if (!link) return;
    // Includes microphone tests and session creation as well as saved-take work.
    // Block before any navigation; never stop a recording, discard or submit here.
    let locked = false;
    try {
      locked = (typeof guidedLocked === 'function' && guidedLocked()) ||
        (typeof mediaRecorder !== 'undefined' && mediaRecorder?.state === 'recording');
    } catch (_) { locked = true; }
    if (locked) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const message = 'Finish recording and wait for Saved, or retry or discard the unsaved take, before leaving this page.';
      const notice = document.getElementById('guidedNotice');
      if (notice) notice.textContent = message;
      if (typeof setStatus === 'function') setStatus(message);
      return;
    }
    setOpen(false);
  }, true);
})();
