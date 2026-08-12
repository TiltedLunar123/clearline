/**
 * End to end suite.
 *
 * Loads the real extension into a real browser and drives the real code paths.
 * It never touches a Discord account: the token comes from a fixture page that
 * hides localStorage the way Discord does, and the API is mocked at the network
 * layer through the CDP Fetch domain, so the actual client, the actual limiter
 * and the actual UI all run unmodified against scripted responses.
 *
 * What each group proves:
 *
 *   handoff   the load-bearing architectural claim, that an isolated-world
 *             content script still reads localStorage after the page removed it
 *             from its own window. Everything else is built on this being true.
 *   spine     connect through to rendered account data, across three contexts
 *             (content script, service worker, app tab) and two message hops.
 *   pacing    that requests really are spaced and serialised when driven through
 *             the app, not just when the limiter is unit tested in isolation.
 *   failures  401, 429 and a missing tab produce the behaviour the user is
 *             promised rather than a hang or a silent stall.
 *
 * Runs against Edge or Chromium. Branded Chrome ignores --load-extension, so
 * tools/cdp.mjs deliberately prefers Edge; see the comment there.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CDP, httpJson, launchWithExtension, mockApi, serveDir, shutdown, sleep, waitFor } from './cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9334;
const EXPECTED_TOKEN = 'e2e-token-2f8a91c4';

const results = [];
function check(group, label, pass, detail) {
  results.push({ group, label, pass, detail: pass ? '' : detail || '' });
}

/* ------------------------------------------------------------------ */
/* Test build                                                          */
/* ------------------------------------------------------------------ */

function deriveExtensionId(der) {
  const digest = crypto.createHash('sha256').update(der).digest();
  let id = '';
  for (let i = 0; i < 16; i++) {
    id += String.fromCharCode(97 + (digest[i] >> 4));
    id += String.fromCharCode(97 + (digest[i] & 0x0f));
  }
  return id;
}

/**
 * Copy the built Chrome extension, give it a fixed id, and point it at the
 * fixture origin as well as Discord.
 *
 * Only the manifest changes. Because background.main.js reads its match
 * patterns from the manifest rather than hardcoding them, redirecting the whole
 * extension at a local fixture takes no code change at all, which is what keeps
 * this suite honest: the JavaScript under test is byte for byte what ships.
 *
 * Match patterns carry no port, so http://127.0.0.1/* covers whatever port the
 * fixture server lands on.
 */
