/*
 * Runs before the content script (which is document_idle), matching the real
 * ordering: by the time the extension looks, the page has already hidden
 * localStorage from itself.
 */
(function () {
  'use strict';

  // The value the suite expects to come back out through the handoff.
  localStorage.setItem('token', JSON.stringify('e2e-token-2f8a91c4'));
  localStorage.setItem('unrelated', JSON.stringify('should not be read'));

  let removed = [];

  // Style one: drop the own-property reference.
  try {
    delete window.localStorage;
    removed.push('delete');
  } catch (err) {
    removed.push('delete-failed');
  }

  // Style two: make any access from page context throw. This is the stricter
  // variant and the one that defeats a naive probe.
  try {
    Object.defineProperty(window, 'localStorage', {
      configurable: false,
      get() {
        throw new Error('localStorage is not available on this page');
      },
    });
    removed.push('redefine');
  } catch (err) {
    removed.push('redefine-failed');
  }

  // Prove to the suite that the page really did lose access, so a passing
  // handoff test cannot be passing because the fixture quietly did nothing.
  let pageCanRead = false;
  try {
    pageCanRead = !!window.localStorage.getItem('token');
  } catch {
    pageCanRead = false;
  }

  window.__fixture = { removed: removed.join('+'), pageCanRead };
  document.getElementById('state').textContent =
    'removed: ' + removed.join('+') + ', page can read: ' + pageCanRead;
})();
