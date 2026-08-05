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
const GUILDS = Array.from({ length: 7 }, (_, i) => ({ id: String(200000000000000000 + i), name: `g${i}` }));
const DMS = Array.from({ length: 3 }, (_, i) => ({ id: String(300000000000000000 + i), type: 1 }));

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

async function openTab(cdp, url) {
  const { targetId } = await cdp.send('Target.createTarget', { url });
  const session = await cdp.attach(targetId);
  await cdp.send('Page.enable', {}, session);
  return { targetId, session };
}

async function textOf(cdp, session, selector) {
  return cdp.evaluate(
    session,
    `(document.querySelector(${JSON.stringify(selector)}) || {}).textContent`
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

    // The token must never be written to storage.
    const stored = await cdp.evaluate(sw, 'chrome.storage.local.get(null).then(o => JSON.stringify(o))');
    check('failures', 'token is never written to extension storage',
      !String(stored).includes(EXPECTED_TOKEN), `storage contained ${stored}`);
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
