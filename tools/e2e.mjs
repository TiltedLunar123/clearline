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

import { buildOnly } from './build.mjs';
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
  /*
   * Built here rather than assumed to be current.
   *
   * This copies dist/chrome and drives whatever is in it, and nothing in this
   * file put it there. `npm run all` builds first so the release gate was
   * honest, but running the suite on its own drove the previous build of every
   * file changed since: a mutation planted in src to prove a check could fail
   * came back green, because the browser never saw it. A suite reporting on
   * bytes nobody asked it to read is worse than no suite, and the build is
   * under a second.
   */
  await buildOnly();
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
 * Seven messages, newest first, two of which are system notices.
 *
 * The two notices are the point, and they are deliberately different from each
 * other, because Discord answers the two actions differently and one predicate
 * for both is what left messages behind.
 *
 *   join notice (7)  Attributed to the user, returned by an author-filtered
 *                    search, and deletable by them: it is a trace of their
 *                    having been there, which is exactly what this tool clears.
 *                    There is no text behind it, so it cannot be overwritten.
 *   call notice (3)  Nobody can delete this one, so it has to be counted out of
 *                    both, or the total promises more than any run can deliver.
 */
function opsMessages() {
  const base = Date.UTC(2024, 2, 1, 12, 0, 0);
  return [
    { minute: 50, content: 'newest message', type: 0 },
    { minute: 40, content: 'has a link https://discord.com/channels/1', type: 0 },
    { minute: 35, content: 'started a call', type: 3 },
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

    // Counted from outside the extension, over CDP, because chrome.tabs.query
    // only fills url/pendingUrl for tabs the extension has permission to see
    // and this one deliberately takes neither "tabs" nor a host permission
    // covering chrome-extension://. Asking the worker therefore returned an
    // empty string for every extension page and the filter matched nothing: the
    // assertion was 0 <= 3, and it stayed green with resolveOpen mutated to
    // stack a fresh tab on every single click.
    const appTargets = (await httpJson(PORT, '/json/list')).filter((t) =>
      (t.url || '').includes('/app/app.html')
    );
    check('spine', 'only one app tab exists after two toolbar clicks', appTargets.length === 1,
      `found ${appTargets.length}: ${JSON.stringify(appTargets.map((t) => t.url))}`);

    // A tab that navigated away is not the app any more, and tabs.get still
    // resolves it, so the toolbar went on focusing whatever was there and never
    // opened the app again. The action is the only entry point this extension
    // has, so that was the whole product unreachable for the rest of the
    // browser session, and a genuine app tab asking to connect was told it was
    // "already open in another tab", naming a tab showing Discord.
    //
    // Driven on a tab of its own rather than by navigating the one above away:
    // that one is this suite's app tab and everything after this still needs it.
    // Pointing the background at a stand-in reproduces the same state, which is
    // "the remembered id resolves and is not the app".
    const strandedId = await cdp.evaluate(
      sw,
      "chrome.tabs.create({ url: 'about:blank#not-the-app', active: false }).then(t => t.id)"
    );
    await cdp.evaluate(
      sw,
      `chrome.storage.session.set({ appTabId: ${strandedId} }).then(() => true)`
    );
    const beforeReopen = (await httpJson(PORT, '/json/list')).filter((t) =>
      (t.url || '').includes('/app/app.html')
    ).length;
    const reopenedId = await cdp.evaluate(sw, 'CL.background.openApp()');
    await sleep(800);
    const afterReopen = (await httpJson(PORT, '/json/list')).filter((t) =>
      (t.url || '').includes('/app/app.html')
    ).length;
    const liveAfter = await cdp.evaluate(sw, 'JSON.stringify(CL.background.liveAppTabs())');
    check('spine', 'the toolbar never lands on the tab that navigated away',
      reopenedId !== strandedId,
      `openApp returned ${reopenedId}, and the stranded tab was ${strandedId}`);
    /*
     * Where it goes instead is "a tab that is running the app", not "a tab it
     * just made".
     *
     * There is a real app tab open here, which is this suite's own, and opening
     * a second beside it is not a harmless extra window: creating one seizes the
     * remembered id on the way past, so the next connect broadcasts a supersede
     * and the tab that was already there stands down, cancelling whatever run it
     * was in the middle of. Reusing the live one is both the shorter answer and
     * the one that cannot do that.
     *
     * The other branch, where nothing is running the app and a tab genuinely has
     * to be made, is the pair of checks above: two toolbar clicks from a cold
     * start opened exactly one tab between them.
     */
    check('spine', 'it goes to a tab that is running the app right now',
      JSON.parse(liveAfter || '[]').indexOf(reopenedId) !== -1,
      `openApp returned ${reopenedId}, and the live app tabs were ${liveAfter}`);
    check('spine', 'and does not stack a second copy beside one already open',
      afterReopen === beforeReopen,
      `app tabs went ${beforeReopen} -> ${afterReopen}`);

    // And a genuine app tab is not told that stand-in owns the queue.
    await cdp.evaluate(
      sw,
      `chrome.storage.session.set({ appTabId: ${strandedId} }).then(() => true)`
    );
    const claimAgainstStranded = await cdp.evaluate(
      sw,
      `CL.background.claimApp(${firstId}, false, 'probe').then(r => JSON.stringify(r))`
    );
    check('spine', 'a stranded tab id does not lock the real app out of the queue',
      JSON.parse(claimAgainstStranded || '{}').ok === true,
      `claim answered ${claimAgainstStranded}`);

    // Put the suite's own tab back in charge and clean up the stand-in. Written
    // to survive the failing case as well as the passing one: when this check
    // goes red the two ids are the same tab, and a cleanup that removed both
    // would throw and take the rest of the suite down with it, turning a clear
    // failure into a crash that says nothing.
    // firstId is excluded by name as well as by the dedupe. openApp can now
    // answer with a tab that is already running the app rather than a new one,
    // and the one it is most likely to answer with is this suite's, so a
    // cleanup list built from what it returned could close the tab every check
    // after this one still needs.
    const cleanUp = [strandedId, reopenedId].filter(
      (id, i, all) => typeof id === 'number' && id !== firstId && all.indexOf(id) === i
    );
    for (const id of cleanUp) {
      await cdp.evaluate(sw, `chrome.tabs.remove(${id}).then(() => true).catch(() => true)`);
    }
    await cdp.evaluate(
      sw,
      `chrome.storage.session.set({ appTabId: ${firstId} }).then(() => true)`
    );

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

    /*
     * Taking the queue back must not throw away what the tab was working on.
     *
     * "Use this tab instead" was wired straight to connect(), whose success tail
     * is unconditional: it rebuilds both pickers and ends on goTo('where'). For
     * a tab that has never connected that is right. For one that has, it is the
     * thing reconnect()'s own note warns against. There is no route from Where
     * forward to Review except a fresh search, and a fresh search replaces the
     * results and clears every exclusion, so a whole-server search that paged
     * for twenty minutes and several minutes of unticking rows by hand were
     * still in memory and no longer reachable from any control on screen.
     */
    await cdp.evaluate(
      app.session,
      `(() => {
        const cl = window.__clearline;
        cl.state.excluded = new Set(['900000000000000001']);
        cl.goTo('review');
      })()`
    );
    await closeTab(cdp, second);
    await sleep(300);
    await cdp.evaluate(app.session, "document.getElementById('takeover').click()");
    const takenBack = await waitFor(
      'the tab to take the queue back',
      async () => {
        const value = await cdp.evaluate(
          app.session,
          `(() => {
            const cl = window.__clearline;
            const step = ['connect','where','filter','review','run'].find((n) => {
              const el = document.getElementById('step-' + n);
              return el && !el.classList.contains('hidden');
            });
            return JSON.stringify({
              step: step || 'none',
              superseded: cl.state.superseded,
              results: cl.state.results.length,
              spared: cl.state.excluded.size,
              search: document.getElementById('search').disabled,
              reconnect: document.getElementById('reconnect').disabled,
            });
          })()`
        );
        const parsed = value ? JSON.parse(value) : null;
        return parsed && parsed.superseded === false ? parsed : null;
      },
      { timeout: 10000 }
    ).catch(() => null);

    // Read again once it has settled, not at the moment the flag clears. A full
    // connect stands the tab up early and only rewinds the wizard at the end of
    // three paced calls, so a check that fires on the flag alone sees the state
    // it wanted several seconds before the damage is done and passes.
    await sleep(5000);
    const settled = takenBack
      ? JSON.parse(
          await cdp.evaluate(
            app.session,
            `(() => {
              const cl = window.__clearline;
              const step = ['connect','where','filter','review','run'].find((n) => {
                const el = document.getElementById('step-' + n);
                return el && !el.classList.contains('hidden');
              });
              return JSON.stringify({
                step: step || 'none',
                superseded: cl.state.superseded,
                results: cl.state.results.length,
                spared: cl.state.excluded.size,
                search: document.getElementById('search').disabled,
                reconnect: document.getElementById('reconnect').disabled,
              });
            })()`
          )
        )
      : null;

    check('one tab', 'taking the queue back leaves the result set where it was',
      settled && settled.results === 1 && settled.spared === 1,
      `after reclaim: ${JSON.stringify(settled)}`);
    check('one tab', 'taking the queue back does not rewind the wizard',
      settled && settled.step === 'review',
      `after reclaim the visible step was ${settled && settled.step}`);
    check('one tab', 'taking the queue back re-arms every control it stood down',
      settled && settled.search === false && settled.reconnect === false,
      `after reclaim: ${JSON.stringify(settled)}`);

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

    check('operations', 'a search reports what it matched', /7 messages matched/.test(heading),
      `heading said ${JSON.stringify(heading)}`);

    const rows = await cdp.evaluate(ops.session, "document.querySelectorAll('#results-body tr').length");
    check('operations', 'every match is listed for review before anything is destroyed', rows === 7,
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
      /6 of 7 messages selected/.test(afterDrop || ''), `heading said ${JSON.stringify(afterDrop)}`);

    await cdp.evaluate(ops.session, "document.getElementById('review-next').click()");
    await sleep(200);
    const sparedPreflight = await textOf(cdp, ops.session, '#preflight');
    check('operations', 'a spared message is left out of the pre-flight count',
      /permanently delete 5 messages/.test(sparedPreflight || ''),
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
      /permanently delete 6 messages/.test(preflight || ''),
      `pre-flight said ${JSON.stringify(preflight)}`);
    check('operations', 'the pre-flight says the call notice is left alone',
      /1 message cannot be removed/.test(preflight || ''), `pre-flight said ${JSON.stringify(preflight)}`);
    check('operations', 'the pre-flight says it cannot be undone',
      /cannot be undone/.test(preflight || ''), `pre-flight said ${JSON.stringify(preflight)}`);

    // Overwriting is held to a shorter list than deleting, so it counts fewer.
    // Discord removes a join notice for its author but has no text behind it to
    // replace, and answers the PATCH with a plain 400 that lands in the failure
    // pile and counts toward the limit that halts a whole run. One predicate for
    // both questions had to be as narrow as this one, which is what left join
    // notices undeletable and told the user Discord had forbidden it.
    await cdp.evaluate(
      ops.session,
      "document.querySelector('input[name=action][value=edit]').click()"
    );
    await sleep(200);
    const editPreflight = await textOf(cdp, ops.session, '#preflight');
    check('operations', 'overwriting counts only what can actually be changed',
      /overwrite the text of 5 messages/i.test(editPreflight || ''),
      `pre-flight said ${JSON.stringify(editPreflight)}`);
    check('operations', 'overwriting leaves both system notices alone',
      /2 messages cannot be changed/.test(editPreflight || ''),
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

    /*
     * What the run was started with is frozen for the length of it.
     *
     * Every control on this screen was read once, when Start was pressed, and
     * then left live. A click on a different action while the bar was moving
     * rebuilt the whole pre-flight around it, so the screen described an
     * overwrite while the job went on deleting, the line saying it could not be
     * undone came and went, and Start lit up again because the pre-flight
     * derives it from `state.ran`, which is still false mid-run.
     *
     * The lasting damage is one screen further on. Stop a run, take the offer to
     * carry on with what it never reached, and the remainder goes out under
     * whichever radio is checked by then. A run agreed to as an overwrite could
     * finish as a delete.
     *
     * Driven the way the bug was reachable, which is a real click on the radio,
     * and read back off the same pre-flight the user would be reading.
     */
    await sleep(1200);
    const midRun = await cdp.evaluate(
      ops.session,
      `(() => {
        const radios = Array.from(document.querySelectorAll('input[name=action]'));
        radios[2].click();
        return JSON.stringify({
          running: !!window.__clearline.state.job,
          radios: radios.map(r => r.disabled),
          stillDelete: (document.querySelector('input[name=action]:checked') || {}).value,
          replacement: document.getElementById('replacement').disabled,
          backup: document.getElementById('backup').disabled,
          confirm: document.getElementById('confirm').disabled,
          start: document.getElementById('start').disabled,
          back: document.getElementById('run-back').disabled,
          preflight: document.getElementById('preflight').textContent,
        });
      })()`
    );
    const during = midRun ? JSON.parse(midRun) : {};
    check('operations', 'the action cannot be changed while the run is going',
      during.running === true && during.radios.every(Boolean) && during.stillDelete === 'delete',
      `mid-run form read ${midRun}`);
    check('operations', 'nor the replacement text, the backup box or the typed count',
      during.replacement === true && during.backup === true && during.confirm === true,
      `mid-run form read ${midRun}`);
    check('operations', 'and Start stays down rather than being handed back by a redraw',
      during.start === true && during.back === true, `mid-run form read ${midRun}`);
    check('operations', 'so the sentence above it still describes the run that is running',
      /delete/i.test(during.preflight || '') && !/overwrite/i.test(during.preflight || ''),
      `pre-flight read ${JSON.stringify(during.preflight)}`);

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

    check('operations', 'the run deletes exactly the messages it promised', deleted.length === 6,
      `deleted ${deleted.length}: ${JSON.stringify(deleted)}`);
    check('operations', 'the join notice was removed like anything else the account left',
      deleted.includes(idFor(Date.UTC(2024, 2, 1, 12, 30, 0))),
      'the join notice this account left behind is still there');
    check('operations', 'the call notice was never even attempted',
      !deleted.includes(idFor(Date.UTC(2024, 2, 1, 12, 35, 0))),
      'a message Discord refuses to delete was sent to the API anyway');
    check('operations', 'the run reports finishing', /Finished\. 6 messages handled/.test(report || ''),
      `report said ${JSON.stringify(report)}`);

    const formAfterRun = await cdp.evaluate(
      ops.session,
      `JSON.stringify({
        radios: Array.from(document.querySelectorAll('input[name=action]')).map(r => r.disabled),
        replacement: document.getElementById('replacement').disabled,
        backup: document.getElementById('backup').disabled,
      })`
    );
    const released = formAfterRun ? JSON.parse(formAfterRun) : {};
    check('operations', 'and hands the form back once it is over',
      released.radios.every((d) => d === false) &&
        released.replacement === false &&
        released.backup === false,
      `form after the run read ${formAfterRun}`);

    check('operations', 'deletes went oldest first',
      deleted.length === 6 && BigInt(deleted[0]) < BigInt(deleted[5]),
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

    // Keeping the report has to be offered where it can actually be clicked,
    // not merely present in the markup. A control inside a hidden subtree reads
    // fine to a programmatic click and to textContent, which is how a stopped
    // tab once passed this suite with no way back on screen at all.
    const saveOffered = await cdp.evaluate(
      ops.session,
      `(() => {
        const buttons = Array.from(document.querySelectorAll('#run-report button'));
        const save = buttons.find((b) => b.textContent === ${JSON.stringify('Save this report')});
        return JSON.stringify({
          found: !!save,
          visible: !!save && save.offsetParent !== null,
          labels: buttons.map((b) => b.textContent),
        });
      })()`
    );
    const savedState = JSON.parse(saveOffered);
    check('operations', 'the report offers to be kept',
      savedState.found === true && savedState.visible === true,
      `report buttons were ${JSON.stringify(savedState.labels)}`);

    /*
     * A run that stops has to be resumable, and it has to resume the right set.
     *
     * The messages a stopped run never reached used to be counted and then
     * discarded, so the only route on was to search the whole server again and
     * redo every exclusion by hand: on a set that took twenty minutes to page,
     * a reason not to stop a run that should be stopped.
     *
     * Driven against a real cancel rather than a fabricated state, because what
     * is being checked is that the queue handed back is exactly the untouched
     * tail: not the whole set, not the part already deleted.
     */
    const carriedOn = await cdp.evaluate(
      ops.session,
      `(() => {
        const cl = window.__clearline;
        cl.state.results = cl.stashed.slice();
        cl.state.excluded = new Set();
        cl.state.ran = false;
        cl.renderReview();
        cl.renderPreflight();
        return cl.state.results.length;
      })()`
    );
    await cdp.evaluate(ops.session, "document.getElementById('backup').checked = false");
    await cdp.evaluate(ops.session, "document.getElementById('start').click()");
    await sleep(1500);
    await cdp.evaluate(ops.session, "document.getElementById('run-cancel').click()");
    const stopped = await waitFor(
      'the cancelled run to report',
      async () =>
        (await cdp.evaluate(
          ops.session,
          "document.getElementById('run-report').classList.contains('hidden')"
        )) === false
          ? true
          : null,
      { timeout: 30000 }
    ).catch(() => false);

    const continueState = await cdp.evaluate(
      ops.session,
      `(() => {
        const buttons = Array.from(document.querySelectorAll('#run-report button'));
        const carry = buttons.find((b) => /Carry on/i.test(b.textContent));
        const before = window.__clearline.state.results.length;
        // Read before the click. Clicking hides the report, so asking
        // afterwards asks whether a control the user has already used is
        // visible, which is always no and says nothing about whether it was
        // reachable in the first place.
        const offered = !!carry && carry.offsetParent !== null;
        if (carry) carry.click();
        const cl = window.__clearline;
        return JSON.stringify({
          offered,
          label: carry ? carry.textContent : null,
          before,
          after: cl.state.results.length,
          spared: cl.state.excluded.size,
          startDisabled: document.getElementById('start').disabled,
          reportHidden: document.getElementById('run-report').classList.contains('hidden'),
          focusInRunStep: document.getElementById('step-run').contains(document.activeElement),
        });
      })()`
    );
    const carried = JSON.parse(continueState || '{}');
    check('operations', 'a stopped run offers to carry on with what it never reached',
      stopped === true && carried.offered === true,
      `report offered ${JSON.stringify(carried)}`);
    check('operations', 'carrying on loads exactly the untouched tail, not the whole set',
      carried.after > 0 && carried.after < carriedOn && carried.spared === 0,
      `${carriedOn} queued, ${carried.after} carried on, ${carried.spared} spared`);
    check('operations', 'carrying on re-arms Start rather than leaving the run screen dead',
      carried.startDisabled === false && carried.reportHidden === true,
      `after carrying on ${JSON.stringify(carried)}`);
    // hide() takes the clicked button out of the accessibility tree while it
    // still holds focus, which drops focus to <body>: the next Tab restarts at
    // the page heading and nothing announces that Start is live again.
    check('operations', 'carrying on moves focus somewhere real',
      carried.focusInRunStep === true,
      `focus left the run step: ${JSON.stringify(carried)}`);

    /*
     * A new search retires the last run's report.
     *
     * Three paths cleared it and the ordinary one did not: Start, the report's
     * own Search again, and carrying on with a queue. Reaching Narrow the way
     * the Back buttons and the rail reach it, and searching from there, left it
     * standing, so the Act step opened on "Finished. 6 messages handled." above
     * a pre-flight for a set that is all still there. Its buttons were live too:
     * carrying on would have thrown away the search that had just finished and
     * put the old queue back in its place, and keeping the report wrote the old
     * run's numbers into a file headed with the new selection.
     *
     * Put back into the state that reaches it: a finished run, a report on
     * screen, and then the Search button.
     */
    await cdp.evaluate(
      ops.session,
      `(() => {
        const cl = window.__clearline;
        cl.state.unsavedReport = true;
        cl.state.ran = true;
        document.getElementById('run-report').classList.remove('hidden');
        cl.goTo('filter');
      })()`
    );
    await sleep(150);
    const beforeResearch = await cdp.evaluate(
      ops.session,
      "document.getElementById('run-report').classList.contains('hidden')"
    );
    await cdp.evaluate(ops.session, "document.getElementById('search').click()");
    const researched = await waitFor(
      'the second search to land',
      async () =>
        (await cdp.evaluate(
          ops.session,
          "!document.getElementById('step-review').classList.contains('hidden')"
        )) === true
          ? true
          : null,
      { timeout: 30000 }
    ).catch(() => null);
    const afterResearch = JSON.parse(
      await cdp.evaluate(
        ops.session,
        `JSON.stringify({
          reportHidden: document.getElementById('run-report').classList.contains('hidden'),
          unsaved: window.__clearline.state.unsavedReport,
          ran: window.__clearline.state.ran,
        })`
      )
    );
    check('operations', 'a search reaches the review step with the report still standing behind it',
      beforeResearch === false && researched === true,
      `report hidden before the search: ${beforeResearch}, landed: ${researched}`);
    check('operations', 'and takes the last run’s report down with it',
      afterResearch.reportHidden === true && afterResearch.ran === false,
      `after the second search ${JSON.stringify(afterResearch)}`);
    // Guarding something the user can no longer reach is worse than no prompt,
    // and searching again is the same deliberate move as the report's own
    // button, which has always dropped it on exactly these terms.
    check('operations', 'so the unload prompt stops asking about it',
      afterResearch.unsaved === false,
      `after the second search ${JSON.stringify(afterResearch)}`);

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

    /*
     * The search says it is still going, from wherever the user is standing.
     *
     * The panel used to live inside the Narrow step, so going Back took the
     * counter, the elapsed time, the reason for a wait and the only Stop button
     * off screen with it, while the search carried on paging. Going Back during
     * a search is deliberate and is what the rest of this group is about, so the
     * panel is what had to move: a long operation should be visible to the
     * person who started it, and stoppable, wherever they have wandered to.
     */
    const whileAway = JSON.parse(
      await cdp.evaluate(
        scopeTab.session,
        `JSON.stringify({
          onWhere: !document.getElementById('step-where').classList.contains('hidden'),
          panelVisible: document.getElementById('search-progress').offsetParent !== null,
          stopVisible: document.getElementById('search-stop').offsetParent !== null,
          stopDisabled: document.getElementById('search-stop').disabled,
          counter: document.getElementById('search-counter').textContent,
        })`
      )
    );
    check('scope', 'a search that outlived its own step still says it is running',
      whileAway.onWhere === true && whileAway.panelVisible === true,
      `on where ${whileAway.onWhere}, panel visible ${whileAway.panelVisible}`);
    check('scope', 'and its Stop button is still there to be pressed',
      whileAway.stopVisible === true && whileAway.stopDisabled === false,
      `stop visible ${whileAway.stopVisible}, disabled ${whileAway.stopDisabled}`);

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
    check('scope', 'a search still lands after the picker moved', /7 messages matched/.test(scopeHeading),
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
      channelCells.length === 7 && channelCells.every((c) => c === '#general'),
      `channel column was ${JSON.stringify(channelCells)}`);

    await cdp.evaluate(scopeTab.session, "document.getElementById('review-next').click()");
    await sleep(250);
    const scopePreflight = await textOf(cdp, scopeTab.session, '#preflight');
    check('scope', 'the sentence above Start names the server that was actually searched',
      /\bg0\b/.test(scopePreflight || '') && !/\bg1\b/.test(scopePreflight || ''),
      `pre-flight said ${JSON.stringify(scopePreflight)}`);

    // A second search must not open showing the first one's numbers. This is
    // the tab where that is easy to see, because the search mock here is slow
    // on purpose, which is also the case where it used to be wrong for longest.
    await cdp.evaluate(scopeTab.session, "document.getElementById('run-back').click()");
    await sleep(150);
    await cdp.evaluate(scopeTab.session, "document.getElementById('review-back').click()");
    await sleep(150);
    const staleCounter = await textOf(cdp, scopeTab.session, '#search-counter');
    await cdp.evaluate(scopeTab.session, "document.getElementById('search').click()");
    await sleep(250);
    const freshCounter = await textOf(cdp, scopeTab.session, '#search-counter');
    check('scope', 'a second search does not open showing the first one figures',
      /\d/.test(staleCounter || '') && !/\d/.test(freshCounter || ''),
      `counter went from ${JSON.stringify(staleCounter)} to ${JSON.stringify(freshCounter)}`);

    await closeTab(cdp, scopeTab);

    /* ---------------- group: big sets ---------------- */

    // Everything past the render limit.
    //
    // No fixture anywhere else builds more than six rows, so the whole of this
    // was dead ground: the limit itself, the Show more button, and the line
    // that says how many of the messages you cannot see are still in the run.
    // That line is load bearing. The rows past 300 are not on screen and are
    // still queued for deletion, so it is the only thing telling anyone they
    // exist, and it could be made to report the wrong number, or Show more
    // made to append nothing, with every gate still green.
    const bigTab = await openTab(cdp, appUrl);
    await mockApi(cdp, bigTab.session, operationsMock([]));
    await sleep(400);
    await cdp.evaluate(bigTab.session, "document.getElementById('connect').click()");
    await waitFor('the where step', async () =>
      (await cdp.evaluate(bigTab.session, "!document.getElementById('step-where').classList.contains('hidden')")) === true
    ).catch(() => null);

    const bigState = async (expression) =>
      JSON.parse(await cdp.evaluate(bigTab.session, `JSON.stringify(${expression})`));

    await cdp.evaluate(
      bigTab.session,
      `(() => {
        const cl = window.__clearline;
        cl.state.results = Array.from({length: 400}, (_, i) => ({
          id: String(910000000000000000n + BigInt(i)),
          channelId: ${JSON.stringify(OPS_CHANNEL)},
          authorId: ${JSON.stringify(ACCOUNT.id)},
          channelName: 'general',
          type: 0, content: 'row ' + i, attachments: [],
          timestamp: '2024-03-01T12:00:00.000Z',
        }));
        cl.state.excluded = new Set();
        cl.state.shown = 0;
        cl.state.resultScopeLabel = 'g0 / all channels';
        cl.renderReview();
        cl.goTo('review');
      })()`
    );

    const firstPage = await bigState(`{
      rows: document.querySelectorAll('#results-body tr').length,
      note: document.getElementById('results-note').textContent,
      more: document.getElementById('show-more').textContent,
      moreHidden: document.getElementById('show-more').classList.contains('hidden'),
    }`);
    check('big sets', 'a huge result set renders only its first page',
      firstPage.rows === 300, `rendered ${firstPage.rows} rows`);
    check('big sets', 'the rest are offered rather than silently dropped',
      firstPage.moreHidden === false && /100/.test(firstPage.more),
      `Show more said ${JSON.stringify(firstPage.more)}, hidden ${firstPage.moreHidden}`);
    check('big sets', 'the note says how many unseen messages are in the run',
      /300/.test(firstPage.note) && /400/.test(firstPage.note) && /100/.test(firstPage.note),
      `note said ${JSON.stringify(firstPage.note)}`);

    // Take everything out of the run. The unseen count has to follow, and this
    // is the mutation the note's own comment says was once shipped: asserting
    // the rows past the limit "stay selected" rather than counting them.
    await cdp.evaluate(bigTab.session, "document.getElementById('pick-all').click()");
    await sleep(200);
    const noneOn = await bigState(`{
      note: document.getElementById('results-note').textContent,
      heading: document.getElementById('review-heading').textContent,
      nextDisabled: document.getElementById('review-next').disabled,
    }`);
    check('big sets', 'clearing the selection clears the unseen count with it',
      /Of the other 100, 0 are selected/.test(noneOn.note),
      `note said ${JSON.stringify(noneOn.note)}`);
    check('big sets', 'nothing selected means nothing to continue to',
      noneOn.nextDisabled === true, `heading said ${JSON.stringify(noneOn.heading)}`);

    /*
     * Undo the header checkbox.
     *
     * It replaces the whole selection in one click, including when it is hit on
     * the way to something else, and unticking two hundred rows out of five
     * thousand one at a time is an afternoon's work with no way back. Checked
     * against a hand-made selection rather than an empty one, because restoring
     * "nothing was spared" would pass whatever the undo actually did.
     */
    await cdp.evaluate(bigTab.session, "document.getElementById('pick-all').click()");
    await sleep(200);
    await cdp.evaluate(
      bigTab.session,
      `(() => {
        const boxes = document.querySelectorAll('#results-body input[type=checkbox]');
        for (const i of [3, 7, 11]) boxes[i].click();
      })()`
    );
    await sleep(200);
    const handMade = await bigState(`{
      spared: window.__clearline.state.excluded.size,
      undoHidden: document.getElementById('undo-pick').classList.contains('hidden'),
    }`);
    await cdp.evaluate(bigTab.session, "document.getElementById('pick-all').click()");
    await sleep(200);
    const wiped = await bigState(`{
      spared: window.__clearline.state.excluded.size,
      undoHidden: document.getElementById('undo-pick').classList.contains('hidden'),
      undoVisible: document.getElementById('undo-pick').offsetParent !== null,
    }`);
    await cdp.evaluate(bigTab.session, "document.getElementById('undo-pick').click()");
    await sleep(200);
    const restored = await bigState(`{
      spared: window.__clearline.state.excluded.size,
      undoHidden: document.getElementById('undo-pick').classList.contains('hidden'),
      firstRowsOff: Array.from(document.querySelectorAll('#results-body tr'))
        .slice(0, 12).filter((r) => r.classList.contains('off')).length,
    }`);

    check('big sets', 'undo is offered only once there is something to undo',
      handMade.undoHidden === true && wiped.undoVisible === true,
      `before ${JSON.stringify(handMade)}, after ${JSON.stringify(wiped)}`);
    check('big sets', 'undo puts back the selection the header checkbox replaced',
      handMade.spared === 3 && wiped.spared === 400 && restored.spared === 3,
      `spared went ${handMade.spared} -> ${wiped.spared} -> ${restored.spared}`);
    check('big sets', 'undo redraws the rows it restored rather than only the count',
      restored.firstRowsOff === 3,
      `${restored.firstRowsOff} of the first twelve rows read as spared`);
    check('big sets', 'undo takes itself away once it has been used',
      restored.undoHidden === true, 'a second click would undo something else');

    await cdp.evaluate(bigTab.session, "document.getElementById('pick-all').click()");
    await sleep(200);
    await cdp.evaluate(bigTab.session, "document.getElementById('pick-all').click()");
    await sleep(200);

    // One visible row spared. The unseen count must not move, and the heading
    // must count the whole set rather than the rendered part of it.
    await cdp.evaluate(
      bigTab.session,
      "document.querySelectorAll('#results-body input[type=checkbox]')[0].click()"
    );
    await sleep(200);
    const oneOff = await bigState(`{
      note: document.getElementById('results-note').textContent,
      heading: document.getElementById('review-heading').textContent,
    }`);
    check('big sets', 'sparing a visible row does not change the unseen count',
      /Of the other 100, 100 are selected/.test(oneOff.note),
      `note said ${JSON.stringify(oneOff.note)}`);
    check('big sets', 'the heading counts the whole set, not the rendered part',
      /399/.test(oneOff.heading) && /400/.test(oneOff.heading),
      `heading said ${JSON.stringify(oneOff.heading)}`);

    await cdp.evaluate(bigTab.session, "document.getElementById('show-more').click()");
    await sleep(300);
    const secondPage = await bigState(`{
      rows: document.querySelectorAll('#results-body tr').length,
      moreHidden: document.getElementById('show-more').classList.contains('hidden'),
      lastRow: (document.querySelectorAll('#results-body tr')[399] || {}).textContent || '',
      stillSpared: document.querySelectorAll('#results-body tr.off').length,
    }`);
    check('big sets', 'Show more actually appends the rest',
      secondPage.rows === 400 && /row 399/.test(secondPage.lastRow),
      `rendered ${secondPage.rows} rows, last was ${JSON.stringify(secondPage.lastRow)}`);
    check('big sets', 'Show more takes itself away once there is no more',
      secondPage.moreHidden === true);
    check('big sets', 'appending rows keeps the row that was spared spared',
      secondPage.stillSpared === 1, `${secondPage.stillSpared} rows were marked spared`);

    /* ---------------- group: by channel ---------------- */

    /*
     * Sparing a whole channel, on the whole result set.
     *
     * The table renders three hundred rows out of sets that are routinely
     * thousands, so before this the only selections that could reach the rest
     * were all and none: keeping #introductions out of a server-wide sweep meant
     * finding every one of its rows by hand, most of them behind a Show more
     * that had to be clicked a dozen times before they existed to be clicked.
     * The checks below are all about the rows nobody can see, because those are
     * the ones this is for and the ones a per-row implementation would miss.
     *
     * Driven on the tab above, which is already standing on four hundred rows
     * that all came from one channel, so the first thing to establish is that a
     * single channel gets no breakdown at all.
     */
    const oneChannel = await bigState(`{
      blockHidden: document.getElementById('channel-block').classList.contains('hidden'),
      rows: document.querySelectorAll('#channel-list li').length,
    }`);
    check('by channel', 'one channel is not a breakdown, so none is offered',
      oneChannel.blockHidden === true && oneChannel.rows === 0,
      `hidden ${oneChannel.blockHidden}, ${oneChannel.rows} rows`);

    // Six hundred messages over three channels, deliberately more than twice the
    // render limit so that most of every channel is off screen throughout.
    await cdp.evaluate(
      bigTab.session,
      `(() => {
        const cl = window.__clearline;
        const rooms = [['general', 300], ['random', 200], ['introductions', 100]];
        const out = [];
        let n = 0;
        for (const [name, howMany] of rooms) {
          for (let i = 0; i < howMany; i++) {
            out.push({
              id: String(910000000000000000n + BigInt(n++)),
              channelId: 'c-' + name,
              parentId: null,
              guildId: '200000000000000000',
              authorId: ${JSON.stringify(ACCOUNT.id)},
              channelName: name,
              type: 0, content: name + ' ' + i, attachments: [],
              timestamp: '2024-03-01T12:00:00.000Z',
            });
          }
        }
        cl.state.results = out;
        cl.state.excluded = new Set();
        cl.state.shown = 0;
        cl.renderReview();
      })()`
    );
    await sleep(250);

    const listed = await bigState(`{
      blockHidden: document.getElementById('channel-block').classList.contains('hidden'),
      names: Array.from(document.querySelectorAll('#channel-list .chname')).map(e => e.textContent),
      counts: Array.from(document.querySelectorAll('#channel-list .chcount')).map(e => e.textContent),
      rendered: document.querySelectorAll('#results-body tr').length,
    }`);
    check('by channel', 'several channels are listed, largest first',
      listed.blockHidden === false &&
        JSON.stringify(listed.names) === JSON.stringify(['#general', '#random', '#introductions']),
      `listed ${JSON.stringify(listed.names)}`);
    check('by channel', 'each one says how many of it is still in the run',
      /300/.test(listed.counts[0] || '') && /100/.test(listed.counts[2] || ''),
      `counts read ${JSON.stringify(listed.counts)}`);
    check('by channel', 'and most of every channel is off screen, which is the point',
      listed.rendered === 300, `${listed.rendered} rows rendered out of 600`);

    // Untick the smallest, which is entirely past the render limit: not one of
    // its hundred rows exists in the table to be clicked.
    await cdp.evaluate(
      bigTab.session,
      "document.querySelectorAll('#channel-list input[type=checkbox]')[2].click()"
    );
    await sleep(250);
    const spared = await bigState(`{
      excluded: window.__clearline.state.excluded.size,
      heading: document.getElementById('review-heading').textContent,
      counts: Array.from(document.querySelectorAll('#channel-list .chcount')).map(e => e.textContent),
      boxes: Array.from(document.querySelectorAll('#channel-list input[type=checkbox]'))
        .map(b => b.indeterminate ? 'part' : b.checked ? 'on' : 'off'),
      undoHidden: document.getElementById('undo-pick').classList.contains('hidden'),
      renderedOff: document.querySelectorAll('#results-body tr.off').length,
    }`);
    check('by channel', 'unticking a channel spares every message in it, seen or not',
      spared.excluded === 100, `${spared.excluded} messages were taken out of the run`);
    check('by channel', 'the heading counts the whole set, not the rendered part of it',
      /500/.test(spared.heading) && /600/.test(spared.heading),
      `heading said ${JSON.stringify(spared.heading)}`);
    check('by channel', 'the channel that was spared says so, and the others do not move',
      JSON.stringify(spared.boxes) === JSON.stringify(['on', 'on', 'off']) &&
        /300/.test(spared.counts[0] || ''),
      `boxes ${JSON.stringify(spared.boxes)}, counts ${JSON.stringify(spared.counts)}`);
    check('by channel', 'a tick worth hundreds of rows is offered back',
      spared.undoHidden === false, 'undo was not offered');
    // The rendered rows are all #general here, so none of them should have moved.
    check('by channel', 'and it does not disturb the rows on screen',
      spared.renderedOff === 0, `${spared.renderedOff} visible rows were struck through`);

    await cdp.evaluate(bigTab.session, "document.getElementById('undo-pick').click()");
    await sleep(250);
    const restoredChannel = await bigState('window.__clearline.state.excluded.size');
    check('by channel', 'undo puts a spared channel back',
      restoredChannel === 0, `${restoredChannel} messages were still spared`);

    // A row ticked by hand and a channel ticked afterwards have to agree, since
    // both write to the one set the run is built from.
    await cdp.evaluate(
      bigTab.session,
      `(() => {
        document.querySelectorAll('#results-body input[type=checkbox]')[0].click();
        document.querySelectorAll('#channel-list input[type=checkbox]')[1].click();
      })()`
    );
    await sleep(250);
    const mixed = await bigState(`{
      excluded: window.__clearline.state.excluded.size,
      boxes: Array.from(document.querySelectorAll('#channel-list input[type=checkbox]'))
        .map(b => b.indeterminate ? 'part' : b.checked ? 'on' : 'off'),
    }`);
    check('by channel', 'a hand-picked row and a whole channel add up rather than replacing',
      mixed.excluded === 201, `${mixed.excluded} spared, expected 200 plus the one row`);
    check('by channel', 'and the channel holding that one row reads as partly in',
      JSON.stringify(mixed.boxes) === JSON.stringify(['part', 'off', 'on']),
      `boxes read ${JSON.stringify(mixed.boxes)}`);

    await closeTab(cdp, bigTab);

    /* ---------------- group: rail ---------------- */

    // The step rail, now that it navigates.
    //
    // It spent four releases looking exactly like a row of tabs and doing
    // nothing, and making it work opens three ways to break the app that a
    // decorative list could not. Going forward past what has been done would
    // walk somebody to the delete screen without a result set. Going to
    // `connect` would hide every step and show nothing, because the connect
    // card is not a step and there is no `#step-connect` to reveal: the app
    // would be a header and a footer with no way back. And going anywhere at
    // all mid-run takes the counter, the pace note and the Stop button off
    // screen while the run carries on deleting, which is why `run-back` is
    // disabled for the length of a run and why the rail owes the same answer.
    const railTab = await openTab(cdp, appUrl);
    await mockApi(cdp, railTab.session, operationsMock([]));
    await sleep(400);
    await cdp.evaluate(railTab.session, "document.getElementById('connect').click()");
    await waitFor('the where step', async () =>
      (await cdp.evaluate(railTab.session, "!document.getElementById('step-where').classList.contains('hidden')")) === true
    ).catch(() => null);

    const railState = async (expression) =>
      JSON.parse(await cdp.evaluate(railTab.session, `JSON.stringify(${expression})`));

    // Read off the live buttons rather than off the classes, because being
    // enabled is the whole of what changed and a class says nothing about it.
    const railProbe = `(() => {
      const out = {};
      for (const li of document.querySelectorAll('#rail li')) {
        out[li.dataset.step] = li.querySelector('.railbtn').disabled;
      }
      return out;
    })()`;

    const atWhere = await railState(railProbe);
    check('rail', 'nothing ahead of the current step is offered',
      atWhere.filter === true && atWhere.review === true && atWhere.run === true,
      `filter/review/run disabled: ${atWhere.filter}/${atWhere.review}/${atWhere.run}`);
    check('rail', 'the current step is not a way to itself',
      atWhere.where === true);
    // The one that would blank the app. `connect` is behind every other step
    // for the rest of the session, so it is permanently the most tempting
    // thing on the rail and permanently the most broken.
    check('rail', 'connect is never offered, having no step to go back to',
      atWhere.connect === true);

    await cdp.evaluate(
      railTab.session,
      `(() => {
        const cl = window.__clearline;
        cl.state.results = [{
          id: '930000000000000001',
          channelId: ${JSON.stringify(OPS_CHANNEL)},
          authorId: ${JSON.stringify(ACCOUNT.id)},
          channelName: 'general',
          type: 0, content: 'keep me', attachments: [],
          timestamp: '2024-03-01T12:00:00.000Z',
        }];
        cl.state.excluded = new Set();
        cl.state.shown = 0;
        cl.state.resultScopeLabel = 'g0 / all channels';
        cl.renderReview();
        cl.goTo('run');
      })()`
    );

    const atRun = await railState(railProbe);
    check('rail', 'a finished step is offered once it is behind you',
      atRun.where === false && atRun.filter === false && atRun.review === false,
      `where/filter/review disabled: ${atRun.where}/${atRun.filter}/${atRun.review}`);

    // The point of the shortcut. Going back by the rail has to leave the
    // result set alone, because the only thing that rebuilds it is a fresh
    // search, and a fresh search clears every row spared by hand.
    await cdp.evaluate(railTab.session, `(() => {
      for (const li of document.querySelectorAll('#rail li')) {
        if (li.dataset.step === 'review') li.querySelector('.railbtn').click();
      }
    })()`);
    await sleep(200);
    const wentBack = await railState(`{
      onReview: !document.getElementById('step-review').classList.contains('hidden'),
      onRun: !document.getElementById('step-run').classList.contains('hidden'),
      rows: document.querySelectorAll('#results-body tr').length,
    }`);
    check('rail', 'clicking a finished step goes there',
      wentBack.onReview === true && wentBack.onRun === false,
      `review ${wentBack.onReview}, run ${wentBack.onRun}`);
    check('rail', 'going back by the rail keeps the results it was standing on',
      wentBack.rows === 1, `${wentBack.rows} rows survived`);

    // Mid-run. Driven through setBusy rather than by starting a real job,
    // because the assertion is about the rail and a real run would put a
    // minute of write-floor pacing between the click and the answer.
    await cdp.evaluate(railTab.session, "window.__clearline.setBusy(true)");
    await sleep(100);
    const duringRun = await railState(railProbe);
    check('rail', 'the rail closes while a search or a run is going',
      Object.values(duringRun).every((disabled) => disabled === true),
      `disabled flags were ${JSON.stringify(duringRun)}`);

    await cdp.evaluate(railTab.session, "window.__clearline.setBusy(false)");
    await sleep(100);
    const afterRun = await railState(railProbe);
    check('rail', 'and opens again when it stops',
      afterRun.where === false && afterRun.filter === false,
      `where/filter disabled: ${afterRun.where}/${afterRun.filter}`);

    /*
     * The one thing the rail is allowed to go forward to, and why.
     *
     * A run report is the only account of something that cannot be undone:
     * which messages were left alone and why, which failed and with what, about
     * messages that no longer exist to be looked at again. Leaving the Act step
     * put it behind a section the rail would not reopen, because Act was now
     * ahead of wherever the click landed. One misclick and the record was in the
     * document with no control able to show it, while the unload prompt went on
     * asking about something the user could not reach and so could not save.
     *
     * It costs nothing of the order that makes this wizard safe, which the
     * second check here is about: Act opens on a report and a Save button, and
     * Start is still down.
     */
    await cdp.evaluate(
      railTab.session,
      `(() => {
        const cl = window.__clearline;
        cl.state.ran = true;
        cl.state.unsavedReport = true;
        cl.goTo('where');
      })()`
    );
    await sleep(150);
    const strandedReport = await railState(railProbe);
    check('rail', 'a report nothing else can reach is reachable',
      strandedReport.run === false,
      `run disabled: ${strandedReport.run}, from the where step`);
    check('rail', 'and the steps between it and here stay closed off',
      strandedReport.review === true && strandedReport.filter === true,
      `review/filter disabled: ${strandedReport.review}/${strandedReport.filter}`);

    await cdp.evaluate(railTab.session, `(() => {
      for (const li of document.querySelectorAll('#rail li')) {
        if (li.dataset.step === 'run') li.querySelector('.railbtn').click();
      }
    })()`);
    await sleep(200);
    const backAtReport = await railState(`{
      onRun: !document.getElementById('step-run').classList.contains('hidden'),
      start: document.getElementById('start').disabled,
    }`);
    check('rail', 'going there shows the report without re-arming the run',
      backAtReport.onRun === true && backAtReport.start === true,
      `on run ${backAtReport.onRun}, start disabled ${backAtReport.start}`);

    // Saved, so there is nothing left to strand. The offer has to go with it,
    // or the rail is simply open forwards from then on.
    await cdp.evaluate(
      railTab.session,
      `(() => {
        const cl = window.__clearline;
        cl.state.unsavedReport = false;
        cl.goTo('where');
      })()`
    );
    await sleep(150);
    const nothingToStrand = await railState(railProbe);
    check('rail', 'and the offer goes away once the report has been kept',
      nothingToStrand.run === true, `run disabled: ${nothingToStrand.run}`);

    await cdp.evaluate(
      railTab.session,
      "(() => { window.__clearline.state.ran = false; window.__clearline.goTo('review'); })()"
    );
    await sleep(150);

    /* ---------------- group: nothing matched ---------------- */

    // A search that found nothing.
    //
    // The table was left standing with a header row and no rows under it,
    // which reads as a table still loading, and under it three download
    // buttons that would each write an empty file under a heading offering a
    // copy of something. Only the buttons were disabled, and only because the
    // selection happened to be empty too.
    await cdp.evaluate(
      railTab.session,
      `(() => {
        const cl = window.__clearline;
        cl.state.results = [];
        cl.state.excluded = new Set();
        cl.state.shown = 0;
        cl.state.resultScopeLabel = 'g0 / all channels';
        cl.renderReview();
        cl.goTo('review');
      })()`
    );
    const nothing = await railState(`{
      tableHidden: document.getElementById('results-wrap').classList.contains('hidden'),
      saveHidden: document.getElementById('save-block').classList.contains('hidden'),
      actionsHidden: document.getElementById('results-actions').classList.contains('hidden'),
      explained: document.getElementById('review-summary').textContent,
      isBlank: document.getElementById('review-summary').classList.contains('blank'),
      heading: document.getElementById('review-heading').textContent,
    }`);
    check('nothing matched', 'the empty table comes off screen',
      nothing.tableHidden === true);
    check('nothing matched', 'so do the buttons that would save an empty file',
      nothing.saveHidden === true && nothing.actionsHidden === true,
      `save ${nothing.saveHidden}, actions ${nothing.actionsHidden}`);
    check('nothing matched', 'the heading says so in words',
      /nothing|no messages/i.test(nothing.heading || ''),
      `heading said ${JSON.stringify(nothing.heading)}`);
    // The empty state is the sentence explaining the miss, restyled. If that
    // sentence ever stopped being written the screen would be blank, so the
    // test asserts the words as well as the box around them.
    check('nothing matched', 'and the reason takes the place of the table',
      nothing.isBlank === true && /g0 \/ all channels/.test(nothing.explained || ''),
      `blank ${nothing.isBlank}, summary ${JSON.stringify(nothing.explained)}`);

    // Back to a result set: the table has to come back with it, or a second
    // search after an empty one lands on a review screen with nothing on it.
    await cdp.evaluate(
      railTab.session,
      `(() => {
        const cl = window.__clearline;
        cl.state.results = [{
          id: '930000000000000002',
          channelId: ${JSON.stringify(OPS_CHANNEL)},
          authorId: ${JSON.stringify(ACCOUNT.id)},
          channelName: 'general',
          type: 0, content: 'found something', attachments: [],
          timestamp: '2024-03-01T12:00:00.000Z',
        }];
        cl.state.excluded = new Set();
        cl.state.shown = 0;
        cl.renderReview();
      })()`
    );
    const foundAgain = await railState(`{
      tableHidden: document.getElementById('results-wrap').classList.contains('hidden'),
      saveHidden: document.getElementById('save-block').classList.contains('hidden'),
      isBlank: document.getElementById('review-summary').classList.contains('blank'),
      rows: document.querySelectorAll('#results-body tr').length,
    }`);
    check('nothing matched', 'a later search that finds something gets its table back',
      foundAgain.tableHidden === false && foundAgain.saveHidden === false &&
        foundAgain.isBlank === false && foundAgain.rows === 1,
      `table ${foundAgain.tableHidden}, save ${foundAgain.saveHidden}, ` +
        `blank ${foundAgain.isBlank}, ${foundAgain.rows} rows`);

    await closeTab(cdp, railTab);
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
  // What had already passed, before whatever went wrong. A crash used to print
  // a CDP stack and nothing else, which says nothing about where in a suite of
  // two hundred checks the browser stopped answering, and the checks are only
  // reported at the end so none of them had been printed either.
  if (results.length) {
    const last = results[results.length - 1];
    console.error(
      `\nCrashed after ${results.length} check(s). ` +
        `The last one to run was "${last.group}: ${last.label}".`
    );
  } else {
    console.error('\nCrashed before the first check ran.');
  }
  console.error(err);
  process.exit(1);
});
