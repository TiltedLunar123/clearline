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

  const state = {
    me: null,
    guilds: [],
    dms: [],
    channels: [],
    scope: null,
    scopeLabel: '',
    tabId: null,
    superseded: false,
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

  const STEPS = ['connect', 'where', 'filter', 'review', 'run'];

  function goTo(step) {
    for (const name of STEPS) {
      const section = $(`step-${name}`);
      if (section) section.classList.toggle('hidden', name !== step);
    }
    for (const item of document.querySelectorAll('#rail li')) {
      const index = STEPS.indexOf(item.dataset.step);
      item.classList.toggle('on', item.dataset.step === step);
      item.classList.toggle('done', index < STEPS.indexOf(step));
    }
    window.scrollTo(0, 0);
  }

  /** "about 18 minutes", because a millisecond count is not an answer. */
  function humanDuration(ms) {
    const seconds = Math.round(ms / 1000);
    if (seconds < 45) return 'under a minute';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `about ${minutes} minute${minutes === 1 ? '' : 's'}`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (rest === 0) return `about ${hours} hour${hours === 1 ? '' : 's'}`;
    return `about ${hours}h ${rest}m`;
  }

  function count(n, one, many) {
    return `${n.toLocaleString()} ${n === 1 ? one : many || one + 's'}`;
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
      scope: state.scopeLabel,
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

  const TOKEN_PROBLEMS = {
    'no-tab': 'Open discord.com in another tab, sign in, then try again.',
    'not-logged-in': 'That Discord tab is not signed in yet. Sign in and try again.',
  };

  /** A DM has no name of its own, so it is named after who is in it. */
  function dmLabel(channel) {
    if (channel.name) return channel.name;
    const names = (channel.recipients || []).map((r) => r.global_name || r.username || 'unknown');
    if (names.length === 0) return 'Direct message';
    if (names.length <= 3) return names.join(', ');
    return `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
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
        say(
          $('status'),
          'Clearline is already open in another tab. Running two copies at once would send ' +
            'Discord requests twice as fast as is safe, so only one is allowed to work at a time.',
          'error'
        );
        show($('takeover'));
        return false;
      }
      if (reply && typeof reply.tabId === 'number') state.tabId = reply.tabId;
      hide($('takeover'));
    } catch {
      // No background to answer, which happens while the worker restarts. One
      // tab is the normal case, so carrying on is the right call.
    }
    return true;
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
    hide($('takeover'));
    say($('status'), 'Another Clearline tab took over, so this one has stopped.', 'error');
    if (state.job || state.ran) {
      say($('run-status'), 'Another Clearline tab took over, so this run was stopped.', 'error');
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
    if (!(await claimOwnership(force))) return;

    button.disabled = true;
    say($('status'), 'Looking for a signed in Discord tab...');

    try {
      const reply = await CL.api.runtime.sendMessage({ type: 'clearline:get-token' });
      if (!reply || !reply.ok) {
        say($('status'), TOKEN_PROBLEMS[reply && reply.reason] || 'Could not read the Discord session.', 'error');
        return;
      }

      client.setToken(reply.token);
      say($('status'), 'Connected. Loading your account...');

      const me = await client.me();
      // Sequential on purpose. Firing these together would be the first burst
      // the account ever sees from this extension, which is the opposite of the
      // pacing everything else here is built around.
      const guilds = await client.guilds();
      const dms = await client.directMessages();

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
        'Choose a server'
      );
      fillSelect(
        $('dm-select'),
        dms.map((d) => ({ value: d.id, label: dmLabel(d) })),
        'Choose a conversation'
      );

      hide($('connect-card'));
      show($('account-card'));
      say($('status'), '');
      goTo('where');
    } catch (err) {
      say($('status'), (err && err.message) || 'Something went wrong.', 'error');
    } finally {
      button.disabled = false;
    }
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
    if (state.superseded) return;
    const guildId = $('guild-select').value;
    const select = $('channel-select');
    if (!guildId) {
      select.disabled = true;
      fillSelect(select, [], 'Pick a server first');
      return;
    }

    select.disabled = true;
    fillSelect(select, [], 'Loading channels...');
    try {
      const channels = await client.guildChannels(guildId);
      state.channels = channels
        .filter((c) => TEXTY.indexOf(Number(c.type)) !== -1)
        .sort((a, b) => (a.position || 0) - (b.position || 0));
      fillSelect(
        select,
        state.channels.map((c) => ({ value: c.id, label: `#${c.name}` })),
        null
      );
      select.disabled = false;
      say($('where-status'), '');
    } catch (err) {
      fillSelect(select, [], 'Could not load channels');
      say($('where-status'), (err && err.message) || 'Could not load channels.', 'error');
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
        say($('where-status'), 'Choose a server first.', 'error');
        return false;
      }
      const guild = state.guilds.find((g) => g.id === guildId);
      const channelIds = chosenChannels();
      const names = state.channels
        .filter((c) => channelIds.indexOf(c.id) !== -1)
        .map((c) => `#${c.name}`);

      state.scope = {
        guildId,
        guildName: guild ? guild.name : 'Server',
        channelIds,
        channelNameFor: (id) => {
          const found = state.channels.find((c) => c.id === id);
          return found ? found.name : '';
        },
      };
      state.scopeLabel =
        (guild ? guild.name : 'Server') +
        (names.length ? ` / ${names.join(' ')}` : ' / all channels');
      return true;
    }

    const channelId = $('dm-select').value;
    if (!channelId) {
      say($('where-status'), 'Choose a conversation first.', 'error');
      return false;
    }
    const dm = state.dms.find((d) => d.id === channelId);
    state.scope = { channelId, channelName: dm ? dmLabel(dm) : 'Direct message', guildId: null };
    state.scopeLabel = dm ? dmLabel(dm) : 'Direct message';
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
    if (state.superseded) return;
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
      say($('filter-status'), 'That date range runs backwards.', 'error');
      return;
    }

    state.filters = filters;
    state.stopSearch = false;
    button.disabled = true;
    say($('filter-status'), '');
    show($('search-progress'));

    const bounds = CL.filter.toWindow(filters);

    try {
      const found = await finder.find({
        scope: state.scope,
        authorId: state.me.id,
        minId: bounds.minId,
        maxId: bounds.maxId,
        shouldStop: () => state.stopSearch,
        onProgress: (p) => {
          $('search-counter').textContent =
            p.phase === 'indexing'
              ? 'Discord is building the search index for this server. Waiting...'
              : `Found ${count(p.found, 'message')}${p.total ? ` of about ${p.total.toLocaleString()}` : ''}...`;
        },
      });

      state.results = CL.filter.apply(found.messages, filters);
      state.excluded = new Set();
      state.ran = false;
      state.truncated = !!found.truncated;
      renderReview();
      goTo('review');
    } catch (err) {
      say($('filter-status'), (err && err.message) || 'The search failed.', 'error');
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

  /** Rendering every row of a 50,000 message result set locks the tab. */
  const MAX_ROWS = 300;

  function renderReview() {
    const total = state.results.length;
    const picked = selected().length;

    $('review-heading').textContent = total
      ? picked === total
        ? `${count(total, 'message')} matched`
        : `${picked.toLocaleString()} of ${count(total, 'message')} selected`
      : 'Nothing matched';
    $('review-summary').textContent = total
      ? `${CL.filter.describe(state.filters)}, in ${state.scopeLabel}.`
      : `No messages of yours in ${state.scopeLabel} match ${CL.filter.describe(state.filters)}.`;

    const truncated = $('review-truncated');
    if (state.truncated) {
      truncated.textContent =
        'The search was stopped early, so this is part of the picture rather than all of it.';
      show(truncated);
    } else {
      hide(truncated);
    }

    const body = $('results-body');
    body.textContent = '';
    const rows = state.results.slice(0, MAX_ROWS);
    for (const message of rows) {
      const tr = document.createElement('tr');

      const pick = document.createElement('td');
      pick.className = 'pick';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = !state.excluded.has(message.id);
      box.setAttribute('aria-label', 'Include this message');
      box.addEventListener('change', () => {
        if (box.checked) state.excluded.delete(message.id);
        else state.excluded.add(message.id);
        tr.classList.toggle('off', !box.checked);
        refreshSelectionCounts();
      });
      pick.appendChild(box);
      tr.classList.toggle('off', state.excluded.has(message.id));

      const when = document.createElement('td');
      when.textContent = message.timestamp ? message.timestamp.slice(0, 16).replace('T', ' ') : '';

      const where = document.createElement('td');
      where.textContent = message.channelName ? `#${message.channelName}` : '';

      const what = document.createElement('td');
      what.className = 'msg';
      // textContent, never innerHTML. This is other people's text rendered in a
      // privileged extension page, and there is no version of this worth risking.
      what.textContent = message.content || (message.attachments.length ? '(attachment only)' : '(no text)');

      tr.append(pick, when, where, what);
      body.appendChild(tr);
    }

    refreshSelectionCounts();
  }

  /**
   * Update everything that depends on the selection without rebuilding the
   * table, which would lose scroll position on every tick of a checkbox.
   */
  function refreshSelectionCounts() {
    const total = state.results.length;
    const picked = selected().length;

    $('review-heading').textContent = total
      ? picked === total
        ? `${count(total, 'message')} matched`
        : `${picked.toLocaleString()} of ${count(total, 'message')} selected`
      : 'Nothing matched';

    $('pick-all').checked = picked > 0;
    $('pick-all').indeterminate = picked > 0 && picked < total;

    // Counted rather than asserted. The note used to say the rows past the
    // render limit "stay selected", which stopped being true the moment anyone
    // used the select-none box, and a note about a delete set has to be right.
    const beyond = Math.max(0, total - MAX_ROWS);
    const beyondPicked = beyond
      ? state.results.slice(MAX_ROWS).reduce((n, m) => n + (state.excluded.has(m.id) ? 0 : 1), 0)
      : 0;
    $('results-note').textContent = beyond
      ? `Showing the first ${MAX_ROWS.toLocaleString()}. Of the other ${beyond.toLocaleString()}, ` +
        `${beyondPicked.toLocaleString()} ${beyondPicked === 1 ? 'is' : 'are'} selected and counted above.`
      : '';

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
    const affected = action === 'edit' ? total : deletable;
    const writes = action === 'edit-then-delete' ? 2 : 1;
    const estimate = CL.job.estimateMs(affected, writes, null);

    const verb =
      action === 'delete'
        ? 'permanently delete'
        : action === 'edit'
          ? 'overwrite the text of'
          : 'overwrite and then permanently delete';

    const lines = [];
    const where = `${count(affected, 'message')} in ${state.scopeLabel}`;
    lines.push(
      CL.filter.isEmpty(state.filters)
        ? `You are about to ${verb} ${where}. That is everything you wrote there.`
        : `You are about to ${verb} ${where}, ${CL.filter.describe(state.filters)}.`
    );
    lines.push(`At the pace Clearline runs, that is ${humanDuration(estimate)}.`);
    if (action !== 'edit' && deletable < total) {
      lines.push(
        `${count(total - deletable, 'message')} cannot be deleted by anyone, ` +
          'because Discord does not allow it for join notices and similar. They are left alone.'
      );
    }
    if (action !== 'edit') lines.push('This cannot be undone.');

    const box = $('preflight');
    box.textContent = '';
    for (const line of lines) {
      const p = document.createElement('p');
      p.textContent = line;
      box.appendChild(p);
    }

    const needsTyping = affected > CONFIRM_ABOVE && action !== 'edit';
    $('confirm-field').classList.toggle('hidden', !needsTyping);
    $('confirm-label').textContent = `Type ${affected} to confirm`;
    $('confirm').value = '';

    // A finished run leaves the result set describing messages that mostly no
    // longer exist. Running it again would report every one of them as "already
    // gone, counts as done", which looks like success and means nothing.
    if (state.ran) {
      const stale = document.createElement('p');
      stale.textContent = 'These results are from a run that already happened. Search again to act on anything else.';
      box.appendChild(stale);
    }
    $('start').disabled = affected === 0 || state.ran || state.superseded;
  }

  function renderProgress(p) {
    const done = p.processed;
    const pct = p.total ? Math.round((done / p.total) * 100) : 0;
    $('run-fill').style.width = `${pct}%`;
    $('run-counter').textContent =
      `${done.toLocaleString()} of ${p.total.toLocaleString()} done` +
      (p.failed ? `, ${p.failed} failed` : '') +
      (p.skipped ? `, ${p.skipped} left alone` : '');
    $('run-eta').textContent =
      p.status === 'paused' ? 'Paused.' : p.etaMs ? `${humanDuration(p.etaMs)} to go.` : '';
  }

  function renderReport(summary) {
    const box = $('run-report');
    box.textContent = '';

    const headline = document.createElement('p');
    headline.className = 'headline';
    headline.textContent =
      summary.status === 'done'
        ? `Finished. ${count(summary.done, 'message')} handled.`
        : summary.status === 'cancelled'
          ? `Stopped. ${count(summary.done, 'message')} handled before you stopped it.`
          : `Stopped early. ${count(summary.done, 'message')} handled.`;
    box.appendChild(headline);

    if (summary.error) {
      const why = document.createElement('p');
      why.className = 'error';
      why.textContent = summary.error;
      box.appendChild(why);
    }

    for (const [label, list] of [
      ['left alone', summary.skips],
      ['failed', summary.failures],
    ]) {
      if (!list.length) continue;
      const details = document.createElement('details');
      const sum = document.createElement('summary');
      sum.textContent = `${count(list.length, 'message')} ${label}`;
      details.appendChild(sum);
      const ul = document.createElement('ul');
      for (const entry of list.slice(0, 50)) {
        const li = document.createElement('li');
        li.textContent = `${entry.message.id}: ${entry.reason}`;
        ul.appendChild(li);
      }
      details.appendChild(ul);
      box.appendChild(details);
    }

    if (summary.failures.length) {
      const retry = document.createElement('button');
      retry.className = 'ghost';
      retry.type = 'button';
      retry.textContent = `Try the ${summary.failures.length} failures again`;
      retry.addEventListener('click', () => {
        state.results = summary.failures.map((f) => f.message);
        state.excluded = new Set();
        state.ran = false;
        renderReview();
        hide(box);
        renderPreflight();
      });
      box.appendChild(retry);
    }

    show(box);
  }

  async function start() {
    // Both guards are belt and braces. Nothing yields between here and the
    // point the button is disabled, so neither should be reachable, but this is
    // the one function in the app that cannot be allowed to run twice.
    if (state.superseded || state.job) return;

    const action = chosenAction();
    const affected = action === 'edit' ? selected().length : deletableCount();

    if (affected > CONFIRM_ABOVE && action !== 'edit' && $('confirm').value.trim() !== String(affected)) {
      say($('run-status'), `Type ${affected} in the box to confirm.`, 'error');
      return;
    }

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
        say($('run-status'), 'Saving a copy first...');
        const meta = metaFor();
        const text = CL.exporter.toHTML(selected(), meta);
        // Built and checked before it is handed over, rather than trusting that
        // producing it worked. An empty file that looks like a backup is worse
        // than no backup, because it is the thing the user will reach for.
        if (!text || text.indexOf('</html>') === -1) {
          throw new Error('The copy came out incomplete.');
        }
        download(text, CL.exporter.filenameFor(meta, 'html'), 'text/html');
      } catch (err) {
        say($('run-status'), `Could not save the copy, so nothing was touched. ${err.message}`, 'error');
        return;
      }
    }

    state.job = runner;
    say($('run-status'), '');
    $('start').disabled = true;
    $('run-back').disabled = true;
    hide($('run-report'));
    show($('run-progress'));
    $('run-pause').textContent = 'Pause';

    const summary = await runner.start();

    hide($('run-progress'));
    $('run-back').disabled = false;
    state.job = null;
    state.ran = true;
    $('start').disabled = true;
    renderReport(summary);
  }

  /* ---------------------------------------------------------------- */
  /* Wiring                                                            */
  /* ---------------------------------------------------------------- */

  $('connect').addEventListener('click', () => connect(false));
  $('takeover').addEventListener('click', () => connect(true));

  for (const radio of document.querySelectorAll('input[name="scope-kind"]')) {
    radio.addEventListener('change', syncScopeKind);
  }
  $('guild-select').addEventListener('change', loadChannels);
  $('where-next').addEventListener('click', () => {
    if (!commitScope()) return;
    $('filter-scope-label').textContent = `Looking in ${state.scopeLabel}.`;
    goTo('filter');
  });

  $('filter-back').addEventListener('click', () => goTo('where'));
  $('search').addEventListener('click', runSearch);
  $('search-stop').addEventListener('click', () => {
    state.stopSearch = true;
    $('search-counter').textContent = 'Stopping after the request in flight...';
  });

  $('pick-all').addEventListener('change', () => {
    if ($('pick-all').checked) state.excluded = new Set();
    else state.excluded = new Set(state.results.map((m) => m.id));
    renderReview();
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
        say($('review-status'), 'Saved.');
      } catch (err) {
        say($('review-status'), (err && err.message) || 'Could not save that.', 'error');
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
      $('run-pause').textContent = 'Pause';
    } else {
      state.job.pause();
      $('run-pause').textContent = 'Resume';
    }
  });
  $('run-cancel').addEventListener('click', () => {
    if (state.job) state.job.cancel();
  });

  syncScopeKind();

  // Exposed for the end to end suite, which drives the real screens rather than
  // a reimplementation of them. Nothing in the app reads this.
  window.__clearline = { state, goTo, renderReview, renderPreflight };
})();
