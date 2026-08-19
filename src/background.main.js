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
  /**
   * Serialised for the same reason claims are.
   *
   * Reading the remembered tab id and writing a new one are two awaits with a
   * gap between them, so two toolbar clicks close together both read "no tab"
   * and both create one. That is exactly the duplicate this function exists to
   * prevent, and a duplicate app tab is a second limiter.
   */
  let opens = Promise.resolve();

  function openApp() {
    const result = opens.then(() => resolveOpen());
    opens = result.then(
      () => {},
      () => {}
    );
    return result;
  }

  /**
   * App tabs that are provably still running the app page.
   *
   * A remembered tab id is not the same claim. `tabs.get` only throws when a
   * tab is *closed*, so a tab that navigated to discord.com still resolved, and
   * the toolbar button dutifully focused it and opened nothing: the extension's
   * only entry point, dead for the rest of the browser session. Reading the
   * tab's URL to tell the difference would mean taking the "tabs" permission,
   * which is the trade this file exists to avoid.
   *
   * A port answers it for free. The app page opens one on load and the browser
   * closes it on navigation as well as on close, so membership here means the
   * page is alive right now. Kept in memory rather than storage.session
   * deliberately: if the worker is restarted the ports are re-established by
   * the pages that still exist, and anything remembered across that restart
   * would be a guess again.
   */
  const livePorts = new Map();

  /**
   * When this worker started, which is the only thing "no ports" can mean.
   *
   * See stillTheApp. An empty list is two situations wearing the same face, and
   * the clock is what tells them apart.
   */
  const startedAt = Date.now();

  /**
   * Long enough for a page that exists to say so.
   *
   * The app page re-opens its port a quarter of a second after losing it, so
   * anything still running the app has answered well inside this. Only ever
   * waited out on a worker that has just started and been asked immediately.
   */
  const PRESENCE_GRACE_MS = 1500;

  CL.api.runtime.onConnect.addListener((port) => {
    if (!port || port.name !== 'clearline:app') return;
    const tabId = port.sender && port.sender.tab && port.sender.tab.id;
    if (typeof tabId !== 'number') return;
    // Overwrites on a reconnect, and the guard below keeps the port being
    // replaced from deleting the one that replaced it.
    livePorts.set(tabId, port);
    port.onDisconnect.addListener(() => {
      if (livePorts.get(tabId) === port) livePorts.delete(tabId);
    });
  });

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * Whether a remembered tab is still the app.
   *
   * An empty port list used to be read as "ask again later", on the reasoning
   * that it is the window between a worker starting and a page connecting. It is
   * also exactly what the only app tab navigating away looks like, and those two
   * want opposite answers. Read as "later" it undid the whole point of the port:
   * a tab that had gone to discord.com was still confirmed as the app, the
   * toolbar focused it, and the extension's only entry point did nothing for the
   * rest of the browser session, which is the bug the port was added to close.
   *
   * The clock separates them, because only one of the two is about a worker that
   * has just started. Past the grace an empty list means what it says, and inside
   * it the question is worth waiting out rather than guessing at: a page that is
   * still the app answers in a quarter of a second, and a toolbar click can
   * afford that once.
   */
  async function stillTheApp(tabId) {
    if (livePorts.has(tabId)) return true;
    while (Date.now() - startedAt < PRESENCE_GRACE_MS) {
      await sleep(60);
      if (livePorts.has(tabId)) return true;
    }
    return false;
  }

  async function resolveOpen() {
    const stored = await CL.api.storage.session.get('appTabId');
    let remembered = null;
    if (typeof stored.appTabId === 'number') {
      // Asked in this order so the grace inside stillTheApp is only ever paid
      // for a tab that is genuinely still open. A remembered tab that has since
      // been closed is answered by tabs.get in no time at all, and making the
      // ordinary case wait a second and a half for that would be a worse bug
      // than the one the grace is there for.
      try {
        await CL.api.tabs.get(stored.appTabId);
        if (await stillTheApp(stored.appTabId)) remembered = stored.appTabId;
      } catch {
        // Closed since we last looked.
      }
    }
    // A tab holding an open port is provably running the app right now, which is
    // a better answer than a new tab. Without this, a remembered tab that had
    // navigated away opened a third window onto an app that was already sitting
    // there in the second.
    const target = remembered === null ? livePorts.keys().next().value : remembered;

    if (typeof target === 'number') {
      try {
        const tab = await CL.api.tabs.get(target);
        await CL.api.tabs.update(target, { active: true });
        // Activating a tab only raises it within its own window. If that window
        // is behind another or minimised, clicking the toolbar looks like it did
        // nothing, and the obvious next move is to open a second copy, which is
        // the one thing reusing the tab is meant to avoid. windows.update needs
        // no permission of its own, and windowId is not among the fields tabs.get
        // withholds without the "tabs" permission.
        if (CL.api.windows && typeof tab.windowId === 'number') {
          try {
            await CL.api.windows.update(tab.windowId, { focused: true });
          } catch {
            // Raising the window is a nicety. Never let it lose the tab.
          }
        }
        if (target !== stored.appTabId) await CL.api.storage.session.set({ appTabId: target });
        return target;
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
      // Same question as the toolbar asks, and for the same reason: a tab that
      // has navigated away still resolves through tabs.get, so trusting that
      // alone told a genuine app tab it was "already open in another tab" and
      // named a tab that was showing Discord.
      //
      // tabs.get first, so the grace inside stillTheApp is only waited out for a
      // tab that is still open. This is the check whose wrong answer costs the
      // most: read as dead, a tab in the middle of a delete run is superseded
      // without anybody being asked, and the run stops.
      let alive = false;
      try {
        await CL.api.tabs.get(owner);
        alive = await stillTheApp(owner);
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

    // Two different failures used to collapse into one answer, and the wrong
    // one. A tab that replies `ok:false` is signed out. A tab that throws has no
    // listener at all, which is what every already-open Discord tab looks like
    // after an install or an update, because neither browser injects content
    // scripts retroactively and this extension takes no scripting permission to
    // do it itself. Reporting both as "not signed in" meant the first thing a
    // new user ever saw was advice that could not work: they were signed in, and
    // the fix was to reload the tab, which nothing told them.
    let answered = false;
    for (const tab of tabs) {
      try {
        const reply = await CL.api.tabs.sendMessage(tab.id, { type: 'clearline:read-token' });
        if (reply && reply.ok) return { ok: true, token: reply.token };
        answered = true;
      } catch {
        // A tab still loading has no listener yet either. Try the next one
        // before deciding, since most people have several open.
      }
    }
    return { ok: false, reason: answered ? 'not-logged-in' : 'needs-reload' };
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
  CL.background = {
    fetchToken,
    openApp,
    claimApp,
    DISCORD_MATCHES,
    liveAppTabs: () => Array.from(livePorts.keys()),
  };
})();
