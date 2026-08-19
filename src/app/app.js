/**
 * App tab.
 *
 * One screen at a time, in order: connect, pick where, narrow it down, look at
 * what came back, then act on it. The order is the safety mechanism. There is no
 * way to reach the delete button without having first seen a count and a sample
 * of what matched, because the failure this tool has to design around is not a
 * crash, it is somebody destroying more than they meant to and finding out
 * afterwards.
 *
 * The job loop lives in this tab rather than the background. A service worker is
 * killed after about thirty seconds idle and would take a half finished delete
 * run with it; this page is alive exactly as long as the user is watching it.
 */
(function () {
  'use strict';

  /**
   * Why nothing is happening, when nothing is happening.
   *
   * The limiter has emitted these since it was written and nothing listened, so
   * the two moments the extension deliberately stands still, a bucket closing
   * and a 429 being backed away from, looked exactly like a tab that had
   * crashed. That is the worst possible moment to be unreadable: the run is
   * behaving correctly and the user's next move is to reload, which is the one
   * thing that loses the run.
   *
   * Display only. It runs inside the serialised queue, so it never throws and
   * never touches the limiter's own bookkeeping.
   */
  function onLimiterEvent(event) {
    try {
      if (!event) return;
      if (event.type === 'throttled') {
        paceNote(t('paceThrottled', [num(Math.ceil(event.ms / 1000))]));
      } else if (event.type === 'wait' && event.ms >= 3000) {
        paceNote(t('paceWaiting', [num(Math.ceil(event.ms / 1000))]));
      }
    } catch {
      // Nothing here is worth interrupting a run for.
    }
  }

  const client = CL.api_client.createClient({ onEvent: onLimiterEvent });
  const finder = CL.search.createFinder(client);

  const t = CL.i18n.t;
  const plural = CL.i18n.plural;
  const num = CL.i18n.num;

  const state = {
    me: null,
    guilds: [],
    dms: [],
    channels: [],
    /**
     * Every channel of the loaded server by id, including the ones the picker
     * does not offer, purely so a result can be told where it came from.
     */
    channelNames: new Map(),
    /** Which guild `channels` actually belongs to, or null if the load failed. */
    channelsFor: null,
    scope: null,
    scopeLabel: '',
    /**
     * The scope the result set on screen was actually searched under.
     *
     * Separate from `scope` because the picker keeps moving while a search
     * runs. Nothing disables the Back button, so a server-wide search that
     * pages for minutes can outlive the choice that started it, and every
     * sentence describing the results has to name the search that produced
     * them rather than whatever the picker says by the time they arrive.
     */
    resultScope: null,
    resultScopeLabel: '',
    tabId: null,
    superseded: false,
    connecting: false,
    /** Identifies this page's own claim, so it can tell its own from another's. */
    claimToken: (self.crypto && self.crypto.randomUUID && self.crypto.randomUUID()) || String(Date.now()),
    filters: {},
    results: [],
    /**
     * Ids the user has ticked off the list.
     *
     * Stored as exclusions rather than as a selection so the default is "all of
     * what you searched for", and so the set stays empty in the ordinary case
     * where somebody trusts their own filter.
     */
    excluded: new Set(),
    /** How many result rows are currently rendered. Raised by "Show more". */
    shown: 0,
    truncated: false,
    ran: false,
    job: null,
    /**
     * A search is paging right now.
     *
     * Kept apart from `busy`, which the end to end suite drives directly to
     * exercise the rail. This one guards the tab against a reload, and a flag
     * that a test can switch on is not one an unload prompt should hang off.
     */
    searching: false,
    stopSearch: false,
    /** A finished report nobody has kept yet. Guards the tab against a reload. */
    unsavedReport: false,
    /** Which step is on screen, so the rail never has to ask the DOM. */
    step: 'connect',
    /**
     * A search is paging, or a run is going.
     *
     * Only the rail reads it. Leaving either of those screens would hide the
     * counter and the Stop button of something still running, which is why
     * `run-back` is disabled for the length of a run; the rail is the same
     * escape hatch and owes the same answer.
     */
    busy: false,
  };

  const $ = (id) => document.getElementById(id);

  /**
   * Tell the background this page exists, for as long as it exists.
   *
   * The background needs to know whether the tab it remembers is still the app,
   * and a tab id alone cannot answer that: navigating away leaves the id valid,
   * so the toolbar button went on focusing a tab that was showing Discord and
   * never opened the app again. A port is closed by the browser on navigation as
   * well as on close, which is exactly the question, and it costs no permission.
   *
   * Opened again whenever it closes, which is the half that was missing. A
   * service worker is torn down after about thirty seconds idle and the browser
   * drops an idle port after about five minutes, and neither of those means the
   * page went anywhere: they are the ordinary state of a tab watching a run that
   * takes hours, since a run sends nothing through this port. The page connected
   * once at load and never again, so the background's list of live app tabs
   * emptied itself a few minutes in and stayed empty.
   *
   * That is not a cosmetic drift. An empty list reads as "no app tab is alive",
   * so a second tab opened afterwards was never told the queue was taken: it
   * claimed ownership without asking, and the tab it superseded cancelled the
   * delete run it was in the middle of. The prompt that exists to make a
   * takeover deliberate could not appear, because by then nothing knew there
   * was anything to take over.
   *
   * Reconnecting wakes the worker roughly once every five minutes for as long as
   * the tab is open, which is the cost of the answer being true rather than
   * merely recent.
   */
  let presence = null;
  function announcePresence() {
    try {
      presence = CL.api.runtime.connect({ name: 'clearline:app' });
    } catch {
      // The extension was reloaded or updated underneath this page, which no
      // amount of retrying fixes. One tab is the ordinary case, so carrying on
      // without the background knowing is better than a loop.
      presence = null;
      return;
    }
    presence.onDisconnect.addListener(() => {
      // Read so the browser does not log an unchecked error for a disconnect
      // this page expects and handles.
      void CL.api.runtime.lastError;
      presence = null;
      // Short, because the gap is the one moment a second tab could claim the
      // queue without being told this one holds it, and not zero, so a reload
      // tearing the worker down cannot turn this into a spin. A connect against
      // a reloaded extension throws rather than disconnecting, and the catch
      // above stops there.
      setTimeout(announcePresence, 250);
    });
  }
  announcePresence();

  /* ---------------------------------------------------------------- */
  /* Small helpers                                                     */
  /* ---------------------------------------------------------------- */

  function say(el, text, tone) {
    el.textContent = text;
    if (tone) el.dataset.tone = tone;
    else delete el.dataset.tone;
  }

  function show(el) {
    el.classList.remove('hidden');
  }

  function hide(el) {
    el.classList.add('hidden');
  }

  /**
   * Say something to a screen reader, at a pace a person can follow.
   *
   * The run counter was itself the live region, rewritten once per message. On
   * a three thousand message run that is a fresh sentence every nine hundred
   * milliseconds, each taking about three seconds to speak, so the queue grew
   * without bound and the synthesiser never stopped: the Pause and Stop buttons
   * were unreachable behind a backlog, and any status the app wrote competed
   * with it. The visible counter still moves every message; only what is
   * announced is throttled, keyed on something that changes rarely.
   */
  let lastAnnounceKey = '';
  function announce(text, key) {
    const k = key === undefined ? text : key;
    if (!text || k === lastAnnounceKey) return;
    lastAnnounceKey = k;
    $('announce').textContent = text;
  }

  /** The current reason for a pause, written wherever the user is watching. */
  function paceNote(text) {
    for (const id of ['search-pace', 'run-pace']) $(id).textContent = text;
  }

  /**
   * Keep the tab-state strip from leaving a gap when it has nothing to offer.
   *
   * The two buttons in it are shown and hidden independently, so the row around
   * them has to follow whether either survived.
   */
  function syncTabActions() {
    const any = ['takeover', 'reconnect'].some((id) => !$(id).classList.contains('hidden'));
    $('tabstate-actions').classList.toggle('hidden', !any);
  }

  /**
   * Let a deliberate restart clear a rate limit halt.
   *
   * The limiter latches `halted` and every request checks it before reaching the
   * network, which is right while the mistake is still in progress and wrong for
   * the rest of the page's life. Nothing cleared it, so the message it throws,
   * "wait a few minutes and start again", named a recovery that could not
   * happen: Connect, the channel list, every later search and every later run
   * all failed instantly with that same sentence until the tab was reloaded, and
   * reloading is what loses the search results.
   *
   * Clearing it here rather than on a timer keeps the decision with the user: a
   * click on Connect, Search or Start is the "start again" the message asked
   * for. The write floor is deliberately preserved across a reset, so the first
   * request after one still owes its full delay.
   */
  function clearHalt() {
    if (client.status().halted) client.reset();
  }

  const STEPS = ['connect', 'where', 'filter', 'review', 'run'];

  /**
   * The rail, as five buttons rather than five labels.
   *
   * It has always looked like a row of tabs and has never been clickable, which
   * is the worst of both: it invites the click and then ignores it. Every
   * backward move it now offers is one a Back button on the screen already
   * makes, so this is a shortcut through the wizard rather than a second way
   * around it, and the order stays the safety mechanism: nothing ahead of the
   * current step is ever reachable.
   *
   * Three things close it off. A step with no section behind it, which is
   * `connect`: the connect card is hidden for good once a connect succeeds and
   * there is no `#step-connect` to go back to, so keying on the section rather
   * than on a special case means the list itself answers the question. Anything
   * at or past the current step. And anything at all while a search is paging
   * or a run is going, because navigating away from those hides their own Stop
   * button.
   */
  function syncRail() {
    const here = STEPS.indexOf(state.step);
    for (const item of document.querySelectorAll('#rail li')) {
      const name = item.dataset.step;
      const index = STEPS.indexOf(name);
      const current = index === here;
      item.classList.toggle('on', current);
      item.classList.toggle('done', index < here);
      const button = item.querySelector('.railbtn');
      if (!button) continue;
      /*
       * Forward is closed, with one exception, and the exception is a way back
       * rather than a way on.
       *
       * A report is the only account of a run that cannot be undone: which
       * messages were left alone and why, which failed and with what, about
       * messages that no longer exist to be looked at again. Leaving the Act
       * step put it behind a section the rail would not reopen, because Act was
       * now ahead. One misclick and the record was in the document with no
       * control able to show it, while the unload prompt went on asking about
       * something the user could not get back to and so could not save.
       *
       * It costs nothing of the order that makes this wizard safe. Reaching Act
       * needs a result set and a count that have already been seen, and after a
       * run Start is switched off by `state.ran` anyway, so what this opens is a
       * report and a Save button.
       */
      const behind = index < here;
      const strandedReport = name === 'run' && index > here && state.unsavedReport;
      button.disabled = state.busy || (!behind && !strandedReport) || !$(`step-${name}`);
      if (current) button.setAttribute('aria-current', 'step');
      else button.removeAttribute('aria-current');
    }
  }

  /** Long operations own the rail for as long as they last. */
  function setBusy(busy) {
    state.busy = busy;
    syncRail();
  }

  function goTo(step) {
    let opened = null;
    for (const name of STEPS) {
      const section = $(`step-${name}`);
      if (!section) continue;
      section.classList.toggle('hidden', name !== step);
      if (name === step) opened = section;
    }
    state.step = step;
    syncRail();
    window.scrollTo(0, 0);

    // Focus follows the step. Hiding a section blurs whatever was inside it, so
    // without this the button that was just clicked drops focus to <body> and
    // the next Tab restarts from the page heading. Moving it to the heading also
    // announces the new step to a screen reader.
    const heading = opened && opened.querySelector('h2');
    if (heading) {
      heading.setAttribute('tabindex', '-1');
      heading.focus({ preventScroll: true });
    }
  }

  /**
   * "about 18 minutes", because a millisecond count is not an answer.
   *
   * Every branch is a separate message rather than one string with a number
   * glued on, because languages disagree about where the number goes and how
   * many plural forms an hour has.
   */
  function humanDuration(ms) {
    const seconds = Math.round(ms / 1000);
    if (seconds < 45) return t('durationUnderMinute');
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return plural('durationMinutes', minutes);
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (rest === 0) return plural('durationHours', hours);
    return t('durationHoursMinutes', [num(hours), num(rest)]);
  }

  /** A count of messages in whatever plural form the reader's language wants. */
  function count(n) {
    return plural('messages', n);
  }

  /** "2m 40s". Exact rather than rounded, because it is counting up. */
  function humanElapsed(ms) {
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 60) return t('elapsedSeconds', [num(seconds)]);
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return t('elapsedMinutes', [num(minutes), num(seconds % 60)]);
    return t('elapsedHours', [num(Math.floor(minutes / 60)), num(minutes % 60)]);
  }

  /**
   * Hand a string to the browser as a file.
   *
   * A blob and an anchor rather than the downloads API, which would mean asking
   * for a permission the extension otherwise has no use for. On a tool whose
   * pitch is a permission list you can read in one glance, that trade is worth
   * making.
   */
  function download(text, filename, mime) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Revoked late: revoking immediately races the download in Firefox.
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  /** What a run or an export would actually touch. */
  function selected() {
    if (state.excluded.size === 0) return state.results;
    return state.results.filter((m) => !state.excluded.has(m.id));
  }

  function metaFor() {
    return {
      account: state.me ? state.me.username : '',
      scope: state.resultScopeLabel,
      generatedAt: Date.now(),
      filterSummary: CL.filter.describe(state.filters),
      total: selected().length,
      truncated: !!state.truncated,
    };
  }

  const FORMATS = {
    html: { mime: 'text/html', build: (m) => CL.exporter.toHTML(selected(), m) },
    json: { mime: 'application/json', build: (m) => CL.exporter.toJSON(selected(), m) },
    csv: { mime: 'text/csv', build: () => CL.exporter.toCSV(selected()) },
  };

  function exportAs(kind) {
    const format = FORMATS[kind];
    const meta = metaFor();
    download(format.build(meta), CL.exporter.filenameFor(meta, kind), format.mime);
  }

  /* ---------------------------------------------------------------- */
  /* Step 1: connect                                                   */
  /* ---------------------------------------------------------------- */

  // Neither browser injects a content script into tabs that were already open
  // when the extension was installed or updated, so the very first thing a new
  // user does lands on needs-reload while they are perfectly well signed in.
  // Telling them to sign in is advice that cannot work; reloading is the fix.
  const TOKEN_PROBLEMS = {
    'no-tab': 'errNoTab',
    'not-logged-in': 'errNotLoggedIn',
    'needs-reload': 'errNeedsReload',
  };

  /** The message for a token failure, or the generic one for a shape we do not know. */
  function tokenProblem(reason) {
    return t(TOKEN_PROBLEMS[reason] || 'errNoSession');
  }

  /** A DM has no name of its own, so it is named after who is in it. */
  function dmLabel(channel) {
    if (channel.name) return channel.name;
    const names = (channel.recipients || []).map((r) => r.global_name || r.username || t('dmUnknown'));
    if (names.length === 0) return t('dmFallback');
    if (names.length <= 3) return names.join(', ');
    return t('dmAndMore', [names.slice(0, 3).join(', '), num(names.length - 3)]);
  }

  function fillSelect(select, options, placeholder) {
    select.textContent = '';
    if (placeholder) {
      const first = document.createElement('option');
      first.value = '';
      first.textContent = placeholder;
      select.appendChild(first);
    }
    for (const option of options) {
      const el = document.createElement('option');
      el.value = option.value;
      el.textContent = option.label;
      select.appendChild(el);
    }
  }

  /**
   * Refuse to be the second copy.
   *
   * Two app tabs means two limiters, each pacing only against itself, so the
   * write floor stops describing what Discord actually receives. Rather than
   * try to share a queue across tabs, the second one steps aside.
   */
  async function claimOwnership(force) {
    try {
      const reply = await CL.api.runtime.sendMessage({
        type: 'clearline:claim-app',
        force: !!force,
        token: state.claimToken,
      });
      if (reply && reply.ok === false) {
        say($('status'), t('alreadyOpen'), 'error');
        show($('takeover'));
        syncTabActions();
        return false;
      }
      if (reply && typeof reply.tabId === 'number') state.tabId = reply.tabId;
      // An affirmative claim means this tab now holds the queue, so a tab that
      // had stood down has to come back up. Only on a real answer: the catch
      // below is a missing background, which says nothing about who owns what.
      if (reply) standUp();
      hide($('takeover'));
      syncTabActions();
    } catch {
      // No background to answer, which happens while the worker restarts. One
      // tab is the normal case, so carrying on is the right call.
    }
    return true;
  }

  const STOOD_DOWN = t('stoodDown');

  /**
   * Come back up after a takeover, having won the queue back.
   *
   * Standing down used to be permanent, which looked safe and was not. Taking
   * the queue back is a deliberate click and the tab that wins it is the owner,
   * so leaving the flag set handed that tab the queue while every action still
   * refused to run: it reconnected, showed the account, and then sat on
   * "Loading channels..." for ever with nothing on screen to explain why. A tab
   * that has stopped should say so, and a tab that has restarted should work.
   */
  function standUp() {
    if (!state.superseded) return;
    state.superseded = false;
    state.stopSearch = false;
    $('connect').disabled = false;
    $('search').disabled = false;
    // Reconnect too. It latches itself to the stand-down flag on the way out of
    // reconnect(), and nothing ever cleared it again, so a takeover landing
    // inside a reconnect left the one in-page recovery from an expired session
    // visible and permanently dead for the rest of the tab's life.
    $('reconnect').disabled = false;
    if ($('status').textContent === STOOD_DOWN) say($('status'), '');
    if ($('run-status').textContent === t('runStoppedByTakeover')) say($('run-status'), '');
    hide($('takeover'));
    syncTabActions();
    // Start is derived, not latched. standDown() switches it off directly, so
    // without this the tab came back up with every other control working and
    // the one button the screen exists for still greyed out.
    renderPreflight();
  }

  /**
   * Another tab has taken over. Stop everything that talks to Discord.
   *
   * Disabling the buttons is not enough on its own, because the code that runs
   * afterwards turns them back on: a search re-enables its own button when it
   * finishes, and the pre-flight recomputes whether Start should be available.
   * So this sets a flag, and every path that reaches the network checks it.
   */
  function standDown() {
    if (state.superseded) return;
    state.superseded = true;

    // Both of these matter. Cancelling the job stops a run; setting stopSearch
    // stops a search that is partway through paging, which would otherwise keep
    // going on a limiter the new owner knows nothing about.
    state.stopSearch = true;
    if (state.job) state.job.cancel();

    $('connect').disabled = true;
    $('search').disabled = true;
    $('start').disabled = true;
    say($('status'), STOOD_DOWN, 'error');

    // Offered, not hidden. This is the only control wired to a path that can
    // call standUp(), so hiding it here is what made standing back up
    // unreachable: Connect is disabled on the line above, and both controls used
    // to sit inside the card connect() hides for good on its way out. A stopped
    // tab was left looking healthy, with a greyed Search button and the
    // explanation written into a subtree with display:none.
    show($('takeover'));
    syncTabActions();

    if (state.job || state.ran) {
      say($('run-status'), t('runStoppedByTakeover'), 'error');
    }
  }

  CL.api.runtime.onMessage.addListener((message) => {
    if (!message || message.type !== 'clearline:superseded') return;
    // Matched on the token this page generated before it ever asked, not on a
    // tab id learned from the reply. The background broadcasts before that reply
    // arrives, so a tab comparing ids can be told to stand down by its own
    // successful claim.
    if (message.token && message.token === state.claimToken) return;
    standDown();
  });

  async function connect(force) {
    const button = $('connect');
    // Guarded and disabled before the first await, not after it. Claiming
    // ownership is a round trip to the background, and a second click landing
    // inside it used to start a whole second connect chain on the same client.
    if (state.connecting) return;
    state.connecting = true;
    button.disabled = true;
    // Four round trips happen behind this click before anything appears, and
    // the only sign of them was the button greying out, which is also what a
    // finished button with nothing left to do looks like.
    button.classList.add('busy');
    $('takeover').disabled = true;

    try {
      if (!(await claimOwnership(force))) return;
      if (state.superseded) return;

      // A halt latched by an earlier run would otherwise fail this connect
      // before it reached the network, with a message about waiting a few
      // minutes that no amount of waiting could make true.
      clearHalt();
      say($('status'), t('statusLooking'));

      const reply = await CL.api.runtime.sendMessage({ type: 'clearline:get-token' });
      if (state.superseded) return;
      if (!reply || !reply.ok) {
        say($('status'), tokenProblem(reply && reply.reason), 'error');
        return;
      }

      client.setToken(reply.token);
      say($('status'), t('statusConnected'));

      // Whose token this is, established before anything is pinned to it. See
      // the note on reconnect(): connect() is not only step one, the takeover
      // button reaches it too, and a tab that has already connected has an
      // identity that the credential just installed does not have to match.

      // Checked between every call, not once at the top. Connect is the only
      // path to the network that starts before there is anything on screen to
      // disable, so a takeover landing here has nothing else to stop it: the
      // remaining calls go out on a limiter the new owner knows nothing about,
      // and the tail then blanks the notice explaining that this tab stopped.
      const me = await client.me();
      if (state.superseded) return;
      if (state.me && String(me.id) !== String(state.me.id)) {
        client.setToken(null);
        say($('status'), t('errDifferentAccount'), 'error');
        return;
      }
      // Sequential on purpose. Firing these together would be the first burst
      // the account ever sees from this extension, which is the opposite of the
      // pacing everything else here is built around.
      const guilds = await client.guilds();
      if (state.superseded) return;
      const dms = await client.directMessages();
      if (state.superseded) return;

      // Narrowed rather than kept whole. Discord's /users/@me answers with the
      // account's email address, among other things this has no use for, and
      // holding data you never read is how it ends up somewhere by accident.
      // Three fields are needed: the id to filter messages by author, and the
      // name to show and to put in an export header.
      state.me = { id: me.id, username: me.username, discriminator: me.discriminator };
      state.guilds = guilds;
      state.dms = dms;

      $('account').textContent =
        me.username + (me.discriminator && me.discriminator !== '0' ? `#${me.discriminator}` : '');
      $('guild-count').textContent = String(guilds.length);
      $('dm-count').textContent = String(dms.length);

      fillSelect(
        $('guild-select'),
        guilds.map((g) => ({ value: g.id, label: g.name })),
        t('optChooseServer')
      );
      fillSelect(
        $('dm-select'),
        dms.map((d) => ({ value: d.id, label: dmLabel(d) })),
        t('optChooseConversation')
      );

      hide($('connect-card'));
      show($('account-card'));
      say($('status'), '');
      hide($('reconnect'));
      syncTabActions();
      goTo('where');
    } catch (err) {
      if (!state.superseded) {
        say($('status'), (err && err.message) || t('errGeneric'), 'error');
        offerReconnect();
      }
    } finally {
      state.connecting = false;
      button.classList.remove('busy');
      $('takeover').disabled = false;
      // Not unconditionally false, for the same reason the Search button is
      // not: a tab superseded while connecting would otherwise hand its own
      // button back at exactly the moment it was supposed to have stopped.
      button.disabled = state.superseded;
    }
  }

  /**
   * Read the session again without disturbing anything else.
   *
   * Discord rotates a session token often enough that a run measured in hours
   * meets one, and api.js drops the token on any 401 and says "reconnect". The
   * only control that could do that was the Connect button, which by then has
   * been hidden for the rest of the page's life, and running the full connect
   * again would walk the user back to the first step and throw away the result
   * set they are halfway through acting on. This is the token half alone.
   *
   * The token half alone is not enough, though, which is the whole reason for
   * the identity check below. The reason a session expired is often that
   * somebody signed in again, and the account they signed in as does not have
   * to be the one this tab connected with: an alt, or the next person on a
   * shared machine. Everything that keeps this tool to the user's own messages
   * is pinned to `state.me.id` captured at connect: the author filter the
   * search sends, the check on the answer, and the last guard in job.js in
   * front of the delete call. Installing a different account's token behind
   * that leaves all three comparing against an id the credential no longer
   * belongs to, so they agree the messages are "yours" and the requests go out
   * as somebody else. On a server where the new account can moderate, that is
   * this tool deleting another person's messages, which is the one outcome the
   * whole design exists to make impossible.
   */
  /**
   * Install the session token again, and refuse it if it is somebody else's.
   *
   * The token half and the identity half are one operation, never one without
   * the other, which is why they live in one function that both callers use
   * rather than in each of them. Answers whether the client is usable
   * afterwards; anything it refuses it has already explained on screen.
   */
  async function refreshSession() {
    const reply = await CL.api.runtime.sendMessage({ type: 'clearline:get-token' });
    // Checked after the await, like every other network path here. A takeover
    // landing inside this round trip used to be overwritten by the tail of the
    // caller: the stand-down notice lives in #status and so does the success
    // line, so a stopped tab ended up reading "Reconnected" with Search and
    // Start greyed out and nothing left on screen to explain why.
    if (state.superseded) return false;
    if (!reply || !reply.ok) {
      say($('status'), tokenProblem(reply && reply.reason), 'error');
      return false;
    }
    client.setToken(reply.token);

    // Asked, not assumed. Only when there is an identity to protect: before a
    // connect has ever succeeded there is nothing pinned to contradict.
    if (state.me) {
      const me = await client.me();
      if (state.superseded) return false;
      if (String(me.id) !== String(state.me.id)) {
        client.setToken(null);
        say($('status'), t('errDifferentAccount'), 'error');
        return false;
      }
    }
    return true;
  }

  async function reconnect() {
    if (state.superseded || state.connecting) return;
    const button = $('reconnect');
    button.disabled = true;
    clearHalt();
    say($('status'), t('statusReconnecting'));
    try {
      if (!(await refreshSession())) return;
      say($('status'), t('statusReconnected'));
      hide(button);
      syncTabActions();
    } catch (err) {
      if (!state.superseded) say($('status'), (err && err.message) || t('errGeneric'), 'error');
    } finally {
      // Not unconditionally false, for the same reason Connect and Search are
      // not: a tab superseded mid-reconnect would otherwise hand a control back
      // at the moment it was supposed to have stopped.
      button.disabled = state.superseded;
    }
  }

  /**
   * Take the queue back, and stay where you were.
   *
   * This used to be wired straight to connect(), which rebuilds both pickers
   * and ends on goTo('where'). For a tab that has never connected that is
   * exactly right. For one that has, it is the thing reconnect()'s own note
   * warns against: it walks the user back to the first step and strands the
   * result set they were halfway through acting on. Nothing reaches the review
   * table except a fresh search, and a fresh search replaces `state.results`
   * and clears every exclusion, so twenty minutes of paging and several minutes
   * of unticking rows by hand were still in memory and no longer reachable from
   * any control on screen.
   *
   * Taking the queue back is a claim plus a session, so that is all it does.
   */
  async function reclaim() {
    if (!state.me) return connect(true);
    if (state.connecting) return;
    const button = $('takeover');
    button.disabled = true;
    clearHalt();
    say($('status'), t('statusReconnecting'));
    try {
      // An affirmative claim stands this tab back up, which is what re-arms the
      // controls and re-derives Start.
      if (!(await claimOwnership(true))) return;
      if (!(await refreshSession())) return;
      say($('status'), t('statusReconnected'));
      hide($('reconnect'));
      syncTabActions();
    } catch (err) {
      if (!state.superseded) say($('status'), (err && err.message) || t('errGeneric'), 'error');
    } finally {
      button.disabled = false;
    }
  }

  /** Put the way back on screen, but only when the session is the thing missing. */
  function offerReconnect() {
    if (state.superseded || client.hasToken()) return;
    show($('reconnect'));
    syncTabActions();
  }

  /* ---------------------------------------------------------------- */
  /* Step 2: where                                                     */
  /* ---------------------------------------------------------------- */

  /** Text channels only. Voice and categories hold no messages to find. */
  const TEXTY = [0, 5, 15];

  function scopeKind() {
    const checked = document.querySelector('input[name="scope-kind"]:checked');
    return checked ? checked.value : 'guild';
  }

  function syncScopeKind() {
    const guild = scopeKind() === 'guild';
    $('guild-picker').classList.toggle('hidden', !guild);
    $('dm-picker').classList.toggle('hidden', guild);
  }

  async function loadChannels() {
    // Said rather than swallowed. Returning quietly left the channel list
    // sitting on "Loading channels..." with nothing to explain it.
    if (state.superseded) {
      say($('where-status'), STOOD_DOWN, 'error');
      return;
    }
    const guildId = $('guild-select').value;
    const select = $('channel-select');
    if (!guildId) {
      select.disabled = true;
      fillSelect(select, [], t('optPickServerFirst'));
      return;
    }

    select.disabled = true;
    // The "Loading channels..." option says so to anyone reading the box. A
    // screen reader lands on a disabled select and moves on, so the state has
    // to be on the control as well as in it.
    select.setAttribute('aria-busy', 'true');
    fillSelect(select, [], t('optLoadingChannels'));
    clearHalt();
    try {
      const channels = await client.guildChannels(guildId);
      // Named from the whole list, offered from the part of it worth searching.
      // These are two different questions and the filtered list was answering
      // both. A whole-server search returns whatever the account wrote anywhere,
      // including the text chat inside a voice channel, a stage channel and a
      // thread under a media channel, none of which belong in a picker of places
      // to search. Looking their names up in the picker's list found nothing, so
      // those rows arrived with no channel at all: blank cells scattered through
      // the review table on the last screen before an irreversible delete, and
      // blank channels in the export, with nothing to say anything was missing.
      state.channelNames = new Map(channels.map((c) => [String(c.id), c.name]));
      state.channels = channels
        .filter((c) => TEXTY.indexOf(Number(c.type)) !== -1)
        .sort((a, b) => (a.position || 0) - (b.position || 0));
      state.channelsFor = guildId;
      fillSelect(
        select,
        state.channels.map((c) => ({ value: c.id, label: `#${c.name}` })),
        null
      );
      select.disabled = false;
      select.removeAttribute('aria-busy');
      say($('where-status'), '');
    } catch (err) {
      // Dropped rather than left standing. A failed load used to leave the
      // previous server's channels in state, and commitScope closes
      // channelNameFor over that list, so every row in the review table and
      // every row of an export got a blank or a wrong channel name.
      state.channels = [];
      state.channelNames = new Map();
      state.channelsFor = null;
      select.removeAttribute('aria-busy');
      fillSelect(select, [], t('optChannelsFailed'));
      say($('where-status'), (err && err.message) || t('errChannelsFailed'), 'error');
      offerReconnect();
    }
  }

  function chosenChannels() {
    return Array.from($('channel-select').selectedOptions)
      .map((o) => o.value)
      .filter(Boolean);
  }

  function commitScope() {
    if (scopeKind() === 'guild') {
      const guildId = $('guild-select').value;
      if (!guildId) {
        say($('where-status'), t('errChooseServer'), 'error');
        return false;
      }
      // Refused rather than carried on with. Without the channel list there is
      // no way to name a channel, so a scope committed here would search fine
      // and then label every result with an empty channel, in the table the
      // user reads immediately before deleting them.
      if (state.channelsFor !== guildId) {
        say($('where-status'), t('errChannelsNotLoaded'), 'error');
        return false;
      }
      const guild = state.guilds.find((g) => g.id === guildId);
      const channelIds = chosenChannels();
      const names = state.channels
        .filter((c) => channelIds.indexOf(c.id) !== -1)
        .map((c) => `#${c.name}`);

      // Copied here, not looked up later. This closure is called once per
      // message as the results arrive, which can be minutes after the scope was
      // committed, and it used to read `state.channels` live. Nothing stops the
      // user going Back mid-search and picking another server, and doing so
      // replaces that array, so every message normalised after the swap came
      // back with an empty channel name: blank cells in the review table, on the
      // last screen before an irreversible delete, and blank channels in the
      // copy the user is told is the only record they will have.
      const channelNames = new Map(state.channelNames);

      state.scope = {
        guildId,
        guildName: guild ? guild.name : t('serverFallback'),
        channelIds,
        channelNameFor: (id) => channelNames.get(id) || '',
      };
      state.scopeLabel =
        (guild ? guild.name : t('serverFallback')) +
        (names.length ? ` / ${names.join(' ')}` : ` / ${t('allChannels')}`);
      return true;
    }

    const channelId = $('dm-select').value;
    if (!channelId) {
      say($('where-status'), t('errChooseConversation'), 'error');
      return false;
    }
    const dm = state.dms.find((d) => d.id === channelId);
    state.scope = { channelId, channelName: dm ? dmLabel(dm) : t('dmFallback'), guildId: null };
    state.scopeLabel = dm ? dmLabel(dm) : t('dmFallback');
    return true;
  }

  /* ---------------------------------------------------------------- */
  /* Step 3: filters and the search itself                             */
  /* ---------------------------------------------------------------- */

  /**
   * A date box holds a calendar day with no timezone, and the user means their
   * own. Parsing it as UTC is the classic mistake here: everything shifts by
   * the offset, and someone in Tokyo asking for "before 5 March" gets the
   * morning of the 6th thrown in.
   */
  function dateValue(id, edge) {
    const raw = $(id).value;
    if (!raw) return null;
    const parts = raw.split('-').map(Number);
    if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
    const local = new Date(parts[0], parts[1] - 1, parts[2]);
    return edge === 'end' ? CL.filter.endOfDay(local) : CL.filter.startOfDay(local);
  }

  function readFilters() {
    const filters = {
      contains: $('f-contains').value.trim(),
      useRegex: $('f-regex').checked,
      caseSensitive: $('f-case').checked,
      after: dateValue('f-after', 'start'),
      before: dateValue('f-before', 'end'),
      hasAttachment: $('f-attachment').checked,
      hasLink: $('f-link').checked,
      hasEmbed: $('f-embed').checked,
      excludePinned: $('f-pinned').checked,
    };
    if (state.scope && state.scope.channelIds && state.scope.channelIds.length) {
      filters.channelIds = state.scope.channelIds;
    }
    return filters;
  }

  async function runSearch() {
    if (state.superseded) {
      say($('filter-status'), STOOD_DOWN, 'error');
      return;
    }
    const button = $('search');
    let filters;
    try {
      filters = readFilters();
      // Compiling here surfaces a broken pattern while the user is still
      // looking at the box they typed it into.
      CL.filter.compile(filters);
    } catch (err) {
      say($('filter-status'), err.message, 'error');
      return;
    }

    if (filters.after && filters.before && filters.after > filters.before) {
      say($('filter-status'), t('errDateRangeBackwards'), 'error');
      return;
    }

    // Taken before the first request and used for everything the review and run
    // screens say about these results. The picker stays live while a search
    // pages, so reading the label back off `state` when the results land let a
    // search of server A be presented, counted and confirmed as server B: the
    // sentence directly above the Start button named the wrong server while the
    // queue held the right one, and that sentence is the last thing standing
    // between a person and an irreversible delete.
    const scope = state.scope;
    const scopeLabel = state.scopeLabel;

    state.filters = filters;
    state.stopSearch = false;
    state.searching = true;
    button.disabled = true;
    setBusy(true);
    say($('filter-status'), '');
    show($('search-progress'));
    // Live again for this search. It latches itself off when clicked, because
    // a search cannot be un-stopped.
    $('search-stop').disabled = false;
    // The message a halt throws tells the user to start again. This is them
    // starting again, so it has to mean something.
    clearHalt();

    const bounds = CL.filter.toWindow(filters);
    const startedAt = Date.now();
    // Indeterminate until Discord says how much there is, which for the history
    // path is never. See the note in onProgress: the width has to be handed back
    // to the stylesheet, because an inline one beats the sweeping rule.
    $('search-fill').style.width = '';
    $('search-bar').classList.add('waiting');
    $('search-bar').removeAttribute('aria-valuenow');
    $('search-elapsed').textContent = '';
    // Reset with the other two. The counter kept whatever the last search left
    // in it, so a second search opened the progress panel already claiming
    // "Found 1,250 messages of about 8,400" from the run before, or the words
    // "Stopping after the request in flight" while it was in fact starting. It
    // is wrong for at least one round trip, and far longer while Discord builds
    // a search index, which is the case where somebody is most likely to be
    // staring at it wondering whether anything is happening.
    $('search-counter').textContent = t('searching');
    // Reset with them, and it was not. The pace note is written by the limiter
    // and cleared by the next request landing, so a search stopped or finished
    // while it was waiting out a rate limit left the sentence standing: the next
    // search opened reading "Searching..." beside "Waiting 8 seconds" from the
    // one before it, which is the same stale-progress trap as the counter.
    paceNote('');

    try {
      const found = await finder.find({
        scope,
        authorId: state.me.id,
        minId: bounds.minId,
        maxId: bounds.maxId,
        shouldStop: () => state.stopSearch,
        onProgress: (p) => {
          // A stop has been asked for and the request that was already in flight
          // has just landed. The loop will notice at the top of its next turn,
          // but this runs first, and it used to overwrite "Stopping after the
          // request in flight" with a fresh count: the one visible answer to the
          // click disappeared a moment after it, so the button read as ignored
          // and the obvious next move was to press it again or reload.
          if (state.stopSearch) return;
          let line;
          if (p.phase === 'indexing') {
            line = t('searchIndexing');
          } else if (p.strategy === 'history') {
            // The history path knows how much it has read but not how much
            // there is, so it reports work done. It was reporting neither, and
            // a big DM sat on one unchanging line for minutes looking wedged.
            line = t('searchHistoryProgress', [num(p.scanned || 0), num(p.found)]);
          } else {
            line = p.total
              ? t('searchFoundOf', [count(p.found), num(p.total)])
              : t('searchFound', [count(p.found)]);
          }
          $('search-counter').textContent = line;
          // A request landed, so whatever the limiter was waiting for is over.
          if (p.phase !== 'indexing') paceNote('');

          const pct = p.total ? Math.min(100, Math.round((p.found / p.total) * 100)) : null;
          // Two different bars. With a total it is a percentage; without one the
          // track sweeps, which says "moving, length unknown" where a bar pinned
          // at zero says "stalled". Discord withholds a total more often than it
          // gives one: the history path knows what it has read and not what is
          // left, and an index still building answers with nothing at all, and
          // both of those are exactly when somebody reloads the tab and loses
          // the search. The inline width is given back rather than set, because
          // it would otherwise beat the stylesheet's sweeping rule; the aria
          // value is removed rather than zeroed, which is how a progressbar says
          // it does not know.
          $('search-bar').classList.toggle('waiting', pct === null);
          if (pct === null) {
            $('search-fill').style.width = '';
            $('search-bar').removeAttribute('aria-valuenow');
          } else {
            $('search-fill').style.width = `${pct}%`;
            $('search-bar').setAttribute('aria-valuenow', String(pct));
          }
          // Something on screen has to move even when neither denominator is
          // known, or a slow search is indistinguishable from a stuck one.
          $('search-elapsed').textContent = t('searchElapsed', [humanElapsed(Date.now() - startedAt)]);
          // Announced on a coarser clock than it is drawn. Without a total there
          // is no percentage to key on, so it falls back to a slow tick, which
          // is still the difference between silence and knowing it is alive.
          announce(
            line,
            `${p.phase}:${pct === null ? Math.floor((Date.now() - startedAt) / 15000) : pct}`
          );
        },
      });

      // Checked after the await as well as before it. A takeover landing while
      // the search was in flight used to walk the stopped tab forward to the
      // review screen anyway, with a partial result set and a Continue button.
      if (state.superseded) return;

      state.results = CL.filter.apply(found.messages, filters);
      state.resultScope = scope;
      state.resultScopeLabel = scopeLabel;
      state.excluded = new Set();
      previousSelection = null;
      state.shown = MAX_ROWS;
      state.ran = false;
      state.truncated = !!found.truncated;
      /*
       * The last run's report is about a set that has just been replaced.
       *
       * Three paths cleared it and the ordinary one did not: Start, the report's
       * own Search again, and carrying on with a queue. Reaching Narrow the way
       * the Back buttons and the rail reach it, and searching from there, left
       * it standing. The Act step then opened on "Finished. 2,980 messages
       * handled." above a pre-flight for messages that are all still there,
       * which reads as the new set being already gone. Its buttons were live
       * too: "carry on with the ones left" would have thrown away the search
       * that had just finished and put the old queue back in its place, and
       * "keep this report" wrote the old run's numbers into a file headed with
       * the new selection.
       *
       * The flag goes with it. Searching again is the same deliberate move as
       * the report's own button, which has always dropped the report on the
       * same terms, and a prompt guarding something the user can no longer
       * reach is worse than no prompt.
       */
      hide($('run-report'));
      state.unsavedReport = false;
      renderReview();
      goTo('review');
    } catch (err) {
      say($('filter-status'), (err && err.message) || t('errSearchFailed'), 'error');
      offerReconnect();
    } finally {
      state.searching = false;
      // Not unconditionally false. A tab that was superseded while searching
      // would otherwise hand its Search button back at exactly the moment it
      // was supposed to have stopped.
      button.disabled = state.superseded;
      // Unconditionally, unlike the button: the rail navigates between screens
      // and does not talk to Discord, so a stopped tab still gets to move
      // around what it already has.
      setBusy(false);
      hide($('search-progress'));
    }
  }

  /* ---------------------------------------------------------------- */
  /* Step 4: review                                                    */
  /* ---------------------------------------------------------------- */

  /** The review heading, which says something different once rows are spared. */
  function headingFor(total, picked) {
    if (!total) return t('nothingMatched');
    if (picked === total) return plural('matched', total);
    return t('selectedOfTotal', [num(picked), count(total)]);
  }

  /** Rendering every row of a 50,000 message result set locks the tab. */
  const MAX_ROWS = 300;

  /**
   * Anchor for a shift-click range, as an index into `state.results`.
   *
   * Sparing a stretch of an evening used to be one click per message, and one
   * misclick in forty is not recoverable once the run starts.
   */
  let lastPicked = null;

  /**
   * The selection as it was before the last select-all or select-none.
   *
   * That header checkbox replaces the whole set in one click, and unticking two
   * hundred rows out of five thousand one at a time is an afternoon's work with
   * no way back. Deliberately one step deep and tied to that one control: it is
   * an undo for the destructive click, not a history of the screen.
   */
  let previousSelection = null;

  /**
   * Discord's timestamp, in the reader's own timezone.
   *
   * It arrives as an ISO instant with an offset, and slicing the first sixteen
   * characters off it prints UTC while calling it nothing. The date boxes two
   * screens back are local calendar days, so a row could sit under a summary
   * reading "sent on or before 5 March" while showing the 6th, immediately
   * before an irreversible action. Same instant either way; only the label was
   * lying.
   *
   * Shared with the exporter rather than written twice. The saved copy is what
   * the user is told is the only record they will have, and a record that
   * timestamps the same message differently from the table it was made from is
   * the kind of discrepancy nobody can resolve afterwards.
   */
  const localStamp = CL.exporter.localStamp;

  /**
   * Where this message lives in Discord.
   *
   * A link and nothing more. Deciding whether to spare something usually needs
   * the conversation around it, and the alternative is scrolling Discord by hand
   * to find one message, which nobody does: people spare too much or delete
   * blind. The build gate keeps link hosts and connectable hosts apart, and this
   * adds no host to either list.
   */
  function discordUrl(message) {
    return `https://discord.com/channels/${message.guildId || '@me'}/${message.channelId}/${message.id}`;
  }

  /**
   * The channels behind the breakdown, and the row drawn for each.
   *
   * Rebuilt when the result set changes and only then. The counts beside them
   * move on every tick, so those are refreshed in place rather than by redrawing
   * a list whose open state and focus the user is standing in.
   */
  let channelGroups = [];
  const channelRows = new Map();

  /**
   * Where a message lives, as a person would say it.
   *
   * The hash belongs to a channel in a server. A direct message is not one, and
   * printing "#alice, bob" in the channel column labelled a conversation as a
   * text channel, in the table read immediately before deleting it and in the
   * report kept afterwards. The guild id is the honest test: search fills it for
   * a server message and leaves it null for a conversation, which is also what
   * the message link two columns over has always keyed on.
   */
  function channelLabel(message) {
    const name = message && message.channelName;
    if (!name) return '';
    return message.guildId ? `#${name}` : name;
  }

  /**
   * Draw the channel breakdown, or take it away when it has nothing to say.
   *
   * One channel is not a breakdown: a direct message and a single-channel search
   * both produce exactly one group, and a list of one only repeats the sentence
   * above it.
   */
  function renderChannels() {
    channelGroups = CL.filter.groupByChannel(state.results);
    channelRows.clear();
    const block = $('channel-block');
    const list = $('channel-list');
    list.textContent = '';

    if (channelGroups.length < 2) {
      hide(block);
      return;
    }

    for (const group of channelGroups) {
      const item = document.createElement('li');
      const label = document.createElement('label');

      const box = document.createElement('input');
      box.type = 'checkbox';
      box.setAttribute('aria-label', t('includeThisChannel'));
      box.addEventListener('change', () => setChannelPicked(group, box.checked));

      const name = document.createElement('span');
      name.className = 'chname';
      // The stored name is the parent channel's, so a thread reads as the
      // channel it hangs off, which is where its author would look for it.
      name.textContent = group.name ? `#${group.name}` : t('channelUnnamed');

      const tally = document.createElement('span');
      tally.className = 'chcount';

      label.append(box, name, tally);
      item.appendChild(label);
      list.appendChild(item);
      channelRows.set(group.key, { box, tally });
    }
    show(block);
  }

  /**
   * Take a whole channel in or out of the run.
   *
   * Applied to every message in the group rather than to the rendered ones,
   * which is the point: most of a result set is behind the render limit, and
   * before this the only selections that could reach those rows at all were all
   * and none. Snapshotted for undo like the header checkbox, and for the same
   * reason, since one tick here can replace hundreds of hand-picked rows.
   */
  function setChannelPicked(group, on) {
    previousSelection = new Set(state.excluded);
    for (const id of group.ids) {
      if (on) state.excluded.delete(id);
      else state.excluded.add(id);
    }
    syncRenderedRows();
    refreshSelectionCounts();
  }

  /**
   * Bring the rows on screen back in line with the selection behind them.
   *
   * Cheaper than renderReview and, more to the point, it keeps the scroll
   * position and the focus: a channel tick is aimed at rows the user is not
   * looking at, and rebuilding the table would throw away where they were.
   */
  function syncRenderedRows() {
    for (const row of $('results-body').querySelectorAll('tr')) {
      const message = state.results[Number(row.dataset.index)];
      if (!message) continue;
      const on = !state.excluded.has(message.id);
      const box = row.querySelector('input[type="checkbox"]');
      if (box) box.checked = on;
      row.classList.toggle('off', !on);
    }
  }

  function renderReview() {
    const total = state.results.length;
    const picked = selected().length;

    $('review-heading').textContent = headingFor(total, picked);
    $('review-summary').textContent = total
      ? t('reviewSummary', [CL.filter.describe(state.filters), state.resultScopeLabel])
      : t('reviewNoMatch', [state.resultScopeLabel, CL.filter.describe(state.filters)]);

    /*
     * Nothing matched.
     *
     * A table header with no rows under it reads as a table still loading,
     * which is the one thing it is not, and three download buttons over an
     * empty set are three buttons that write an empty file, under a heading
     * promising a copy of something. The sentence that explains the miss
     * becomes the empty state itself rather than a caption above an empty
     * frame, so this costs no new words in eleven languages.
     */
    const empty = total === 0;
    $('review-summary').classList.toggle('blank', empty);
    $('results-wrap').classList.toggle('hidden', empty);
    $('save-block').classList.toggle('hidden', empty);

    const truncated = $('review-truncated');
    if (state.truncated) {
      truncated.textContent = t('truncatedNotice');
      show(truncated);
    } else {
      hide(truncated);
    }

    if (!state.shown) state.shown = MAX_ROWS;
    lastPicked = null;
    const body = $('results-body');
    body.textContent = '';
    body.appendChild(rowsFor(0, Math.min(state.shown, state.results.length)));

    renderChannels();
    refreshSelectionCounts();
  }

  /** Build rows [from, to) as a fragment, so appending never rebuilds the table. */
  function rowsFor(from, to) {
    const frag = document.createDocumentFragment();
    for (let index = from; index < to; index++) {
      const message = state.results[index];
      const tr = document.createElement('tr');

      const pick = document.createElement('td');
      pick.className = 'pick';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = !state.excluded.has(message.id);
      box.setAttribute('aria-label', t('includeThisMessage'));
      // Bound on click rather than change, because only click carries shiftKey.
      box.addEventListener('click', (event) => {
        const on = box.checked;
        if (event.shiftKey && lastPicked !== null && lastPicked !== index) {
          const lo = Math.min(lastPicked, index);
          const hi = Math.max(lastPicked, index);
          for (let k = lo; k <= hi; k++) setPicked(k, on);
        } else {
          setPicked(index, on);
        }
        lastPicked = index;
        // Undo goes back one action, not to a bookmark. Once a row has been
        // ticked by hand the stored set no longer describes "just before this",
        // so offering to restore it would quietly throw that work away instead
        // of giving it back.
        previousSelection = null;
        refreshSelectionCounts();
      });
      pick.appendChild(box);
      tr.classList.toggle('off', state.excluded.has(message.id));

      const when = document.createElement('td');
      const link = document.createElement('a');
      link.href = discordUrl(message);
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = localStamp(message.timestamp);
      link.title = t('openInDiscord');
      when.appendChild(link);

      const where = document.createElement('td');
      where.textContent = channelLabel(message);

      const what = document.createElement('td');
      what.className = 'msg';
      // textContent, never innerHTML. This is other people's text rendered in a
      // privileged extension page, and there is no version of this worth risking.
      what.textContent =
        message.content || (message.attachments.length ? t('attachmentOnly') : t('noText'));

      // Said on the row, not only counted underneath the Start button. The
      // pre-flight has always printed how many messages would be left alone and
      // then hidden which ones, so the only way to find them was to compare two
      // numbers. Marked as text rather than by colour alone, so it survives
      // being read out and being printed.
      if (!CL.filter.isDeletable(message)) {
        tr.classList.add('untouchable');
        const mark = document.createElement('span');
        mark.className = 'rowmark';
        mark.textContent = t('rowLeftAlone');
        what.appendChild(mark);
      }

      tr.append(pick, when, where, what);
      tr.dataset.index = String(index);
      frag.appendChild(tr);
    }
    return frag;
  }

  /** Set one row's state in both the model and, if it is rendered, the table. */
  function setPicked(index, on) {
    const message = state.results[index];
    if (!message) return;
    if (on) state.excluded.delete(message.id);
    else state.excluded.add(message.id);
    const row = $('results-body').querySelector(`tr[data-index="${index}"]`);
    if (!row) return;
    const box = row.querySelector('input[type="checkbox"]');
    if (box) box.checked = on;
    row.classList.toggle('off', !on);
  }

  /**
   * Update everything that depends on the selection without rebuilding the
   * table, which would lose scroll position on every tick of a checkbox.
   */
  /**
   * The counts and tick states beside each channel, recomputed in one pass.
   *
   * One walk of the result set rather than one filter per channel, which on a
   * twenty-channel server would be twenty walks per tick of a single box.
   */
  function refreshChannelCounts() {
    if (channelRows.size === 0) return;
    const picked = new Map();
    for (const group of channelGroups) picked.set(group.key, 0);
    for (const message of state.results) {
      if (state.excluded.has(message.id)) continue;
      const key = String(message.parentId || message.channelId || '');
      if (picked.has(key)) picked.set(key, picked.get(key) + 1);
    }
    for (const group of channelGroups) {
      const row = channelRows.get(group.key);
      if (!row) continue;
      const on = picked.get(group.key) || 0;
      row.tally.textContent = t('channelTally', [num(on), num(group.ids.length)]);
      // Checked and indeterminate together is the state this spends most of its
      // time in, and it is the one the header checkbox already draws as a dash.
      row.box.checked = on > 0;
      row.box.indeterminate = on > 0 && on < group.ids.length;
    }
  }

  function refreshSelectionCounts() {
    const total = state.results.length;
    const picked = selected().length;

    $('review-heading').textContent = headingFor(total, picked);
    refreshChannelCounts();

    $('pick-all').checked = picked > 0;
    $('pick-all').indeterminate = picked > 0 && picked < total;

    // Counted rather than asserted. The note used to say the rows past the
    // render limit "stay selected", which stopped being true the moment anyone
    // used the select-none box, and a note about a delete set has to be right.
    const rendered = Math.min(state.shown, total);
    const beyond = Math.max(0, total - rendered);
    const beyondPicked = beyond
      ? state.results.slice(rendered).reduce((n, m) => n + (state.excluded.has(m.id) ? 0 : 1), 0)
      : 0;
    $('results-note').textContent = beyond
      ? `${plural('resultsNote', beyondPicked, [
          num(rendered),
          num(total),
          num(beyond),
          num(beyondPicked),
        ])} ${t('shiftClickHint')}`
      : total > 1
        ? t('shiftClickHint')
        : '';

    const more = $('show-more');
    more.classList.toggle('hidden', beyond === 0);
    const nextBatch = Math.min(MAX_ROWS, beyond);
    more.textContent = plural('showMore', nextBatch);

    $('undo-pick').classList.toggle('hidden', previousSelection === null);

    // The row holding those two collapses when neither is on offer, the same
    // way the tab-state strip does, rather than reserving a gap between the
    // table and the note under it for buttons that are not there.
    $('results-actions').classList.toggle(
      'hidden',
      more.classList.contains('hidden') && $('undo-pick').classList.contains('hidden')
    );

    $('review-next').disabled = picked === 0;
    for (const button of document.querySelectorAll('[data-export]')) button.disabled = picked === 0;
  }

  /* ---------------------------------------------------------------- */
  /* Step 5: the run                                                   */
  /* ---------------------------------------------------------------- */

  const CONFIRM_ABOVE = 100;

  function chosenAction() {
    const checked = document.querySelector('input[name="action"]:checked');
    return checked ? checked.value : 'delete';
  }

  /**
   * How many of the selected messages this action can actually touch.
   *
   * Asked of `CL.filter.canAct` rather than worked out here, because the job
   * loop asks the same question of the same function before every call. The
   * number on screen, the number typed back into the confirm box and the number
   * the run delivers all come from one place by construction.
   */
  function affectedCount(action) {
    return selected().filter(CL.filter.canAct(action)).length;
  }

  /**
   * Mark the moment the screen turns destructive.
   *
   * One ring off the pre-flight box, and only from here: this runs when the
   * chosen action changes and when the step opens, which are the two moments
   * the answer to "can this be taken back" is actually new. renderPreflight()
   * is called from several other places, including standing a superseded tab
   * back up, and none of those are news worth a pulse.
   *
   * The class is taken off and the element measured before it goes back on.
   * Without that read the browser coalesces both writes into one frame, sees no
   * change, and the animation never restarts, so it would play once per page
   * and never again.
   */
  function flagEscalation(destructive) {
    const box = $('preflight');
    box.classList.remove('alarm');
    if (!destructive) return;
    void box.offsetWidth;
    box.classList.add('alarm');
  }

  function syncRunForm() {
    const action = chosenAction();
    const edits = action !== 'delete';
    $('replacement-field').classList.toggle('hidden', !edits);
    $('replacement-hint').classList.toggle('hidden', action !== 'edit-then-delete');
    renderPreflight();
    flagEscalation(action !== 'edit');
  }

  /**
   * Freeze what the run was started with, for as long as it is running.
   *
   * Every control here was read once, when Start was pressed, and then left
   * live. Nothing enforced that, so a click on a different action while the bar
   * was moving rebuilt the whole pre-flight around it: the screen described an
   * overwrite while the job in memory went on deleting, and the line saying it
   * could not be undone came and went according to a radio the run had stopped
   * listening to. Start came back too, because the pre-flight derives it from
   * `state.ran`, which is still false mid-run.
   *
   * The lasting damage was one screen further on. Stop a run, take the offer to
   * carry on with what it never reached, and the remainder goes out under
   * whichever radio is checked by then, which is not necessarily the one the
   * user confirmed. A run agreed to as an overwrite could finish as a delete.
   *
   * The backup box is in here for the same reason: it says a copy is taken
   * before the first deletion, and after the first deletion that is a promise
   * nothing can keep.
   */
  function lockRunForm(locked) {
    for (const radio of document.querySelectorAll('input[name="action"]')) {
      radio.disabled = locked;
    }
    $('replacement').disabled = locked;
    $('backup').disabled = locked;
    $('confirm').disabled = locked;
  }

  /**
   * The sentence immediately above the button.
   *
   * Spelled out in full rather than shown as a count next to an icon, and it
   * names the number that cannot be recovered. If somebody is about to make a
   * mistake, this line is the last place they can notice.
   */
  function renderPreflight() {
    const action = chosenAction();
    const total = selected().length;
    // Counted per action, because the two are not the same question. Discord
    // will remove a join notice, since the account is what it is a notice
    // about, and will not overwrite one, since there is no text behind it. A
    // single answer for both had to be the stricter one, which promised less
    // than a delete could deliver and left those messages unreachable for good.
    const affected = affectedCount(action);
    const writes = action === 'edit-then-delete' ? 2 : 1;
    const estimate = CL.job.estimateMs(affected, writes, null);

    const verb = t(
      action === 'delete' ? 'verbDelete' : action === 'edit' ? 'verbEdit' : 'verbEditThenDelete'
    );

    const lines = [];
    lines.push(
      CL.filter.isEmpty(state.filters)
        ? t('preflightAll', [verb, count(affected), state.resultScopeLabel])
        : t('preflightFiltered', [
            verb,
            count(affected),
            state.resultScopeLabel,
            CL.filter.describe(state.filters),
          ])
    );
    lines.push(t('preflightPace', [humanDuration(estimate)]));
    // The job loop lives in this page on purpose, so the tab is the run. Nothing
    // said so, and "about 3 hours" is exactly the sentence that makes somebody
    // shut the laptop.
    if (estimate > 5 * 60 * 1000) {
      lines.push(t('preflightKeepOpen'));
    }
    if (affected < total) {
      lines.push(
        t(action === 'delete' ? 'preflightUndeletable' : 'preflightUneditable', [
          count(total - affected),
        ])
      );
    }
    if (action !== 'edit') lines.push(t('preflightNoUndo'));

    const box = $('preflight');
    // Overwriting leaves the message standing and deleting does not, and both
    // used to be delivered in the same mild amber as the sentence about how
    // long the run would take.
    box.classList.toggle('grave', action !== 'edit');
    box.textContent = '';
    for (const line of lines) {
      const p = document.createElement('p');
      p.textContent = line;
      box.appendChild(p);
    }
    // The line saying it cannot be undone, which is the last one pushed on any
    // run that has one. Marked here rather than further down, because the stale
    // notice is appended after this and would otherwise be the last child.
    if (action !== 'edit' && box.lastElementChild) {
      box.lastElementChild.className = 'irreversible';
    }

    const needsTyping = affected > CONFIRM_ABOVE && action !== 'edit';
    $('confirm-field').classList.toggle('hidden', !needsTyping);
    // Grouped, like the sentence above it. The sentence has always said "1,234"
    // and the box wanted "1234", so a user who typed what they had just read was
    // told they had got it wrong, on the last screen before something
    // irreversible. The separators are stripped again on the way back in.
    $('confirm-label').textContent = t('confirmLabel', [num(affected)]);
    $('confirm').value = '';

    // A finished run leaves the result set describing messages that mostly no
    // longer exist. Running it again would report every one of them as "already
    // gone, counts as done", which looks like success and means nothing.
    if (state.ran) {
      const stale = document.createElement('p');
      stale.textContent = t('preflightStale');
      box.appendChild(stale);
    }
    // `state.job` belongs in here with the rest. This is the one place Start's
    // disabled state is decided, and it is called from several paths that can
    // run while a job is going, so leaving the running job out of the sum meant
    // any of them handed the button back mid-run.
    $('start').disabled = affected === 0 || state.ran || state.superseded || !!state.job;
  }

  function renderProgress(p) {
    const done = p.processed;
    const pct = p.total ? Math.round((done / p.total) * 100) : 0;
    $('run-fill').style.width = `${pct}%`;
    $('run-bar').setAttribute('aria-valuenow', String(pct));
    // Moving, as opposed to merely partway. The width creeps by a fraction of a
    // percent per message, so on a set of several thousand it is not
    // distinguishable from a bar that has stopped. Off the moment the run is
    // paused: a bar that keeps moving over a paused run is the one thing on
    // this screen that would be a lie.
    $('run-bar').classList.toggle('moving', p.status !== 'paused');
    const line =
      t('runCounter', [num(done), num(p.total)]) +
      (p.failed ? t('runCounterFailed', [num(p.failed)]) : '') +
      (p.skipped ? t('runCounterSkipped', [num(p.skipped)]) : '');
    $('run-counter').textContent = line;
    // A message was just processed, so whatever the limiter was waiting out has
    // passed. Cleared here rather than by an event, because there is no "the
    // wait ended" to listen for and work resuming is the same news.
    paceNote('');
    announce(line, `${p.status}:${pct}`);
    $('run-eta').textContent =
      p.status === 'paused' ? t('runPaused') : p.etaMs ? t('runEta', [humanDuration(p.etaMs)]) : '';
    // The whole design asks the user to leave the run alone, then gave them no
    // way to check on it without switching to the tab. The title is the one
    // surface a background tab still has.
    document.title =
      p.status === 'paused' ? t('titlePaused', [num(pct)]) : t('titleRunning', [num(pct)]);
  }

  function renderReport(summary) {
    const box = $('run-report');
    box.textContent = '';

    /*
     * The same report, in the shape a file wants.
     *
     * Filled as the sentences are built for the screen rather than rebuilt
     * afterwards, so the file cannot say something different from the page. It
     * is the reason the strings go into an object here instead of straight into
     * a text node.
     */
    const doc = { headline: '', error: null, lines: [], sections: [] };

    const headline = document.createElement('p');
    headline.className = 'headline';
    doc.headline = t(
      summary.status === 'done'
        ? 'reportFinished'
        : summary.status === 'cancelled'
          ? 'reportCancelled'
          : 'reportHalted',
      [count(summary.done)]
    );
    headline.textContent = doc.headline;
    box.appendChild(headline);

    if (summary.error) {
      const why = document.createElement('p');
      why.className = 'error';
      why.textContent = summary.error;
      doc.error = summary.error;
      box.appendChild(why);
    }

    // The job has counted all of these from the beginning and the report showed
    // one of them. "Finished. 2,980 messages handled." is not an account of a
    // run that also left 20 alone, failed on 3 and took two hours.
    const tally = document.createElement('p');
    tally.textContent = t('reportTally', [
      num(summary.total),
      num(summary.done),
      num(summary.skipped),
      num(summary.failed),
    ]);
    doc.lines.push(tally.textContent);
    box.appendChild(tally);

    if (summary.elapsedMs > 0) {
      const took = document.createElement('p');
      took.textContent = t('reportElapsed', [humanElapsed(summary.elapsedMs)]);
      doc.lines.push(took.textContent);
      box.appendChild(took);
    }

    // A run halted at message three of five thousand said "Stopped early. 3
    // messages handled." and left the reader to work out for themselves that
    // the other 4,997 were never attempted.
    if (summary.remaining > 0) {
      const left = document.createElement('p');
      left.textContent = plural('reportRemaining', summary.remaining);
      doc.lines.push(left.textContent);
      box.appendChild(left);
    }

    for (const [label, list] of [
      ['reportSkipped', summary.skips],
      ['reportFailed', summary.failures],
    ]) {
      if (!list.length) continue;
      const details = document.createElement('details');
      const sum = document.createElement('summary');
      sum.textContent = t(label, [count(list.length)]);
      details.appendChild(sum);
      // The file gets the whole list. The fifty on screen are a reading limit,
      // not a record of what happened, and the file is the record.
      doc.sections.push({
        title: sum.textContent,
        entries: list.map((entry) => {
          const m = entry.message || {};
          return {
            when: localStamp(m.timestamp),
            where: channelLabel(m),
            text: m.content || '',
            reason: entry.reason,
            id: m.id || '',
          };
        }),
      });
      const ul = document.createElement('ul');
      for (const entry of list.slice(0, 50)) {
        const li = document.createElement('li');
        // A raw snowflake tells the reader nothing about which message this
        // was. The id stays, on the title, for anyone who wants it.
        const m = entry.message || {};
        const label = channelLabel(m);
        const where = label ? ` ${label}` : '';
        const what = m.content ? ` "${m.content.slice(0, 60)}"` : '';
        li.textContent = `${localStamp(m.timestamp)}${where}${what}: ${entry.reason}`;
        li.title = m.id || '';
        ul.appendChild(li);
      }
      // Truncating without saying so made the report understate itself.
      if (list.length > 50) {
        const rest = document.createElement('li');
        rest.textContent = t('reportAndMore', [num(list.length - 50)]);
        ul.appendChild(rest);
      }
      details.appendChild(ul);
      box.appendChild(details);
    }

    const buttons = document.createElement('div');
    buttons.className = 'actions left';

    /**
     * Load a set of messages back into the run screen.
     *
     * Shared by the two buttons that do it, because the difference between them
     * is only which messages, and everything else has to happen the same way:
     * the report stops being the thing that is about to be lost, the review
     * table is rebuilt so the rows can still be inspected and spared, and focus
     * moves somewhere real rather than being destroyed with the report.
     */
    function loadBack(messages) {
      state.results = messages;
      state.excluded = new Set();
      state.shown = MAX_ROWS;
      state.ran = false;
      state.unsavedReport = false;
      previousSelection = null;
      renderReview();
      hide(box);
      renderPreflight();
      // hide() takes the button that was just clicked out of the accessibility
      // tree while it still holds focus, which drops it to <body>: the next Tab
      // restarts at the page heading and nothing announces that Start is live
      // again. Every other place in this file that hides what it was standing
      // on moves focus deliberately, and these two did not.
      const heading = $('step-run').querySelector('h2');
      if (heading) heading.focus({ preventScroll: true });
    }

    /*
     * Carry on with the messages the run never reached.
     *
     * A run that halted on a rate limit or an expired session, or that the user
     * stopped, left every unattempted message in a queue this screen could not
     * see. The only route on was to search the whole server again and redo every
     * exclusion by hand, which on a set that took twenty minutes to page is a
     * reason not to stop a run that should be stopped.
     *
     * The tail goes back through createJob like any other queue, so the author
     * check and the type check run again on every message rather than being
     * waved through as already vetted.
     */
    if (summary.remainingMessages && summary.remainingMessages.length) {
      const carry = document.createElement('button');
      carry.className = 'ghost';
      carry.type = 'button';
      carry.textContent = t('reportContinue', [count(summary.remainingMessages.length)]);
      carry.addEventListener('click', () => loadBack(summary.remainingMessages.slice()));
      buttons.appendChild(carry);
    }

    if (summary.failures.length) {
      const retry = document.createElement('button');
      retry.className = 'ghost';
      retry.type = 'button';
      retry.textContent = t('reportRetry', [num(summary.failures.length)]);
      retry.addEventListener('click', () => loadBack(summary.failures.map((f) => f.message)));
      buttons.appendChild(retry);
    }

    /*
     * Keep the report.
     *
     * What a run did lives only in this box, and a run can take hours. Which
     * messages were left alone and why, which failed and with what, how many
     * were never reached: close the tab and it is gone, and there is nothing to
     * go back and look at, because the messages it is about have been deleted.
     * The list on screen also stops at fifty; the file does not.
     */
    const save = document.createElement('button');
    save.className = 'ghost';
    save.type = 'button';
    save.textContent = t('reportSave');
    save.addEventListener('click', () => {
      try {
        const meta = metaFor();
        download(
          CL.exporter.reportToHTML(doc, meta),
          CL.exporter.filenameFor(meta, 'html', 'report'),
          'text/html'
        );
        say($('run-status'), t('saved'));
        // The unload guard is here to protect an unsaved report, so saving it
        // is what lifts the guard. A prompt that cannot be satisfied is worse
        // than no prompt.
        state.unsavedReport = false;
      } catch (err) {
        say($('run-status'), (err && err.message) || t('errSaveFailed'), 'error');
      }
    });
    buttons.appendChild(save);

    // The preflight tells the user to search again and then offers nothing that
    // does it, so the route was Back, Back, Search. Several passes over one
    // server is the ordinary way this gets used.
    const again = document.createElement('button');
    again.className = 'ghost';
    again.type = 'button';
    again.textContent = t('reportSearchAgain');
    again.addEventListener('click', () => {
      state.results = [];
      state.excluded = new Set();
      state.shown = MAX_ROWS;
      state.ran = false;
      state.unsavedReport = false;
      previousSelection = null;
      hide(box);
      goTo('filter');
    });
    buttons.appendChild(again);
    box.appendChild(buttons);

    show(box);
    // The run can take hours, so the report often lands on an unattended tab.
    // Taking focus is what tells a screen reader it arrived at all.
    box.focus({ preventScroll: true });
  }

  async function start() {
    // Both guards are belt and braces. Nothing yields between here and the
    // point the button is disabled, so neither should be reachable, but this is
    // the one function in the app that cannot be allowed to run twice.
    if (state.superseded || state.job) return;

    const action = chosenAction();
    // The same count renderPreflight put on screen. The number the user is asked
    // to type back has to be the number they were just shown, so this cannot
    // work out "affected" a second way.
    const affected = affectedCount(action);

    // Read back through the same module that printed it, rather than stripped
    // of the three separators English happens to use. The label is written with
    // `num()`, so its digits and its grouping are the locale's, and comparing
    // that against an ASCII count meant a locale printing anything else asked
    // for a number and then refused the number it had just asked for, over and
    // over, with no way through.
    const typed = CL.i18n.parseCount($('confirm').value);
    if (affected > CONFIRM_ABOVE && action !== 'edit' && typed !== affected) {
      say($('run-status'), t('confirmRefused', [num(affected)]), 'error');
      return;
    }

    // Same reasoning as the search path: this click is the "start again" that a
    // halt told the user to do, so it has to actually clear the halt.
    clearHalt();

    let runner;
    try {
      runner = CL.job.createJob({
        client,
        messages: selected(),
        authorId: state.me ? state.me.id : null,
        action,
        editContent: $('replacement').value,
        onProgress: renderProgress,
      });
    } catch (err) {
      say($('run-status'), err.message, 'error');
      return;
    }

    // The backup is written before the first destructive call, not alongside
    // it. If the export is going to fail, it has to fail while the messages
    // still exist.
    if ($('backup').checked) {
      try {
        say($('run-status'), t('statusSavingCopy'));
        const meta = metaFor();
        const text = CL.exporter.toHTML(selected(), meta);
        // Built and checked before it is handed over, rather than trusting that
        // producing it worked. An empty file that looks like a backup is worse
        // than no backup, because it is the thing the user will reach for.
        if (!text || text.indexOf('</html>') === -1) {
          throw new Error(t('errCopyIncomplete'));
        }
        download(text, CL.exporter.filenameFor(meta, 'html'), 'text/html');
      } catch (err) {
        say($('run-status'), t('errCopyFailed', [err.message]), 'error');
        return;
      }
    }

    state.job = runner;
    say($('run-status'), '');
    $('start').disabled = true;
    $('run-back').disabled = true;
    lockRunForm(true);
    // The rail closes for the same reason run-back does: leaving this screen
    // takes the counter, the pace note and the Stop button off screen with it.
    setBusy(true);
    hide($('run-report'));
    show($('run-progress'));
    $('run-pause').textContent = t('buttonPause');

    // Wrapped so the screen cannot be left mid-run by anything thrown on the
    // way out. This is the one function that holds the Back button, the rail
    // and the unload prompt all at once, and a tab stuck in that state has a
    // finished job it cannot report and no control that says so.
    let summary;
    try {
      summary = await runner.start();
    } finally {
      hide($('run-progress'));
      paceNote('');
      document.title = 'Clearline';
      $('run-back').disabled = false;
      setBusy(false);
      lockRunForm(false);
      state.job = null;
    }

    state.ran = true;
    $('start').disabled = true;
    // The report is now the only account of something that cannot be undone, so
    // it takes over the guard the running job was holding. Only when the run
    // actually did something: a report of nothing is not worth a prompt.
    state.unsavedReport = summary.done + summary.failed + summary.skipped > 0;
    renderReport(summary);
    // A session that expired partway through is the most likely reason a long
    // run stopped early, and the retry button is useless until it is fixed.
    offerReconnect();
  }

  /* ---------------------------------------------------------------- */
  /* Wiring                                                            */
  /* ---------------------------------------------------------------- */

  $('connect').addEventListener('click', () => connect(false));
  $('takeover').addEventListener('click', reclaim);
  $('reconnect').addEventListener('click', reconnect);

  /*
   * Going back by the rail rather than by the Back buttons.
   *
   * Delegated to the list, because which of the five is live changes on every
   * step. syncRail() has already decided that by disabling the rest, and a
   * disabled button fires no click at all, so the guard here is only for a
   * click that lands on the list itself between two of them.
   */
  $('rail').addEventListener('click', (event) => {
    const button = event.target.closest('.railbtn');
    if (!button || button.disabled) return;
    const item = button.closest('li');
    if (!item || !item.dataset.step) return;
    // The Act step is derived from the selection, and every other way in
    // derives it on the way past: Continue calls syncRunForm, carrying on with
    // a queue calls renderPreflight. The rail did neither, so arriving by it
    // showed whatever the sentence and the button happened to be left as, which
    // on the screen that counts what is about to be destroyed is not a place to
    // trust a leftover.
    if (item.dataset.step === 'run') renderPreflight();
    goTo(item.dataset.step);
  });

  for (const radio of document.querySelectorAll('input[name="scope-kind"]')) {
    radio.addEventListener('change', syncScopeKind);
  }
  $('guild-select').addEventListener('change', loadChannels);
  $('where-next').addEventListener('click', () => {
    if (!commitScope()) return;
    $('filter-scope-label').textContent = t('lookingIn', [state.scopeLabel]);
    goTo('filter');
  });

  $('filter-back').addEventListener('click', () => goTo('where'));
  $('search').addEventListener('click', runSearch);
  $('search-stop').addEventListener('click', () => {
    state.stopSearch = true;
    $('search-counter').textContent = t('searchStopping');
    // Nothing takes a stop back, so the button has nothing left to offer. Left
    // live it invited a second click that could only look ignored, on the one
    // screen where somebody is already wondering whether anything is happening.
    $('search-stop').disabled = true;
  });

  // There is no form here, so there is no implicit submit and Enter did nothing
  // in the boxes people type into most. Deliberately not bound on #confirm: the
  // destructive step should still take a separate, aimed click.
  for (const id of ['f-contains', 'f-after', 'f-before']) {
    $(id).addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || $('search').disabled) return;
      event.preventDefault();
      runSearch();
    });
  }

  $('pick-all').addEventListener('change', () => {
    // Kept before it is replaced, not after. This is the one control on the
    // screen that can throw away an arbitrary amount of careful work in a
    // single click, including by being hit on the way to something else.
    previousSelection = new Set(state.excluded);
    if ($('pick-all').checked) state.excluded = new Set();
    else state.excluded = new Set(state.results.map((m) => m.id));
    renderReview();
  });

  $('undo-pick').addEventListener('click', () => {
    if (previousSelection === null) return;
    state.excluded = previousSelection;
    previousSelection = null;
    renderReview();
    $('pick-all').focus({ preventScroll: true });
  });

  $('show-more').addEventListener('click', () => {
    const from = Math.min(state.shown, state.results.length);
    state.shown = Math.min(state.shown + MAX_ROWS, state.results.length);
    // Appended, not re-rendered. Rebuilding the table would throw away the
    // scroll position on every click, which on the fourth click is the whole
    // reason somebody pressed the button.
    $('results-body').appendChild(rowsFor(from, state.shown));
    refreshSelectionCounts();
  });

  $('review-back').addEventListener('click', () => goTo('filter'));
  $('review-next').addEventListener('click', () => {
    syncRunForm();
    goTo('run');
  });
  for (const button of document.querySelectorAll('[data-export]')) {
    button.addEventListener('click', () => {
      try {
        exportAs(button.dataset.export);
        say($('review-status'), t('saved'));
      } catch (err) {
        say($('review-status'), (err && err.message) || t('errSaveFailed'), 'error');
      }
    });
  }

  for (const radio of document.querySelectorAll('input[name="action"]')) {
    radio.addEventListener('change', syncRunForm);
  }
  $('run-back').addEventListener('click', () => goTo('review'));
  $('start').addEventListener('click', start);
  $('run-pause').addEventListener('click', () => {
    if (!state.job) return;
    if (state.job.status === 'paused') {
      state.job.resume();
      $('run-pause').textContent = t('buttonPause');
    } else {
      state.job.pause();
      $('run-pause').textContent = t('buttonResume');
    }
  });
  $('run-cancel').addEventListener('click', () => {
    if (state.job) state.job.cancel();
  });

  /**
   * The tab is the run, so closing it is destroying work in progress.
   *
   * The job loop lives here rather than in the service worker on purpose, and
   * nothing said so anywhere: a run reported as "about 3 hours" invites exactly
   * the shut-the-laptop that kills it, with no report and no record of how far
   * it got.
   *
   * The finished report is guarded on the same terms. It is the only account of
   * which messages were left alone and why, which failed and with what, and how
   * many were never reached, about messages that no longer exist to be looked
   * at again. Both flags clear themselves the moment there is nothing to lose,
   * because a prompt that cannot be satisfied is worse than no prompt: the job
   * when start() resolves, the report when it is saved or acted on.
   *
   * A search in progress is the third, and it was the one left out. Paging a
   * whole server runs for minutes with nothing written down anywhere: the result
   * set exists only in this page, and a reload starts it from nothing. The
   * screen it happens on is also the one most likely to be reloaded, since a
   * long wait with a sweeping bar is exactly what somebody reaches for the
   * reload button over, and the app's own note about a rate limit tells them to
   * start again. The other two were guarded because they are expensive to lose;
   * this one is expensive to lose in the same way and for longer.
   */
  window.addEventListener('beforeunload', (event) => {
    if (!state.job && !state.searching && !state.unsavedReport) return;
    event.preventDefault();
    event.returnValue = '';
  });

  CL.i18n.apply();
  syncScopeKind();
  syncTabActions();
  // Derived from the step, not latched in the markup, so the rail cannot drift
  // out of step with what is actually on screen.
  syncRail();

  // Exposed for the end to end suite, which drives the real screens rather than
  // a reimplementation of them. Nothing in the app reads this.
  window.__clearline = { state, goTo, setBusy, renderReview, renderPreflight, localStamp };
})();
