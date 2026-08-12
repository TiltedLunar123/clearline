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

  const client = CL.api_client.createClient();
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
    stopSearch: false,
  };

  const $ = (id) => document.getElementById(id);

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

  function goTo(step) {
    let opened = null;
    for (const name of STEPS) {
      const section = $(`step-${name}`);
      if (!section) continue;
      section.classList.toggle('hidden', name !== step);
      if (name === step) opened = section;
    }
    for (const item of document.querySelectorAll('#rail li')) {
      const index = STEPS.indexOf(item.dataset.step);
      item.classList.toggle('on', item.dataset.step === step);
      item.classList.toggle('done', index < STEPS.indexOf(step));
    }
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
    if ($('status').textContent === STOOD_DOWN) say($('status'), '');
    if ($('run-status').textContent === t('runStoppedByTakeover')) say($('run-status'), '');
    hide($('takeover'));
    syncTabActions();
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

      // Checked between every call, not once at the top. Connect is the only
      // path to the network that starts before there is anything on screen to
      // disable, so a takeover landing here has nothing else to stop it: the
      // remaining calls go out on a limiter the new owner knows nothing about,
      // and the tail then blanks the notice explaining that this tab stopped.
      const me = await client.me();
      if (state.superseded) return;
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
  async function reconnect() {
    if (state.superseded || state.connecting) return;
    const button = $('reconnect');
    button.disabled = true;
    clearHalt();
    say($('status'), t('statusReconnecting'));
    try {
      const reply = await CL.api.runtime.sendMessage({ type: 'clearline:get-token' });
      // Checked after the await, like every other network path here. A takeover
      // landing inside this round trip used to be overwritten by the tail of
      // this function: the stand-down notice lives in #status, and the success
      // line below is written to the same element, so a stopped tab ended up
      // reading "Reconnected" with Search and Start greyed out and nothing left
      // on screen to explain why.
      if (state.superseded) return;
      if (!reply || !reply.ok) {
        say($('status'), tokenProblem(reply && reply.reason), 'error');
        return;
      }
      client.setToken(reply.token);

      // Asked, not assumed. Only when there is an identity to protect: before a
      // connect has ever succeeded there is nothing pinned to contradict.
      if (state.me) {
        const me = await client.me();
        if (state.superseded) return;
        if (String(me.id) !== String(state.me.id)) {
          client.setToken(null);
          say($('status'), t('errDifferentAccount'), 'error');
          return;
        }
      }

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
      say($('where-status'), '');
    } catch (err) {
      // Dropped rather than left standing. A failed load used to leave the
      // previous server's channels in state, and commitScope closes
      // channelNameFor over that list, so every row in the review table and
      // every row of an export got a blank or a wrong channel name.
      state.channels = [];
      state.channelNames = new Map();
      state.channelsFor = null;
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
    button.disabled = true;
    say($('filter-status'), '');
    show($('search-progress'));
    // The message a halt throws tells the user to start again. This is them
    // starting again, so it has to mean something.
    clearHalt();

    const bounds = CL.filter.toWindow(filters);
    const startedAt = Date.now();
    $('search-fill').style.width = '0%';
    $('search-elapsed').textContent = '';

    try {
      const found = await finder.find({
        scope,
        authorId: state.me.id,
        minId: bounds.minId,
        maxId: bounds.maxId,
        shouldStop: () => state.stopSearch,
        onProgress: (p) => {
          if (p.phase === 'indexing') {
            $('search-counter').textContent = t('searchIndexing');
          } else if (p.strategy === 'history') {
            // The history path knows how much it has read but not how much
            // there is, so it reports work done. It was reporting neither, and
            // a big DM sat on one unchanging line for minutes looking wedged.
            $('search-counter').textContent = t('searchHistoryProgress', [
              num(p.scanned || 0),
              num(p.found),
            ]);
          } else {
            $('search-counter').textContent = p.total
              ? t('searchFoundOf', [count(p.found), num(p.total)])
              : t('searchFound', [count(p.found)]);
          }
          if (p.total) {
            $('search-fill').style.width = `${Math.min(100, Math.round((p.found / p.total) * 100))}%`;
          }
          // Something on screen has to move even when neither denominator is
          // known, or a slow search is indistinguishable from a stuck one.
          $('search-elapsed').textContent = t('searchElapsed', [humanElapsed(Date.now() - startedAt)]);
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
      state.shown = MAX_ROWS;
      state.ran = false;
      state.truncated = !!found.truncated;
      renderReview();
      goTo('review');
    } catch (err) {
      say($('filter-status'), (err && err.message) || t('errSearchFailed'), 'error');
      offerReconnect();
    } finally {
      // Not unconditionally false. A tab that was superseded while searching
      // would otherwise hand its Search button back at exactly the moment it
      // was supposed to have stopped.
      button.disabled = state.superseded;
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
   * Discord's timestamp, in the reader's own timezone.
   *
   * It arrives as an ISO instant with an offset, and slicing the first sixteen
   * characters off it prints UTC while calling it nothing. The date boxes two
   * screens back are local calendar days, so a row could sit under a summary
   * reading "sent on or before 5 March" while showing the 6th, immediately
   * before an irreversible action. Same instant either way; only the label was
   * lying.
   */
  function localStamp(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso).slice(0, 16).replace('T', ' ');
    const pad = (n) => String(n).padStart(2, '0');
    return (
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())}`
    );
  }

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

  function renderReview() {
    const total = state.results.length;
    const picked = selected().length;

    $('review-heading').textContent = headingFor(total, picked);
    $('review-summary').textContent = total
      ? t('reviewSummary', [CL.filter.describe(state.filters), state.resultScopeLabel])
      : t('reviewNoMatch', [state.resultScopeLabel, CL.filter.describe(state.filters)]);

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
      where.textContent = message.channelName ? `#${message.channelName}` : '';

      const what = document.createElement('td');
      what.className = 'msg';
      // textContent, never innerHTML. This is other people's text rendered in a
      // privileged extension page, and there is no version of this worth risking.
      what.textContent =
        message.content || (message.attachments.length ? t('attachmentOnly') : t('noText'));

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
  function refreshSelectionCounts() {
    const total = state.results.length;
    const picked = selected().length;

    $('review-heading').textContent = headingFor(total, picked);

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

  function deletableCount() {
    return selected().filter(CL.filter.isDeletable).length;
  }

  function syncRunForm() {
    const action = chosenAction();
    const edits = action !== 'delete';
    $('replacement-field').classList.toggle('hidden', !edits);
    $('replacement-hint').classList.toggle('hidden', action !== 'edit-then-delete');
    renderPreflight();
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
    const deletable = deletableCount();
    // The same for all three actions. Discord refuses the same message types
    // either way, so an edit run counting them in promised a number it could
    // not deliver, and then suppressed the line that would have explained the
    // shortfall because that line was tied to deleting.
    const affected = deletable;
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
    if (deletable < total) {
      lines.push(
        t(action === 'edit' ? 'preflightUneditable' : 'preflightUndeletable', [
          count(total - deletable),
        ])
      );
    }
    if (action !== 'edit') lines.push(t('preflightNoUndo'));

    const box = $('preflight');
    box.textContent = '';
    for (const line of lines) {
      const p = document.createElement('p');
      p.textContent = line;
      box.appendChild(p);
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
    $('start').disabled = affected === 0 || state.ran || state.superseded;
  }

  function renderProgress(p) {
    const done = p.processed;
    const pct = p.total ? Math.round((done / p.total) * 100) : 0;
    $('run-fill').style.width = `${pct}%`;
    $('run-bar').setAttribute('aria-valuenow', String(pct));
    $('run-counter').textContent =
      t('runCounter', [num(done), num(p.total)]) +
      (p.failed ? t('runCounterFailed', [num(p.failed)]) : '') +
      (p.skipped ? t('runCounterSkipped', [num(p.skipped)]) : '');
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

    const headline = document.createElement('p');
    headline.className = 'headline';
    headline.textContent = t(
      summary.status === 'done'
        ? 'reportFinished'
        : summary.status === 'cancelled'
          ? 'reportCancelled'
          : 'reportHalted',
      [count(summary.done)]
    );
    box.appendChild(headline);

    if (summary.error) {
      const why = document.createElement('p');
      why.className = 'error';
      why.textContent = summary.error;
      box.appendChild(why);
    }

    // The job has always counted this and the report has never shown it. A run
    // halted at message three of five thousand said "Stopped early. 3 messages
    // handled." and left the reader to work out for themselves that the other
    // 4,997 were never attempted.
    if (summary.remaining > 0) {
      const left = document.createElement('p');
      left.textContent = plural('reportRemaining', summary.remaining);
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
      const ul = document.createElement('ul');
      for (const entry of list.slice(0, 50)) {
        const li = document.createElement('li');
        // A raw snowflake tells the reader nothing about which message this
        // was. The id stays, on the title, for anyone who wants it.
        const m = entry.message || {};
        const where = m.channelName ? ` #${m.channelName}` : '';
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

    if (summary.failures.length) {
      const retry = document.createElement('button');
      retry.className = 'ghost';
      retry.type = 'button';
      retry.textContent = t('reportRetry', [num(summary.failures.length)]);
      retry.addEventListener('click', () => {
        state.results = summary.failures.map((f) => f.message);
        state.excluded = new Set();
        state.shown = MAX_ROWS;
        state.ran = false;
        renderReview();
        hide(box);
        renderPreflight();
      });
      buttons.appendChild(retry);
    }

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
    const affected = deletableCount();

    const typed = $('confirm').value.replace(/[\s,._]/g, '');
    if (affected > CONFIRM_ABOVE && action !== 'edit' && typed !== String(affected)) {
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
    hide($('run-report'));
    show($('run-progress'));
    $('run-pause').textContent = t('buttonPause');

    const summary = await runner.start();

    hide($('run-progress'));
    document.title = 'Clearline';
    $('run-back').disabled = false;
    state.job = null;
    state.ran = true;
    $('start').disabled = true;
    renderReport(summary);
    // A session that expired partway through is the most likely reason a long
    // run stopped early, and the retry button is useless until it is fixed.
    offerReconnect();
  }

  /* ---------------------------------------------------------------- */
  /* Wiring                                                            */
  /* ---------------------------------------------------------------- */

  $('connect').addEventListener('click', () => connect(false));
  $('takeover').addEventListener('click', () => connect(true));
  $('reconnect').addEventListener('click', reconnect);

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
    if ($('pick-all').checked) state.excluded = new Set();
    else state.excluded = new Set(state.results.map((m) => m.id));
    renderReview();
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
   * it got. `state.job` is nulled when start() resolves, so the guard takes
   * itself off again the moment there is nothing to lose.
   */
  window.addEventListener('beforeunload', (event) => {
    if (!state.job) return;
    event.preventDefault();
    event.returnValue = '';
  });

  CL.i18n.apply();
  syncScopeKind();
  syncTabActions();

  // Exposed for the end to end suite, which drives the real screens rather than
  // a reimplementation of them. Nothing in the app reads this.
  window.__clearline = { state, goTo, renderReview, renderPreflight, localStamp };
})();
