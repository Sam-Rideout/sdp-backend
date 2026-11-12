'use strict';
// Site-style modal navigation. Never changes recording, consent or account state.
(() => {
  const toggle = document.getElementById('pxMenuToggle');
  const menu = document.getElementById('pxSiteMenu');
  const overlay = document.getElementById('pxMenuOverlay');
  const close = document.getElementById('pxMenuClose');
  const message = document.getElementById('pxMenuStatus');
  if (!toggle || !menu || !overlay || !close) return;
  let previousFocus = null;
  const priorInert = new Map();
  const background = [...document.querySelectorAll('.layout,.px-tagline,.px-site-footer,.px-brand,#pxMenuToggle')];
  const setOpen = (open, restoreFocus = true) => {
    if (open === !overlay.hidden) return;
    if (open) {
      previousFocus = document.activeElement;
      if (message) message.textContent = '';
      background.forEach(el => { priorInert.set(el, el.inert); el.inert = true; });
    } else {
      priorInert.forEach((value, el) => { el.inert = value; });
      priorInert.clear();
    }
    overlay.hidden = !open;
    document.body.classList.toggle('px-menu-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Close site menu' : 'Open site menu');
    if (open) close.focus();
    else if (restoreFocus) (previousFocus || toggle).focus();
  };
  toggle.addEventListener('click', () => setOpen(overlay.hidden));
  close.addEventListener('click', () => setOpen(false));
  overlay.addEventListener('click', event => { if (event.target === overlay) setOpen(false); });
  document.addEventListener('keydown', event => {
    if (overlay.hidden) return;
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); return; }
    if (event.key !== 'Tab') return;
    const focusable = [close, ...menu.querySelectorAll('a[href]')];
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || !overlay.contains(document.activeElement))) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !overlay.contains(document.activeElement))) {
      event.preventDefault(); first.focus();
    }
  });
  document.addEventListener('click', event => {
    const link = event.target.closest('a[data-px-navigation]');
    if (!link) return;
    let locked = false;
    try {
      locked = (typeof guidedLocked === 'function' && guidedLocked()) ||
        (typeof mediaRecorder !== 'undefined' && mediaRecorder?.state === 'recording');
    } catch (_) { locked = true; }
    if (locked) {
      event.preventDefault(); event.stopImmediatePropagation();
      const text = 'Finish recording and wait for Saved, or retry or discard the unsaved take, before leaving this page.';
      const notice = document.getElementById('guidedNotice');
      if (notice) notice.textContent = text;
      if (message) message.textContent = text;
      if (typeof setStatus === 'function') setStatus(text);
      return;
    }
    setOpen(false, false);
  }, true);
})();
