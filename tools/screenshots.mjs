/**
 * Store screenshots.
 *
 * Drives the real built extension through its five steps against a mocked
 * Discord and captures each one. Same machinery as the end to end suite, for
 * the same reason: a screenshot assembled by hand is a promise about software
 * rather than a picture of it, and it stops being true the moment the UI moves.
 *
 * The data is invented. Nothing here touches a Discord account, which is also
 * why the shots can show a delete about to happen without anything being lost.
 *
 *   node tools/screenshots.mjs
 *
 * Output is 1280x800, the size the Chrome Web Store wants, into store/screenshots.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CDP,
  httpJson,
  launchWithExtension,
  mockApi,
  serveDir,
  shutdown,
  sleep,
  waitFor,
} from './cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9336;

/**
 * `node tools/screenshots.mjs [locale]`
 *
 * With no locale this writes the English set the store listing uses. With one
 * it writes into a subfolder instead, which is how a translation gets looked at
 * in the actual layout rather than only in a JSON file: German runs long and
 * Japanese runs short, and both can break a button that fits in English.
 */
const LOCALE = (process.argv[2] || '').trim();
const OUT = LOCALE
  ? path.join(ROOT, 'store', 'screenshots', LOCALE)
  : path.join(ROOT, 'store', 'screenshots');

const WIDTH = 1280;
const HEIGHT = 800;

const DISCORD_EPOCH = 1420070400000;
const idFor = (ms) => String(BigInt(ms - DISCORD_EPOCH) << 22n);

const ACCOUNT = { id: '111111111111111111', username: 'yourname', discriminator: '0' };

const GUILDS = [
  { id: '200000000000000001', name: 'Study Group' },
  { id: '200000000000000002', name: 'Indie Game Devs' },
  { id: '200000000000000003', name: 'Home Lab' },
  { id: '200000000000000004', name: 'Book Club' },
];

const CHANNELS = [
  { id: '300000000000000001', name: 'general', type: 0, position: 0 },
  { id: '300000000000000002', name: 'help', type: 0, position: 1 },
  { id: '300000000000000003', name: 'off-topic', type: 0, position: 2 },
  { id: '300000000000000004', name: 'resources', type: 0, position: 3 },
];

const DMS = [
  { id: '400000000000000001', type: 1, recipients: [{ id: '5', username: 'alex' }] },
  { id: '400000000000000002', type: 1, recipients: [{ id: '6', username: 'sam' }] },
];

/** Ordinary chatter, so the shots look like a real account rather than lorem. */
const LINES = [
  'sorry, I misread that. the second one is right',
  'sorry for the wall of text earlier',
  'no worries, sorry I missed this',
  'sorry, wrong channel',
  'ah sorry, I had the old version pinned',
  'sorry, that link is dead now. reposting below',
  'sorry to bump this, still stuck on the same step',
  'sorry! meant to send that to alex',
  'sorry, I was wrong about the deadline',
  'sorry for the delay, was travelling all week',
  'sorry, one more question about the setup',
  'sorry, I keep typing the wrong command',
];

function messages() {
  const base = Date.UTC(2025, 10, 14, 19, 30, 0);
  return LINES.map((content, i) => ({
    id: idFor(base - i * 3600000 * 7),
    channel_id: CHANNELS[i % 3].id,
    author: ACCOUNT,
    timestamp: new Date(base - i * 3600000 * 7).toISOString(),
    content,
    attachments: [],
    embeds: [],
    pinned: false,
    type: 0,
  }));
}

const OK_HEADERS = {
  'X-RateLimit-Bucket': 'shot',
  'X-RateLimit-Remaining': '9',
  'X-RateLimit-Reset-After': '1',
};

function mock() {
  const all = messages();
  return (method, pathname) => {
    const p = pathname.split('?')[0];
    const params = new URLSearchParams(pathname.split('?')[1] || '');

    if (/^\/api\/v9\/guilds\/\d+\/channels$/.test(p)) return { body: CHANNELS, headers: OK_HEADERS };
    if (/^\/api\/v9\/guilds\/\d+\/messages\/search$/.test(p)) {
      const offset = Number(params.get('offset') || 0);
      const page = all.slice(offset, offset + 25);
      return {
        body: { total_results: all.length, messages: page.map((m) => [{ ...m, hit: true }]) },
        headers: OK_HEADERS,
      };
    }
    if (p.startsWith('/api/v9/users/@me/guilds')) return { body: GUILDS, headers: OK_HEADERS };
    if (p.startsWith('/api/v9/users/@me/channels')) return { body: DMS, headers: OK_HEADERS };
    if (p.startsWith('/api/v9/users/@me')) return { body: ACCOUNT, headers: OK_HEADERS };
    return { status: 404, body: {} };
  };
}

