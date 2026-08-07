/**
 * Background worker.
 *
 * Opens the app and relays the one message that has to cross from the app tab
 * to a discord.com tab. It holds no state on purpose: an MV3 service worker is
 * killed after about thirty seconds idle, so anything long lived here would be
 * lost mid job. The work itself lives in the app tab, which stays alive as long
 * as the user can see it.
 */
(function () {
  'use strict';

  const APP_PAGE = 'app/app.html';

  /**
   * Where the handoff script is actually registered, read from the manifest.
   *
   * Hardcoding the pattern here would let it drift from the content_scripts
   * entry, and the failure is silent: the query matches nothing, and the user is
   * told to open Discord while Discord is already open. Reading it from the
   * manifest means the two cannot disagree.
   */
  const DISCORD_MATCHES = (CL.api.runtime.getManifest().content_scripts || []).flatMap(
    (entry) => entry.matches || []
  );

  /**
   * Open the app, reusing the existing tab rather than stacking duplicates that
   * each believe they own a running job.
   *
   * The obvious version of this is tabs.query({url: getURL(APP_PAGE)}), and it
   * silently returns nothing: matching a URL in tabs.query needs either the
   * "tabs" permission or a host permission covering it, and no host permission
   * covers chrome-extension://. Taking "tabs" to fix that would mean asking for
   * read access to the title and URL of every tab the user has open, which is a
   * terrible trade on a tool whose entire pitch is a narrow permission surface.
   *
   * Remembering the id instead costs nothing. storage.session rather than
   * storage.local because it is cleared when the browser closes, and tab ids
   * restart from scratch then, so a stale id can never point at some unrelated
   * tab opened in a later session. tabs.get and tabs.update both work without
   * the "tabs" permission; only the privileged fields are withheld, and this
   * needs none of them.
   */
  async function openApp() {
    const stored = await CL.api.storage.session.get('appTabId');
    if (typeof stored.appTabId === 'number') {
      try {
        await CL.api.tabs.get(stored.appTabId);
        await CL.api.tabs.update(stored.appTabId, { active: true });
        return stored.appTabId;
      } catch {
        // Closed since we last looked. Fall through and open a new one.
      }
    }
    const tab = await CL.api.tabs.create({ url: CL.api.runtime.getURL(APP_PAGE) });
    await CL.api.storage.session.set({ appTabId: tab.id });
    return tab.id;
  }

  CL.api.action.onClicked.addListener(() => {
    openApp();
  });

  /**
   * Let exactly one app tab consider itself in charge.
   *
   * The pacing guarantee is per limiter, and a limiter lives in a page. Two app
   * tabs means two queues, each honouring the write floor only against itself,
   * which doubles the real rate at Discord and quietly undoes the one property
   * this extension is built around. The toolbar reuses its tab, but nothing
   * stops a duplicated tab or a pasted URL, so ownership is claimed explicitly
   * rather than assumed.
   *
   * Held in storage.session, so it is forgotten when the browser closes and a
   * stale id can never lock out a later session.
   */
  /**
   * Claims are serialised through here, one at a time.
   *
   * Reading the current owner and writing the new one are two awaits with a gap
   * between them, so two tabs claiming at once can both read "nobody owns this"
   * and both write. They then each broadcast, each sees the other's broadcast
   * naming a different owner, and both stand down. Nothing is destroyed, but
   * the user is left with two dead tabs and no explanation.
   */
  let claims = Promise.resolve();

  function claimApp(senderTabId, force, token) {
    const result = claims.then(() => resolveClaim(senderTabId, force, token));
    claims = result.then(
      () => {},
      () => {}
    );
    return result;
  }

  async function resolveClaim(senderTabId, force, token) {
    if (typeof senderTabId !== 'number') return { ok: true, tabId: senderTabId };

    const stored = await CL.api.storage.session.get('appTabId');
    const owner = stored.appTabId;

    if (typeof owner === 'number' && owner !== senderTabId) {
      let alive = true;
      try {
        await CL.api.tabs.get(owner);
      } catch {
        alive = false;
      }

      // A tab the user forgot about in another window should not lock them out
      // forever, so taking over is offered rather than refused outright. It has
      // to be a deliberate click, because the tab being replaced may be halfway
      // through a run.
      if (alive && !force) return { ok: false, owner };
    }

    await CL.api.storage.session.set({ appTabId: senderTabId });

    // Tell whoever held it to stand down. Broadcast rather than addressed:
    // tabs.sendMessage reaches content scripts, not extension pages, so the app
    // tab would never hear it.
    // The token identifies the claimer so it can ignore its own broadcast. A
    // tab id will not do: this goes out before the reply carrying that id
    // arrives, so the claimer would not yet know which id was its own.
    try {
      await CL.api.runtime.sendMessage({
        type: 'clearline:superseded',
        owner: senderTabId,
        token: token || null,
      });
    } catch {
      // Nothing listening, which is the ordinary single tab case.
    }

    return { ok: true, tabId: senderTabId };
  }

  /**
   * Ask a logged in Discord tab for the session token.
   *
   * The app page cannot read discord.com localStorage itself, and the content
   * script cannot be reached from an extension page directly, so this hop is
   * the whole reason the background exists. The token passes through and is not
   * retained.
   */
  async function fetchToken() {
    const tabs = await CL.api.tabs.query({ url: DISCORD_MATCHES });
    if (tabs.length === 0) return { ok: false, reason: 'no-tab' };

    for (const tab of tabs) {
      try {
        const reply = await CL.api.tabs.sendMessage(tab.id, { type: 'clearline:read-token' });
        if (reply && reply.ok) return { ok: true, token: reply.token };
      } catch {
        // A tab still loading has no listener yet. Try the next one before
        // telling the user to open Discord, since most people have several.
      }
    }
    return { ok: false, reason: 'not-logged-in' };
  }

  CL.api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || sender.id !== CL.api.runtime.id) return;

    if (message.type === 'clearline:get-token') {
      fetchToken().then(sendResponse);
      // Keeps the channel open for the async reply. Without it the app page
      // sees undefined and reports "not logged in" on a perfectly good session.
      return true;
    }

    if (message.type === 'clearline:claim-app') {
      claimApp(sender.tab && sender.tab.id, !!message.force, message.token).then(sendResponse);
      return true;
    }

    return undefined;
  });

  // Exposed so the end to end suite drives the real handoff rather than a
  // reimplementation of it. Nothing else reads this.
  CL.background = { fetchToken, openApp, claimApp, DISCORD_MATCHES };
})();
