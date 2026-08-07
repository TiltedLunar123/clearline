/**
 * Store artwork.
 *
 * Renders the icon and the two promo tiles from the HTML in store/promo, at the
 * exact sizes the Chrome Web Store asks for, then gathers everything a listing
 * needs into one folder ready to drag into the form.
 *
 * Rendered through the browser rather than drawn with an image library for one
 * practical reason beyond control of the design: Chrome writes a captured page
 * as a 24 bit PNG with no alpha channel, which is precisely what the store
 * requires and what an exported SVG or a naive canvas dump does not give you.
 *
 *   node tools/promo.mjs [outputDir]
 *
 * Defaults to the sibling clearline-store-assets folder next to the repo.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CDP, httpJson, launchWithExtension, serveDir, shutdown, sleep } from './cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROMO = path.join(ROOT, 'store', 'promo');
const SHOTS = path.join(ROOT, 'store', 'screenshots');
const PORT = 9338;

const OUT =
  process.argv[2] || path.join(ROOT, '..', 'clearline-store-assets');

/**
 * `alpha` is the store's own split, not a preference. Promo tiles and
 * screenshots must have no alpha channel; the icon must have one, because the
 * 16px padding around its artwork is required to be transparent.
 */
const TILES = [
  { page: 'icon.html', file: 'icon-128.png', width: 128, height: 128, alpha: true },
  { page: 'small.html', file: 'promo-small-440x280.png', width: 440, height: 280 },
  { page: 'marquee.html', file: 'promo-marquee-1400x560.png', width: 1400, height: 560 },
];

/** Colour type 2 is truecolour, 6 is truecolour with an alpha channel. */
async function describe(file) {
  const b = await fs.readFile(file);
  const isPng = b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (!isPng) throw new Error(`${file} is not a PNG`);
  return {
    width: b.readUInt32BE(16),
    height: b.readUInt32BE(20),
    colourType: b[25],
    bytes: b.length,
  };
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const { server, port } = await serveDir(PROMO);

  let launched;
  const problems = [];
  try {
    launched = await launchWithExtension({
      port: PORT,
      dir: path.join(ROOT, 'dist', 'chrome'),
      width: 1500,
      height: 900,
    });
    const { webSocketDebuggerUrl } = await httpJson(PORT, '/json/version');
    const cdp = await CDP.connect(webSocketDebuggerUrl);

    for (const tile of TILES) {
      const { targetId } = await cdp.send('Target.createTarget', {
        url: `http://127.0.0.1:${port}/${tile.page}`,
      });
      const session = await cdp.attach(targetId);
      await cdp.send('Page.enable', {}, session);
      await cdp.send(
        'Emulation.setDeviceMetricsOverride',
        { width: tile.width, height: tile.height, deviceScaleFactor: 1, mobile: false },
        session
      );
      if (tile.alpha) {
        // Without this the browser paints its own opaque white behind the page
        // and the padding stops being transparent.
        await cdp.send(
          'Emulation.setDefaultBackgroundColorOverride',
          { color: { r: 0, g: 0, b: 0, a: 0 } },
          session
        );
      }
      await sleep(500);

      const { data } = await cdp.send(
        'Page.captureScreenshot',
        { format: 'png', captureBeyondViewport: false },
        session
      );
      const file = path.join(OUT, tile.file);
      await fs.writeFile(file, Buffer.from(data, 'base64'));
      await cdp.send('Target.closeTarget', { targetId }).catch(() => {});

      const info = await describe(file);
      if (info.width !== tile.width || info.height !== tile.height) {
        problems.push(`${tile.file} came out ${info.width}x${info.height}`);
      }
      const wanted = tile.alpha ? 6 : 2;
      if (info.colourType !== wanted) {
        problems.push(
          `${tile.file} has colour type ${info.colourType}, expected ${wanted}` +
            (tile.alpha ? ' (the icon padding must be transparent)' : ' (no alpha channel)')
        );
      }
      console.log(`  ${tile.file}  ${info.width}x${info.height}  ${(info.bytes / 1024).toFixed(0)} KB`);
    }
  } finally {
    server.close();
    await shutdown(launched);
  }

  // Screenshots are captured by tools/screenshots.mjs and only copied here, so
  // one folder holds everything the listing form asks for.
  const shots = (await fs.readdir(SHOTS)).filter((f) => f.endsWith('.png')).sort();
  for (const name of shots) {
    const from = path.join(SHOTS, name);
    const to = path.join(OUT, `screenshot-${name}`);
    await fs.copyFile(from, to);
    const info = await describe(to);
    if (info.width !== 1280 || info.height !== 800) {
      problems.push(`${name} is ${info.width}x${info.height}, the store wants 1280x800`);
    }
    if (info.colourType !== 2) {
      problems.push(`${name} has colour type ${info.colourType}, the store wants 2`);
    }
    console.log(`  screenshot-${name}  ${info.width}x${info.height}  ${(info.bytes / 1024).toFixed(0)} KB`);
  }

  if (shots.length === 0) problems.push('no screenshots found, run npm run shots first');
  if (shots.length > 5) problems.push(`${shots.length} screenshots, the store accepts at most 5`);

  if (problems.length) {
    console.error('\nProblems:\n' + problems.map((p) => `  x ${p}`).join('\n'));
    process.exit(1);
  }
  const flat = TILES.filter((t) => !t.alpha).length + shots.length;
  const clear = TILES.length - TILES.filter((t) => !t.alpha).length;
  console.log(
    `\n${flat} files are 24 bit PNG with no alpha, and ${clear} icon carries the transparent ` +
      'padding the store asks for. All at the required sizes.'
  );
  console.log(path.resolve(OUT));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