async function buildVariant() {
  const from = path.join(ROOT, 'dist', 'chrome');
  const to = path.join(ROOT, 'dist', 'shots');
  await fs.rm(to, { recursive: true, force: true });
  await fs.cp(from, to, { recursive: true });

  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const digest = crypto.createHash('sha256').update(der).digest();
  let id = '';
  for (let i = 0; i < 16; i++) {
    id += String.fromCharCode(97 + (digest[i] >> 4));
    id += String.fromCharCode(97 + (digest[i] & 0x0f));
  }

  // Pointed at the local fixture as well as Discord, exactly as the end to end
  // suite does, so Connect has a signed in tab to read a session from without
  // any real account being involved.
  const file = path.join(to, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
  manifest.key = der.toString('base64');
  manifest.host_permissions = ['*://discord.com/*', 'http://127.0.0.1/*'];
  manifest.content_scripts[0].matches = ['http://127.0.0.1/*'];
  await fs.writeFile(file, JSON.stringify(manifest, null, 2));
  return { dir: to, extensionId: id };
}

/**
 * Wait until the page has stopped moving.
 *
 * Steps and their contents animate in on a stagger, so for the third of a
 * second after a step opens some of it is still partly transparent. The sleeps
 * around the calls to this file were tuned when nothing animated, and a store
 * screenshot of a half-faded panel looks like a rendering bug rather than a
 * product. Asking the page which animations are still running beats guessing at
 * a number that has to be re-guessed every time a duration changes.
 *
 * Capped, because an intentionally endless animation would otherwise hang the
 * run: the indeterminate search bar sweeps for as long as it is on screen.
 */
async function settle(cdp, session, capMs = 1200) {
  const until = Date.now() + capMs;
  for (;;) {
    const running = await cdp.evaluate(
      session,
      "document.getAnimations().filter((a) => a.playState === 'running').length"
    );
    if (Number(running) === 0 || Date.now() > until) return;
    await sleep(50);
  }
}

async function shoot(cdp, session, name) {
  await settle(cdp, session);
  const { data } = await cdp.send(
    'Page.captureScreenshot',
    { format: 'png', captureBeyondViewport: false },
    session
  );
  const file = path.join(OUT, `${name}.png`);
  await fs.writeFile(file, Buffer.from(data, 'base64'));
  console.log(`  ${path.relative(ROOT, file)}`);
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const { dir, extensionId } = await buildVariant();

  const { server, port: filePort } = await serveDir(path.join(ROOT, 'test-pages'));

  let launched;
  try {
    launched = await launchWithExtension({
      port: PORT,
      dir,
      width: WIDTH,
      height: HEIGHT,
      lang: LOCALE || undefined,
    });
    const { webSocketDebuggerUrl } = await httpJson(PORT, '/json/version');
    const cdp = await CDP.connect(webSocketDebuggerUrl);

    // The fixture holds a token in localStorage the way Discord does. Opened
    // first, so the session is there before Connect is clicked.
    const fixture = await cdp.send('Target.createTarget', {
      url: `http://127.0.0.1:${filePort}/fake-discord.html`,
    });
    await cdp.attach(fixture.targetId);
    await sleep(800);

    const appUrl = `chrome-extension://${extensionId}/app/app.html`;
    // No width or height here. Chrome refuses a size on a tab that is not a new
    // window, so the viewport is set with Emulation instead, which is also what
    // makes the capture exactly the size the store wants.
    const { targetId } = await cdp.send('Target.createTarget', { url: appUrl });
    const session = await cdp.attach(targetId);
    await cdp.send('Page.enable', {}, session);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: WIDTH,
      height: HEIGHT,
      deviceScaleFactor: 1,
      mobile: false,
    }, session);

    await mockApi(cdp, session, mock());
    await sleep(600);

    console.log('capturing:');
    await shoot(cdp, session, '1-connect');

    await cdp.evaluate(session, "document.getElementById('connect').click()");
    await waitFor('the where step', async () =>
      (await cdp.evaluate(
        session,
        "!document.getElementById('step-where').classList.contains('hidden')"
      )) === true
    );
    await cdp.evaluate(
      session,
      `(() => {
        const s = document.getElementById('guild-select');
        s.value = '${GUILDS[0].id}';
        s.dispatchEvent(new Event('change'));
      })()`
    );
    await waitFor('channels', async () =>
      (await cdp.evaluate(session, "document.getElementById('channel-select').options.length")) > 1
    );
    await sleep(300);
    await shoot(cdp, session, '2-where');

    await cdp.evaluate(session, "document.getElementById('where-next').click()");
    await sleep(300);
    await cdp.evaluate(
      session,
      `(() => {
        document.getElementById('f-contains').value = 'sorry';
        document.getElementById('f-after').value = '2025-01-01';
      })()`
    );
    await sleep(200);
    await shoot(cdp, session, '3-narrow');

    await cdp.evaluate(session, "document.getElementById('search').click()");
    // Waited on structure rather than on words. Matching the heading text meant
    // this only ever worked in English, which is exactly the run where looking
    // at the layout matters least.
    await waitFor('review', async () => {
      const rows = await cdp.evaluate(
        session,
        "document.querySelectorAll('#results-body tr').length"
      );
      return rows > 0 ? rows : null;
    });
    // Opened for the picture. It is folded away by default because most visits
    // to this screen are about the table under it, but a store screenshot of a
    // closed grey bar shows nothing, and being able to keep one channel out of
    // a server-wide sweep is the reason somebody would install this over the
    // alternatives.
    await cdp.evaluate(
      session,
      "(() => { const d = document.getElementById('channel-block'); if (d) d.open = true; })()"
    );
    await sleep(400);
    await shoot(cdp, session, '4-review');

    await cdp.evaluate(session, "document.getElementById('review-next').click()");
    await sleep(400);
    await shoot(cdp, session, '5-act');

    console.log(`\n${WIDTH}x${HEIGHT}, ready for the store listing.`);
  } finally {
    server.close();
    await shutdown(launched);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
