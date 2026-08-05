/**
 * Token handoff.
 *
 * Runs on discord.com in the extension's isolated world and does exactly one
 * thing: when the app tab asks, read the session token out of localStorage and
 * pass it back. It is deliberately the smallest file in the project, because it
 * is the one a store reviewer will read first and the one with the most to lose.
 *
 * Why the isolated world is enough.
 *   Discord deletes `localStorage` from the page's own window, which is a sound
 *   defence against the "paste this in the console" scam. It has no effect here:
 *   an isolated world gets its own globals backed by the same origin's storage,
 *   so the property Discord removed from its window was never the one this file
 *   reads. The usual trick of building an iframe and stealing
 *   `contentWindow.localStorage` is not needed, and neither is running in the
 *   MAIN world, where Discord's own code could see or tamper with the handoff.
 *
 * What this file never does.
 *   No storing. No logging. No network. The token is read on demand, returned
 *   to one caller, and not kept anywhere. That means reconnecting after a
 *   restart is one click instead of zero, which is the correct trade: a token
 *   at rest in extension storage is a token that outlives the session and
 *   leaks with the profile.
 */
(function () {
  'use strict';

  const api = typeof browser !== 'undefined' ? browser : chrome;

  function readToken() {
    try {
      const raw = localStorage.getItem('token');
      if (!raw) return null;
      // Discord stores it JSON encoded, so it arrives wrapped in quotes.
      const token = JSON.parse(raw);
      return typeof token === 'string' && token.length > 0 ? token : null;
    } catch {
      // A logged out tab, a storage partition, or a shape change upstream all
      // land here and all mean the same thing to the caller.
      return null;
    }
  }

  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Only the extension's own pages may ask. `sender.id` is set by the browser
    // and cannot be forged by the page, and there is no externally_connectable,
    // so a website has no path to this listener at all.
    if (!message || message.type !== 'clearline:read-token') return;
    if (sender.id !== api.runtime.id) return;

    const token = readToken();
    sendResponse({ token, ok: !!token });
    return true;
  });
})();