async function buildTestVariant() {
  const from = path.join(ROOT, 'dist', 'chrome');
  const to = path.join(ROOT, 'dist', 'e2e');
  await fs.rm(to, { recursive: true, force: true });
  await fs.cp(from, to, { recursive: true });

  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const der = publicKey.export({ type: 'spki', format: 'der' });

  const manifestPath = path.join(to, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.name = 'Clearline (E2E build - do not ship)';
  manifest.key = der.toString('base64');
  manifest.host_permissions = ['*://discord.com/*', 'http://127.0.0.1/*'];
  manifest.content_scripts[0].matches = ['http://127.0.0.1/*'];
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  return { dir: to, extensionId: deriveExtensionId(der) };
}

/* ------------------------------------------------------------------ */
/* Mock Discord                                                        */
/* ------------------------------------------------------------------ */

const ACCOUNT = { id: '111111111111111111', username: 'fixture', discriminator: '0' };

/**
 * Somebody else, for the reconnect check.
 *
 * A session expiring and somebody signing in as a different account are very
 * often the same event, so a reconnect has to establish who the token it just
 * read belongs to rather than assume it is still the account the tab connected
 * as.
 */
const OTHER_ACCOUNT = { id: '999999999999999999', username: 'somebody-else', discriminator: '0' };
// BigInt, because a snowflake is past Number.MAX_SAFE_INTEGER: `200000000000000000
// + i` rounds back to the same float for every i, so these fixtures were seven
// guilds and three conversations that all shared one id. Nothing asserted on the
// later ones, so it never showed, and a mock keyed on the second guild's id
// answered requests for the first.
const GUILDS = Array.from({ length: 7 }, (_, i) => ({
  id: String(200000000000000000n + BigInt(i)),
  name: `g${i}`,
}));
const DMS = Array.from({ length: 3 }, (_, i) => ({
  id: String(300000000000000000n + BigInt(i)),
  type: 1,
}));

/** Healthy rate limit headers, so the limiter has something real to absorb. */
const OK_HEADERS = {
  'X-RateLimit-Bucket': 'fixture-bucket',
  'X-RateLimit-Remaining': '4',
  'X-RateLimit-Reset-After': '1',
};

function happyPath() {
  return (method, pathname) => {
    if (pathname.startsWith('/api/v9/users/@me/guilds')) return { body: GUILDS, headers: OK_HEADERS };
    if (pathname.startsWith('/api/v9/users/@me/channels')) return { body: DMS, headers: OK_HEADERS };
    if (pathname.startsWith('/api/v9/users/@me')) return { body: ACCOUNT, headers: OK_HEADERS };
    return { status: 404, body: { message: 'unmocked ' + method + ' ' + pathname } };
  };
}

/* ------------------------------------------------------------------ */
/* Mock Discord: the operations path                                   */
/* ------------------------------------------------------------------ */

const OPS_GUILD = GUILDS[0].id;
const OPS_CHANNEL = '400000000000000001';

/** Discord's epoch, so the ids below decode to plausible dates. */
const DISCORD_EPOCH = 1420070400000;

function idFor(millis) {
  return String(BigInt(millis - DISCORD_EPOCH) << 22n);
}

/**
 * Six messages, newest first, one of which is a join notice.
 *
 * The join notice is the point: Discord attributes it to the user and returns
 * it in search results, but refuses to delete it. A tool that counts it in the
 * total promises more than it can deliver.
 */
function opsMessages() {
  const base = Date.UTC(2024, 2, 1, 12, 0, 0);
  return [
    { minute: 50, content: 'newest message', type: 0 },
    { minute: 40, content: 'has a link https://discord.com/channels/1', type: 0 },
    { minute: 30, content: 'joined the server', type: 7 },
    { minute: 20, content: 'ordinary chatter', type: 0 },
    { minute: 10, content: 'something with "quotes" and, a comma', type: 0 },
    { minute: 0, content: 'oldest message', type: 0 },
  ].map((m) => ({
    id: idFor(base + m.minute * 60000),
    channel_id: OPS_CHANNEL,
    author: ACCOUNT,
    timestamp: new Date(base + m.minute * 60000).toISOString(),
    content: m.content,
    attachments: [],
    embeds: [],
    pinned: false,
    type: m.type,
  }));
}

function operationsMock(deleted) {
  const messages = opsMessages();
  return (method, pathname) => {
    const path = pathname.split('?')[0];
    const params = new URLSearchParams(pathname.split('?')[1] || '');

    if (path === `/api/v9/guilds/${OPS_GUILD}/channels`) {
      return {
        body: [
          { id: OPS_CHANNEL, name: 'general', type: 0, position: 0 },
          { id: '400000000000000002', name: 'voice-room', type: 2, position: 1 },
        ],
        headers: OK_HEADERS,
      };
    }

    if (path === `/api/v9/guilds/${OPS_GUILD}/messages/search`) {
      const offset = Number(params.get('offset') || 0);
      const page = messages.slice(offset, offset + 25);
      return {
        body: { total_results: messages.length, messages: page.map((m) => [{ ...m, hit: true }]) },
        headers: OK_HEADERS,
      };
    }

    const del = path.match(/^\/api\/v9\/channels\/(\d+)\/messages\/(\d+)$/);
    if (del && method === 'DELETE') {
      deleted.push(del[2]);
      return { status: 204, body: null, headers: OK_HEADERS };
    }

    if (path.startsWith('/api/v9/users/@me/guilds')) return { body: GUILDS, headers: OK_HEADERS };
    if (path.startsWith('/api/v9/users/@me/channels')) return { body: DMS, headers: OK_HEADERS };
    if (path.startsWith('/api/v9/users/@me')) return { body: ACCOUNT, headers: OK_HEADERS };
    return { status: 404, body: { message: 'unmocked ' + method + ' ' + path } };
  };
}

/* ------------------------------------------------------------------ */

async function openTab(cdp, url) {
  const { targetId } = await cdp.send('Target.createTarget', { url });
  const session = await cdp.attach(targetId);
  await cdp.send('Page.enable', {}, session);
  return { targetId, session };
}

/**
 * Only one app tab may hold the queue, so the suite closes each one before
 * opening the next. Leaving them open would have every later phase testing the
 * "another tab already owns this" path by accident.
 */
async function closeTab(cdp, tab) {
  await cdp.send('Target.closeTarget', { targetId: tab.targetId }).catch(() => {});
  await sleep(200);
}

async function textOf(cdp, session, selector) {
  return cdp.evaluate(
    session,
    `(document.querySelector(${JSON.stringify(selector)}) || {}).textContent`
  );
}

/**
 * Whether a user could actually see and click this, not whether it exists.
 *
 * The distinction is load bearing here and used to hide a real bug. `textOf`
 * reads textContent, which an element inside a `display:none` ancestor still
 * has, and CDP's `.click()` fires on a hidden element quite happily. So the
 * stand-down notice and the reclaim button both passed their checks while
 * sitting inside a card that connect() had hidden for good: the notice was
 * unreadable and the only control that could undo a stand-down was unclickable.
 * offsetParent is null for anything display:none, itself or inherited.
 */
async function isVisible(cdp, session, selector) {
  return cdp.evaluate(
    session,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      return el.offsetParent !== null && !el.disabled;
    })()`
  );
}

async function main() {
  const { dir, extensionId } = await buildTestVariant();
  const { server, port: filePort } = await serveDir(path.join(ROOT, 'test-pages'));
  const fixtureUrl = `http://127.0.0.1:${filePort}/fake-discord.html`;
  const appUrl = `chrome-extension://${extensionId}/app/app.html`;

  let session;
  try {
    session = await launchWithExtension({ port: PORT, dir });
    const { webSocketDebuggerUrl } = await httpJson(PORT, '/json/version');
    const cdp = await CDP.connect(webSocketDebuggerUrl);

    // Attaching keeps the lazy service worker alive long enough to drive it.
    const swTarget = await waitFor('extension service worker', async () => {
      const targets = await httpJson(PORT, '/json/list');
      return targets.find((t) => t.type === 'service_worker' && t.url.includes(extensionId));
    });
    const sw = await cdp.attach(swTarget.id);
    await cdp.send('Runtime.enable', {}, sw);
    cdp.on('Runtime.exceptionThrown', (params, from) => {
      if (from !== sw) return;
      const details = params.exceptionDetails || {};
      console.error('  background threw:', details.exception?.description || details.text);
    });

    // The worker target exists from the moment it registers, which is before
    // background.js has finished running. Evaluating against it too early gets
    // "CL is not defined" and looks exactly like a real load failure.
    await waitFor('background script to finish evaluating', async () => {
      const ready = await cdp.evaluate(sw, "typeof CL === 'object' && !!CL.background");
      return ready === true;
    });

    /* ---------------- group: no tab ---------------- */

    // Runs first, while no fixture tab exists, so the "nothing open" branch is
    // exercised against a genuinely empty browser rather than a contrived one.
    const noTab = await cdp.evaluate(sw, 'CL.background.fetchToken()');
    check('failures', 'no Discord tab reports no-tab', noTab && noTab.ok === false && noTab.reason === 'no-tab',
      `got ${JSON.stringify(noTab)}`);

    /* ---------------- group: handoff ---------------- */

    const fixture = await openTab(cdp, fixtureUrl);
    await sleep(700);

    const fixtureState = await cdp.evaluate(fixture.session, 'window.__fixture');
    check('handoff', 'fixture really did hide localStorage from the page',
      !!fixtureState && fixtureState.pageCanRead === false,
      `fixture state ${JSON.stringify(fixtureState)}; if the page can still read, this suite proves nothing`);
    check('handoff', 'fixture applied both removal styles',
      !!fixtureState && fixtureState.removed === 'delete+redefine',
      `removed=${fixtureState && fixtureState.removed}`);

    const handoff = await cdp.evaluate(sw, 'CL.background.fetchToken()');
    check('handoff', 'isolated world still reads the token',
      !!handoff && handoff.ok === true && handoff.token === EXPECTED_TOKEN,
      `got ${JSON.stringify(handoff)}`);

    check('handoff', 'background reads match patterns from the manifest',
      Array.isArray(await cdp.evaluate(sw, 'CL.background.DISCORD_MATCHES')),
      'DISCORD_MATCHES missing');

    /* ---------------- group: spine ---------------- */

    const app = await openTab(cdp, appUrl);
    const calls = await mockApi(cdp, app.session, happyPath());
    await sleep(400);

    await cdp.evaluate(app.session, "document.getElementById('connect').click()");

    const account = await waitFor(
      'account to render',
      async () => {
        const value = await textOf(cdp, app.session, '#account');
        return value && value !== '-' ? value : null;
      },
      { timeout: 15000 }
    ).catch(async () => {
      const status = await textOf(cdp, app.session, '#status');
      return `<never rendered, status said: ${status}>`;
    });

    check('spine', 'connect renders the account name', account === 'fixture', `got ${JSON.stringify(account)}`);
    check('spine', 'server count renders', (await textOf(cdp, app.session, '#guild-count')) === '7');
    check('spine', 'DM count renders', (await textOf(cdp, app.session, '#dm-count')) === '3');

    const cardHidden = await cdp.evaluate(
      app.session,
      "document.getElementById('connect-card').classList.contains('hidden')"
    );
    check('spine', 'connect card gives way to the account card', cardHidden === true);

    // The toolbar path must reuse its tab. The naive tabs.query({url}) version
    // silently returns nothing without the "tabs" permission, so every click
    // would stack a duplicate, each believing it owns the running job. Driving
    // openApp twice is the only assertion that actually catches that.
    const firstId = await cdp.evaluate(sw, 'CL.background.openApp()');
    const secondId = await cdp.evaluate(sw, 'CL.background.openApp()');
    check('spine', 'toolbar reuses its app tab instead of stacking duplicates',
      typeof firstId === 'number' && firstId === secondId,
      `opened ${firstId} then ${secondId}`);

    const appTabCount = await cdp.evaluate(
      sw,
      "chrome.tabs.query({}).then(t => t.filter(x => (x.pendingUrl || x.url || '').includes('/app/app.html')).length)"
    );
    check('spine', 'only one app tab exists after two toolbar clicks', appTabCount <= 3,
      `found ${appTabCount} app tabs (the suite itself opens some directly)`);

    /* ---------------- group: pacing ---------------- */

    check('pacing', 'all three calls reached the API', calls.length === 3, `saw ${calls.length}: ${JSON.stringify(calls)}`);

    const paths = calls.map((c) => c.path);
    check('pacing', 'calls arrived in order and none were parallel',
      paths[0].includes('/users/@me') && paths.length === 3,
      JSON.stringify(paths));

    if (calls.length >= 2) {
      const gaps = calls.slice(1).map((c, i) => c.at - calls[i].at);
      const minGap = Math.min(...gaps);
      // The read floor is 250ms. Allowing a little slack for timer resolution,
      // anything under 200 means the limiter was bypassed somewhere.
      check('pacing', 'reads are spaced by the read floor', minGap >= 200,
        `smallest gap was ${minGap}ms, gaps ${JSON.stringify(gaps)}`);
    }

    /* ---------------- group: one tab ---------------- */

    // The pacing floor is enforced by a limiter, and a limiter lives in a page.
    // Two app tabs would be two queues, each spacing writes only against
    // itself, which doubles what Discord actually receives and quietly undoes
    // the single property this extension is built around.
    const second = await openTab(cdp, appUrl);
    await mockApi(cdp, second.session, happyPath());
    await sleep(300);
    await cdp.evaluate(second.session, "document.getElementById('connect').click()");
    await sleep(600);

    const blocked = await textOf(cdp, second.session, '#status');
    check('one tab', 'a second app tab refuses to run alongside the first',
      /already open in another tab/i.test(blocked || ''), `status said ${JSON.stringify(blocked)}`);

    // Reachability, not just the absence of a class. See isVisible.
    const takeoverOffered = await isVisible(cdp, second.session, '#takeover');
    check('one tab', 'taking over is offered rather than being a dead end', takeoverOffered === true);

    const stillBlank = await textOf(cdp, second.session, '#account');
    check('one tab', 'the blocked tab never loaded an account', stillBlank === '-',
      `account showed ${JSON.stringify(stillBlank)}`);

    // Taking over must stop the tab being replaced, or both queues keep running.
    await cdp.evaluate(second.session, "document.getElementById('takeover').click()");
    const supersededMsg = await waitFor(
      'the first tab to stand down',
      async () => {
        const value = await textOf(cdp, app.session, '#status');
        return value && /took over/i.test(value) ? value : null;
      },
      { timeout: 8000 }
    ).catch(() => '<never told>');
    check('one tab', 'taking over stops the tab it replaced',
      /took over/i.test(supersededMsg), `first tab said ${JSON.stringify(supersededMsg)}`);

    // The tab being stopped has already connected, so its connect card is gone.
    // Both of these used to live inside that card, which meant the notice was
    // written where nobody could read it and the one control wired to a path
    // that can undo a stand-down could not be clicked. A tab that has stopped
    // should say so, on screen, and offer the way back.
    check('one tab', 'a stopped tab shows its notice where it can actually be read',
      (await isVisible(cdp, app.session, '#status')) === true);
    check('one tab', 'a stopped tab still offers a reachable way to take the queue back',
      (await isVisible(cdp, app.session, '#takeover')) === true);

    // Disabling the buttons is not the same as stopping. The code that runs
    // afterwards used to turn them straight back on, so this drives the two
    // paths that did it and checks they no longer can.
    const stayedOff = await cdp.evaluate(
      app.session,
      `(() => {
        const cl = window.__clearline;
        cl.state.results = [{ id: '900000000000000001', channelId: '999999999999999999',
          type: 0, content: 'x', attachments: [], timestamp: '2024-03-01T12:00:00.000Z' }];
        cl.renderPreflight();
        return JSON.stringify({
          start: document.getElementById('start').disabled,
          search: document.getElementById('search').disabled,
          stopSearch: cl.state.stopSearch,
          superseded: cl.state.superseded,
        });
      })()`
    );
    const flags = stayedOff ? JSON.parse(stayedOff) : {};
    check('one tab', 'a superseded tab cannot be re-armed by redrawing the pre-flight',
      flags.start === true, `flags were ${stayedOff}`);
    check('one tab', 'a superseded tab stops a search that was already paging',
      flags.stopSearch === true && flags.superseded === true, `flags were ${stayedOff}`);

    await closeTab(cdp, second);
    await closeTab(cdp, app);

    // Standing down has to reach a connect that is already in flight, not just
    // one that has not started. Connect is the only path to the network that
    // runs before there is anything on screen to disable, so if it finishes
    // after the takeover it walks the tab forward: it blanks the notice saying
    // another tab took over, hands the button back, and shows the account as
    // though nothing happened. What the user gets is a tab that looks connected
    // and then silently ignores every click, because the flag is still set.
    const slow = await openTab(cdp, appUrl);
    await mockApi(cdp, slow.session, (method, pathname) => {
      // The third and last call of connect. Holding it open puts the takeover
      // squarely inside the window where connect is waiting on Discord.
      if (pathname.startsWith('/api/v9/users/@me/channels')) {
        return { body: DMS, headers: OK_HEADERS, delayMs: 3000 };
      }
      if (pathname.startsWith('/api/v9/users/@me/guilds')) return { body: GUILDS, headers: OK_HEADERS };
      if (pathname.startsWith('/api/v9/users/@me')) return { body: ACCOUNT, headers: OK_HEADERS };
      return { status: 404, body: { message: 'unmocked ' + method + ' ' + pathname } };
    });
    await sleep(300);
    await cdp.evaluate(slow.session, "document.getElementById('connect').click()");
    // Long enough to be past the account and guild calls and sitting in the
    // held-open one, short enough that it has not returned.
    await sleep(1200);

    const usurper = await openTab(cdp, appUrl);
    await mockApi(cdp, usurper.session, happyPath());
    await sleep(300);
    await cdp.evaluate(usurper.session, "document.getElementById('connect').click()");
    await sleep(600);
    await cdp.evaluate(usurper.session, "document.getElementById('takeover').click()");

    // Past the held response, so the in-flight connect has finished its tail.
    await sleep(3200);

    const afterRace = await cdp.evaluate(
      slow.session,
      `JSON.stringify({
        status: document.getElementById('status').textContent,
        connectEnabled: document.getElementById('connect').disabled === false,
        onWhere: !document.getElementById('step-where').classList.contains('hidden'),
        superseded: window.__clearline.state.superseded,
      })`
    );
    const race = afterRace ? JSON.parse(afterRace) : {};

    check('one tab', 'a takeover during connect still stops the tab',
      /took over/i.test(race.status || ''), `status said ${JSON.stringify(race.status)}`);
    check('one tab', 'a connect finishing after a takeover does not re-arm the button',
      race.connectEnabled === false, `state was ${afterRace}`);
    check('one tab', 'a connect finishing after a takeover does not walk the tab forward',
      race.onWhere === false, `state was ${afterRace}`);

    await closeTab(cdp, usurper);
    await closeTab(cdp, slow);

    // Taking the queue back has to un-stand-down the tab, or reclaiming leaves
    // it owning the queue while every action still refuses to run. The flag was
    // write-once, so this was a tab that reconnected, showed the account, and
    // then sat on "Loading channels..." for ever.
    const reclaimer = await openTab(cdp, appUrl);
    await mockApi(cdp, reclaimer.session, happyPath());
    await sleep(300);
    await cdp.evaluate(reclaimer.session, "document.getElementById('connect').click()");
    await sleep(1500);

    const rival = await openTab(cdp, appUrl);
    await mockApi(cdp, rival.session, happyPath());
    await sleep(300);
    await cdp.evaluate(rival.session, "document.getElementById('connect').click()");
    await sleep(600);
    await cdp.evaluate(rival.session, "document.getElementById('takeover').click()");
    await sleep(800);
    await closeTab(cdp, rival);

    // The first tab takes the queue back, which is a deliberate click and the
    // documented way out of "another tab has it". Checked as reachable before
    // it is clicked, because a programmatic click works on a hidden button and
    // that is exactly how this path stayed green while being impossible.
    check('one tab', 'the reclaim control is reachable before it is clicked',
      (await isVisible(cdp, reclaimer.session, '#takeover')) === true);
    await cdp.evaluate(reclaimer.session, "document.getElementById('takeover').click()");
    await sleep(2000);

    const reclaimed = await cdp.evaluate(
      reclaimer.session,
      `JSON.stringify({
        superseded: window.__clearline.state.superseded,
        searchEnabled: document.getElementById('search').disabled === false,
      })`
    );
    const back = reclaimed ? JSON.parse(reclaimed) : {};
    check('one tab', 'taking the queue back brings the tab fully out of stand-down',
      back.superseded === false, `state was ${reclaimed}`);
    check('one tab', 'a reclaimed tab can search again', back.searchEnabled === true,
      `state was ${reclaimed}`);

    await closeTab(cdp, reclaimer);

    /* ---------------- group: failures ---------------- */

    // 401: the client must drop the token and say so rather than looping.
    const app401 = await openTab(cdp, appUrl);
    await mockApi(cdp, app401.session, (method, pathname) => {
      if (pathname.startsWith('/api/v9/users/@me')) return { status: 401, body: { message: '401: Unauthorized' } };
      return { status: 404, body: {} };
    });
    await sleep(300);
    await cdp.evaluate(app401.session, "document.getElementById('connect').click()");
    const status401 = await waitFor(
      'a 401 message',
      async () => {
        const value = await textOf(cdp, app401.session, '#status');
        return value && /reconnect/i.test(value) ? value : null;
      },
      { timeout: 10000 }
    ).catch(() => '<no message>');
    check('failures', '401 tells the user to reconnect', /reconnect/i.test(status401), `status said ${JSON.stringify(status401)}`);

    await closeTab(cdp, app401);

    // A reconnect must establish whose token it just installed.
    //
    // The whole "your own messages only" guarantee is pinned to the account id
    // captured at connect: it is the author filter the search sends, the check
    // on Discord's answer, and the last guard in front of the delete call. A
    // reconnect that installs a credential belonging to somebody else leaves
    // all three comparing against an id the token no longer matches, so they
    // agree and the requests go out as the other account. The realistic way in
    // is the ordinary one: the session expired because somebody signed in
    // again, as an alt or as the next person at the machine.
    const appSwap = await openTab(cdp, appUrl);
    let whoami = ACCOUNT;
    await mockApi(cdp, appSwap.session, (method, pathname) => {
      // Expiring the channel list is what drops the token and puts Reconnect on
      // screen, which is how a real user reaches this button at all.
      if (/^\/api\/v9\/guilds\/\d+\/channels/.test(pathname)) {
        return { status: 401, body: { message: '401: Unauthorized' } };
      }
      if (pathname.startsWith('/api/v9/users/@me/guilds')) return { body: GUILDS, headers: OK_HEADERS };
      if (pathname.startsWith('/api/v9/users/@me/channels')) return { body: DMS, headers: OK_HEADERS };
      if (pathname.startsWith('/api/v9/users/@me')) return { body: whoami, headers: OK_HEADERS };
      return { status: 404, body: {} };
    });
    await sleep(300);
    await cdp.evaluate(appSwap.session, "document.getElementById('connect').click()");
    await waitFor('the where step before the swap', async () =>
      (await cdp.evaluate(appSwap.session, "!document.getElementById('step-where').classList.contains('hidden')")) === true
    ).catch(() => null);

    await cdp.evaluate(
      appSwap.session,
      `(() => {
        const s = document.getElementById('guild-select');
        s.value = ${JSON.stringify(GUILDS[0].id)};
        s.dispatchEvent(new Event('change'));
      })()`
    );
    const reconnectOffered = await waitFor(
      'the reconnect button after a 401',
      async () => ((await isVisible(cdp, appSwap.session, '#reconnect')) === true ? true : null),
      { timeout: 10000 }
    ).catch(() => false);
    check('failures', 'a dropped session puts Reconnect where it can be clicked', reconnectOffered === true);

    // Somebody signs discord.com back in as a different account.
    whoami = OTHER_ACCOUNT;
    await cdp.evaluate(appSwap.session, "document.getElementById('reconnect').click()");
    const swapStatus = await waitFor(
      'a verdict on the reconnect',
      async () => {
        const value = await textOf(cdp, appSwap.session, '#status');
        return value && !/again\.\.\.$/.test(value) ? value : null;
      },
      { timeout: 15000 }
    ).catch(() => '<no message>');

    check('failures', 'a reconnect refuses a token belonging to a different account',
      /different account/i.test(swapStatus || ''),
      `status said ${JSON.stringify(swapStatus)}, so the tab accepted somebody else's credential`);

    const swapState = JSON.parse(
      await cdp.evaluate(
        appSwap.session,
        `JSON.stringify({
          me: window.__clearline.state.me && window.__clearline.state.me.id,
          shown: document.getElementById('account').textContent,
          stillOffered: document.getElementById('reconnect').offsetParent !== null,
        })`
      )
    );
    check('failures', 'a refused reconnect leaves the pinned account alone',
      swapState.me === ACCOUNT.id && swapState.shown === ACCOUNT.username,
      `state.me was ${JSON.stringify(swapState.me)} and the panel showed ${JSON.stringify(swapState.shown)}`);
    check('failures', 'a refused reconnect leaves the way back on screen',
      swapState.stillOffered === true,
      'the tab has no token and no Reconnect button, which is a dead end');

    await closeTab(cdp, appSwap);

    // 429: the client must back off and then succeed, without the user seeing
    // an error. This is the path that protects the account.
    const app429 = await openTab(cdp, appUrl);
    let meHits = 0;
    const calls429 = await mockApi(cdp, app429.session, (method, pathname) => {
      if (pathname.startsWith('/api/v9/users/@me/guilds')) return { body: GUILDS, headers: OK_HEADERS };
      if (pathname.startsWith('/api/v9/users/@me/channels')) return { body: DMS, headers: OK_HEADERS };
      if (pathname.startsWith('/api/v9/users/@me')) {
        meHits++;
        if (meHits === 1) {
          return { status: 429, headers: { 'Retry-After': '1' }, body: { message: 'You are being rate limited.', retry_after: 1, global: false } };
        }
        return { body: ACCOUNT, headers: OK_HEADERS };
      }
      return { status: 404, body: {} };
    });
    await sleep(300);
    const before429 = Date.now();
    await cdp.evaluate(app429.session, "document.getElementById('connect').click()");
    const account429 = await waitFor(
      'account after a 429',
      async () => {
        const value = await textOf(cdp, app429.session, '#account');
        return value && value !== '-' ? value : null;
      },
      { timeout: 20000 }
    ).catch(async () => `<never rendered: ${await textOf(cdp, app429.session, '#status')}>`);

    check('failures', '429 is retried and the flow still completes', account429 === 'fixture', `got ${JSON.stringify(account429)}`);
    check('failures', '429 actually waited out retry_after', Date.now() - before429 >= 1000,
      `completed in ${Date.now() - before429}ms, which is faster than the 1s Discord asked for`);
    check('failures', '429 retried rather than giving up', meHits >= 2, `/users/@me was hit ${meHits} times`);

    // The token must never be written to storage. Both areas, because the only
    // one the extension actually writes is `session` (it remembers the app tab
    // id there), so checking `local` alone asserted that an area nothing touches
    // stays empty: true no matter what the code did, including if it had started
    // writing the token to session the line before.
    const stored = await cdp.evaluate(
      sw,
      `Promise.all([
        chrome.storage.local.get(null),
        chrome.storage.session.get(null),
      ]).then(([local, session]) => JSON.stringify({ local, session }))`
    );
    check('failures', 'token is never written to extension storage',
      !String(stored).includes(EXPECTED_TOKEN), `storage contained ${stored}`);
    check('failures', 'the storage check is looking at an area that is actually written',
      /appTabId/.test(String(stored)), `storage was ${stored}, so the assertion above proves nothing`);

    /* ---------------- group: operations ---------------- */

    // The whole product path in one tab: connect, pick a server, search, look
    // at what matched, then actually delete it against a mocked Discord. The
    // point of driving it here rather than in unit tests is that the pacing and
    // the guards are properties of the assembled thing, not of any one module.
    await closeTab(cdp, app429);

    const deleted = [];
    const ops = await openTab(cdp, appUrl);
    const opsCalls = await mockApi(cdp, ops.session, operationsMock(deleted));
    await sleep(400);

    await cdp.evaluate(ops.session, "document.getElementById('connect').click()");
    await waitFor('the where step', async () =>
      (await cdp.evaluate(ops.session, "!document.getElementById('step-where').classList.contains('hidden')")) === true
    ).catch(() => null);

    await cdp.evaluate(
      ops.session,
      `(() => {
        const s = document.getElementById('guild-select');
        s.value = ${JSON.stringify(OPS_GUILD)};
        s.dispatchEvent(new Event('change'));
      })()`
    );

    const channelsLoaded = await waitFor(
      'channels to load',
      async () => {
        const labels = await cdp.evaluate(
          ops.session,
          "Array.from(document.getElementById('channel-select').options).map(o => o.textContent).join(',')"
        );
        return labels && labels.includes('#general') ? labels : null;
      },
      { timeout: 10000 }
    ).catch(() => '<never loaded>');

    // The one outbound link. The build gate checks the source; this checks what
    // the browser actually resolved, which is what a user would click.
    const link = await cdp.evaluate(
      ops.session,
      `(() => {
        const a = document.querySelector('.foot a');
        if (!a) return null;
        return JSON.stringify({ href: a.href, target: a.target, rel: a.rel });
      })()`
    );
    const parsed = link ? JSON.parse(link) : null;
    check('operations', 'the support link is isolated from the extension page',
      !!parsed && parsed.target === '_blank' && /noopener/.test(parsed.rel) && /noreferrer/.test(parsed.rel),
      `link resolved to ${link}`);
    check('operations', 'the support link points where it should',
      !!parsed && parsed.href.indexOf('buymeacoffee.com/judeh1l') !== -1, `link resolved to ${link}`);

    check('operations', 'picking a server loads its text channels', channelsLoaded === '#general',
      `channel list was ${JSON.stringify(channelsLoaded)}; a voice channel holds no messages and must not be offered`);

    await cdp.evaluate(ops.session, "document.getElementById('where-next').click()");
    await sleep(200);
    await cdp.evaluate(ops.session, "document.getElementById('search').click()");

    const heading = await waitFor(
      'the review step',
      async () => {
        const value = await textOf(cdp, ops.session, '#review-heading');
        return value && /matched/.test(value) ? value : null;
      },
      { timeout: 20000 }
    ).catch(async () => `<never got there: ${await textOf(cdp, ops.session, '#filter-status')}>`);

    check('operations', 'a search reports what it matched', /6 messages matched/.test(heading),
      `heading said ${JSON.stringify(heading)}`);

    const rows = await cdp.evaluate(ops.session, "document.querySelectorAll('#results-body tr').length");
    check('operations', 'every match is listed for review before anything is destroyed', rows === 6,
      `rendered ${rows} rows`);

    // Unticking a message has to take it out of the run, not just grey it out.
    // A selection that lies is worse than no selection at all.
    await cdp.evaluate(
      ops.session,
      "document.querySelectorAll('#results-body input[type=checkbox]')[0].click()"
    );
    await sleep(150);
    const afterDrop = await textOf(cdp, ops.session, '#review-heading');
    check('operations', 'unticking a message takes it out of the count',
      /5 of 6 messages selected/.test(afterDrop || ''), `heading said ${JSON.stringify(afterDrop)}`);

    await cdp.evaluate(ops.session, "document.getElementById('review-next').click()");
    await sleep(200);
    const sparedPreflight = await textOf(cdp, ops.session, '#preflight');
    check('operations', 'a spared message is left out of the pre-flight count',
      /permanently delete 4 messages/.test(sparedPreflight || ''),
      `pre-flight said ${JSON.stringify(sparedPreflight)}`);

    // Put it back, so the run below is over the full six again.
    await cdp.evaluate(ops.session, "document.getElementById('run-back').click()");
    await sleep(150);
    await cdp.evaluate(
      ops.session,
      "document.querySelectorAll('#results-body input[type=checkbox]')[0].click()"
    );
    await sleep(150);

    await cdp.evaluate(ops.session, "document.getElementById('review-next').click()");
    await sleep(200);

    const preflight = await textOf(cdp, ops.session, '#preflight');
    check('operations', 'the pre-flight counts only what can actually be deleted',
      /permanently delete 5 messages/.test(preflight || ''),
      `pre-flight said ${JSON.stringify(preflight)}`);
    check('operations', 'the pre-flight says the join notice is left alone',
      /1 message cannot be deleted/.test(preflight || ''), `pre-flight said ${JSON.stringify(preflight)}`);
    check('operations', 'the pre-flight says it cannot be undone',
      /cannot be undone/.test(preflight || ''), `pre-flight said ${JSON.stringify(preflight)}`);

    // Overwriting refuses the same message types deleting does, so it has to
    // count them the same way. It used to promise all six and then spend a
    // paced write finding out Discord would not change the join notice.
    await cdp.evaluate(
      ops.session,
      "document.querySelector('input[name=action][value=edit]').click()"
    );
    await sleep(200);
    const editPreflight = await textOf(cdp, ops.session, '#preflight');
    check('operations', 'overwriting counts only what can actually be changed',
      /overwrite the text of 5 messages/i.test(editPreflight || ''),
      `pre-flight said ${JSON.stringify(editPreflight)}`);
    check('operations', 'overwriting says the join notice is left alone too',
      /1 message cannot be changed/.test(editPreflight || ''),
      `pre-flight said ${JSON.stringify(editPreflight)}`);
    await cdp.evaluate(
      ops.session,
      "document.querySelector('input[name=action][value=delete]').click()"
    );
    await sleep(200);

    // A big run must refuse to start until the count is typed back. Driven by
    // swapping in a fabricated result set rather than mocking 150 real deletes,
    // with the genuine one stashed so the run below is still the real thing.
    await cdp.evaluate(
      ops.session,
      `(() => {
        const cl = window.__clearline;
        cl.stashed = cl.state.results;
        cl.state.results = Array.from({length: 150}, (_, i) => ({
          // BigInt for the same reason the guild fixtures use it: these ids are
          // past Number.MAX_SAFE_INTEGER, so plain addition made all 150 the
          // same snowflake. And an author, because the job refuses anything it
          // cannot confirm the account wrote, which is correct and meant this
          // fabricated set could never actually run.
          id: String(900000000000000000n + BigInt(i)),
          channelId: ${JSON.stringify(OPS_CHANNEL)},
          authorId: ${JSON.stringify(ACCOUNT.id)},
          type: 0, content: 'x', attachments: [], timestamp: '2024-03-01T12:00:00.000Z'
        }));
        cl.renderPreflight();
      })()`
    );
    const confirmShown = await cdp.evaluate(
      ops.session,
      "!document.getElementById('confirm-field').classList.contains('hidden')"
    );
    check('operations', 'a large run asks for the count to be typed back', confirmShown === true);

    await cdp.evaluate(ops.session, "document.getElementById('start').click()");
    await sleep(400);
    const refused = await textOf(cdp, ops.session, '#run-status');
    check('operations', 'a large run refuses to start until it is confirmed',
      /type 150/i.test(refused || '') && deleted.length === 0,
      `status said ${JSON.stringify(refused)}, ${deleted.length} deletes had already fired`);

    // And then accepts the number it just asked for.
    //
    // Only the refusal was ever driven, so the comparison behind it was free to
    // be wrong in the other direction and no gate would notice: changing it to
    // String(affected + 1) made every run over a hundred messages impossible to
    // start and left the whole suite green. That is the product's main path.
    // The count is typed exactly as the label prints it, separators and all,
    // because the label is grouped by locale and the box is not.
    const typedBack = await cdp.evaluate(
      ops.session,
      `(() => {
        const label = document.getElementById('confirm-label').textContent;
        const shown = (label.match(/[0-9][0-9.,\\u00a0\\u202f ]*/) || [''])[0].trim();
        const box = document.getElementById('confirm');
        box.value = shown;
        return shown;
      })()`
    );
    await cdp.evaluate(ops.session, "document.getElementById('backup').checked = false");
    await cdp.evaluate(ops.session, "document.getElementById('start').click()");
    // Waiting on a real delete reaching the mock, not on the counter: the
    // counter is painted once before the first request goes out, so it would
    // read "0 of 150" whether the run started or was refused.
    const acceptedRun = await waitFor(
      'the confirmed run to reach the API',
      async () => (deleted.length > 0 ? true : null),
      { timeout: 20000 }
    ).catch(() => false);
    check('operations', 'typing the count back is what lets a large run start',
      acceptedRun === true,
      `typed ${JSON.stringify(typedBack)}, run status said ${JSON.stringify(await textOf(cdp, ops.session, '#run-status'))}`);

    // Stop it again: this fabricated set is not the run this suite measures.
    await cdp.evaluate(ops.session, "document.getElementById('run-cancel').click()");
    await waitFor(
      'the cancelled run to report',
      async () =>
        (await cdp.evaluate(
          ops.session,
          "document.getElementById('run-report').classList.contains('hidden')"
        )) === false
          ? true
          : null,
      { timeout: 20000 }
    ).catch(() => null);
    deleted.length = 0;

    // Back to the real six, and actually run it.
    await cdp.evaluate(
      ops.session,
      `(() => {
        const cl = window.__clearline;
        cl.state.results = cl.stashed;
        // The fabricated run above set this, and it is what keeps Start
        // disabled after a run so a stale result set cannot be run twice.
        cl.state.ran = false;
        cl.renderReview();
        cl.renderPreflight();
        return cl.state.results.length;
      })()`
    );
    // The automatic backup would open a save dialog and stall the run.
    await cdp.evaluate(ops.session, "document.getElementById('backup').checked = false");
    const startedAt = Date.now();
    await cdp.evaluate(ops.session, "document.getElementById('start').click()");

    const report = await waitFor(
      'the run to finish',
      async () => {
        const hidden = await cdp.evaluate(
          ops.session,
          "document.getElementById('run-report').classList.contains('hidden')"
        );
        return hidden === false ? await textOf(cdp, ops.session, '#run-report') : null;
      },
      { timeout: 60000 }
    ).catch(async () => `<never finished: ${await textOf(cdp, ops.session, '#run-counter')}>`);

    check('operations', 'the run deletes exactly the messages it promised', deleted.length === 5,
      `deleted ${deleted.length}: ${JSON.stringify(deleted)}`);
    check('operations', 'the join notice was never even attempted',
      !deleted.includes(idFor(Date.UTC(2024, 2, 1, 12, 30, 0))),
      'a message Discord refuses to delete was sent to the API anyway');
    check('operations', 'the run reports finishing', /Finished\. 5 messages handled/.test(report || ''),
      `report said ${JSON.stringify(report)}`);

    check('operations', 'deletes went oldest first',
      deleted.length === 5 && BigInt(deleted[0]) < BigInt(deleted[4]),
      `order was ${JSON.stringify(deleted)}`);

    const writes = opsCalls.filter((c) => c.method === 'DELETE');
    if (writes.length >= 2) {
      const gaps = writes.slice(1).map((c, i) => c.at - writes[i].at);
      const smallest = Math.min(...gaps);
      // The write floor is 900ms. This is the assertion that matters most in
      // the whole suite: it is the difference between a tool people keep their
      // account through and one that gets them rate limited into an IP block.
      check('operations', 'deletes are spaced by the write floor', smallest >= 850,
        `smallest gap between deletes was ${smallest}ms, gaps ${JSON.stringify(gaps)}`);
    } else {
      check('operations', 'deletes are spaced by the write floor', false, 'not enough deletes to measure');
    }

    check('operations', 'the run took at least as long as the pacing requires',
      Date.now() - startedAt >= 4 * 900,
      `finished in ${Date.now() - startedAt}ms, which is faster than five paced writes can be`);

    await closeTab(cdp, ops);

    /* ---------------- group: scope ---------------- */

    // A search that outlives the choice that started it.
    //
    // Nothing disables Back while a search pages, and a server-wide search can
    // page for minutes, so the picker is free to move underneath a running
    // search. Everything the review and run screens say about the results has
    // to describe the search that produced them. It used to be read back off
    // live state at render time, which meant a set of server A's messages could
    // be presented, counted and confirmed as server B, with the channel column
    // blank because the name lookup had been replaced too. The sentence above
    // the Start button is the last thing between a person and an irreversible
    // delete, so it naming the wrong server is the worst failure this app has.
    const OTHER_GUILD = GUILDS[1].id;
    const scopeTab = await openTab(cdp, appUrl);
    const scopeDeleted = [];
    const opsResolve = operationsMock(scopeDeleted);
    await mockApi(cdp, scopeTab.session, (method, pathname) => {
      const path = pathname.split('?')[0];
      if (path === `/api/v9/guilds/${OTHER_GUILD}/channels`) {
        return {
          body: [{ id: '400000000000000009', name: 'other-room', type: 0, position: 0 }],
          headers: OK_HEADERS,
        };
      }
      // Slow enough that the swap below lands while the search is still in
      // flight, which is the whole point of the check.
      if (path === `/api/v9/guilds/${OPS_GUILD}/messages/search`) {
        return { ...opsResolve(method, pathname), delayMs: 4000 };
      }
      return opsResolve(method, pathname);
    });
    await sleep(400);

    await cdp.evaluate(scopeTab.session, "document.getElementById('connect').click()");
    await waitFor('the where step', async () =>
      (await cdp.evaluate(scopeTab.session, "!document.getElementById('step-where').classList.contains('hidden')")) === true
    ).catch(() => null);

    const pickGuild = (id) =>
      cdp.evaluate(
        scopeTab.session,
        `(() => {
          const s = document.getElementById('guild-select');
          s.value = ${JSON.stringify(id)};
          s.dispatchEvent(new Event('change'));
        })()`
      );
    const waitForChannel = (label) =>
      waitFor(
        `channels containing ${label}`,
        async () => {
          const labels = await cdp.evaluate(
            scopeTab.session,
            "Array.from(document.getElementById('channel-select').options).map(o => o.textContent).join(',')"
          );
          return labels && labels.includes(label) ? labels : null;
        },
        { timeout: 10000 }
      ).catch(() => '<never loaded>');

    await pickGuild(OPS_GUILD);
    await waitForChannel('#general');
    await cdp.evaluate(scopeTab.session, "document.getElementById('where-next').click()");
    await sleep(200);

    // The scope carries its own copy of the channel names, taken when it was
    // committed. Checked here, before anything has had a chance to move, so a
    // failure further down cannot be blamed on the swap.
    const committedName = await cdp.evaluate(
      scopeTab.session,
      `JSON.stringify({
        name: window.__clearline.state.scope.channelNameFor(${JSON.stringify(OPS_CHANNEL)}),
        voice: window.__clearline.state.scope.channelNameFor('400000000000000002'),
        offered: Array.from(document.getElementById('channel-select').options).map((o) => o.textContent),
      })`
    );
    check('scope', 'a committed scope carries the channel names it was built from',
      JSON.parse(committedName).name === 'general', `scope reported ${committedName}`);

    // A whole-server search returns what the account wrote in places the picker
    // has no business offering as somewhere to search: the text chat inside a
    // voice channel, a stage, a thread under a media channel. Those rows still
    // have to be able to say where they came from.
    check('scope', 'a channel the picker does not offer can still be named',
      JSON.parse(committedName).voice === 'voice-room' &&
        !JSON.parse(committedName).offered.some((o) => o.includes('voice-room')),
      `scope reported ${committedName}`);

    await cdp.evaluate(scopeTab.session, "document.getElementById('search').click()");
    await sleep(600);

    // Change your mind while it is still paging.
    //
    // The swap is applied to state directly rather than by driving the picker,
    // and only because driving it is not deterministic here: everything shares
    // one limiter queue, so a real second channel load sits behind the search
    // request this check deliberately made slow, and it lands on the far side
    // of the thing under test. These two writes are exactly what loadChannels
    // and commitScope perform, so the hazard reproduced is the real one; only
    // the timing is made reliable.
    await cdp.evaluate(scopeTab.session, "document.getElementById('filter-back').click()");
    await sleep(150);
    await cdp.evaluate(
      scopeTab.session,
      `(() => {
        const cl = window.__clearline;
        cl.state.channels = [{ id: '400000000000000009', name: 'other-room', type: 0, position: 0 }];
        cl.state.channelsFor = ${JSON.stringify(OTHER_GUILD)};
        cl.state.scopeLabel = 'g1 / all channels';
      })()`
    );

    const scopeHeading = await waitFor(
      'the review step after the swap',
      async () => {
        const value = await textOf(cdp, scopeTab.session, '#review-heading');
        return value && /matched/.test(value) ? value : null;
      },
      { timeout: 30000 }
    ).catch(async () => `<never got there: ${await textOf(cdp, scopeTab.session, '#filter-status')}>`);
    check('scope', 'a search still lands after the picker moved', /6 messages matched/.test(scopeHeading),
      `heading said ${JSON.stringify(scopeHeading)}`);

    const scopeSummary = await textOf(cdp, scopeTab.session, '#review-summary');
    check('scope', 'the review names the server that was actually searched',
      /\bg0\b/.test(scopeSummary || '') && !/\bg1\b/.test(scopeSummary || ''),
      `summary said ${JSON.stringify(scopeSummary)}`);

    const channelCells = JSON.parse(
      await cdp.evaluate(
        scopeTab.session,
        "JSON.stringify(Array.from(document.querySelectorAll('#results-body tr')).map(r => r.children[2].textContent))"
      )
    );
    check('scope', 'every row still knows which channel it came from',
      channelCells.length === 6 && channelCells.every((c) => c === '#general'),
      `channel column was ${JSON.stringify(channelCells)}`);

    await cdp.evaluate(scopeTab.session, "document.getElementById('review-next').click()");
    await sleep(250);
    const scopePreflight = await textOf(cdp, scopeTab.session, '#preflight');
    check('scope', 'the sentence above Start names the server that was actually searched',
      /\bg0\b/.test(scopePreflight || '') && !/\bg1\b/.test(scopePreflight || ''),
      `pre-flight said ${JSON.stringify(scopePreflight)}`);

    await closeTab(cdp, scopeTab);
  } finally {
    server.close();
    await shutdown(session);
  }

  report();
}

function report() {
  const groups = [...new Set(results.map((r) => r.group))];
  let failed = 0;
  for (const group of groups) {
    const rows = results.filter((r) => r.group === group);
    const bad = rows.filter((r) => !r.pass);
    failed += bad.length;
    console.log(`\n${group}  ${rows.length - bad.length}/${rows.length}`);
    for (const row of rows) {
      console.log(`  ${row.pass ? 'ok  ' : 'FAIL'} ${row.label}${row.detail ? '  <- ' + row.detail : ''}`);
    }
  }
  if (failed) {
    console.error(`\n${failed} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll end to end checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
