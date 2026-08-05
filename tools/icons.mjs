/**
 * Rasterise src/icons/icon.svg into the PNG sizes the browsers and stores ask
 * for.
 *
 * The PNGs are committed, so a normal build never runs this and ImageMagick is
 * not a build dependency. Run it only after editing the SVGs.
 *
 *   node tools/icons.mjs
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ICONS = path.join(ROOT, 'src', 'icons');

// 16/32/48/128 are Chrome's set, Firefox additionally uses 96 in the add-ons
// manager, and 256 is for store artwork.
//
// The two smallest come from their own simplified drawing. See the comment in
// icon-small.svg for why downscaling the full mark does not work.
const SIZES = [
  { size: 16, source: 'icon-small.svg' },
  { size: 32, source: 'icon-small.svg' },
  { size: 48, source: 'icon.svg' },
  { size: 96, source: 'icon.svg' },
  { size: 128, source: 'icon.svg' },
  { size: 256, source: 'icon.svg' },
];

async function main() {
  try {
    await run('magick', ['-version']);
  } catch {
    console.error(
      'ImageMagick ("magick") was not found. The committed PNGs in src/icons are\n' +
        'still valid; this tool is only needed if you changed the SVGs.'
    );
    process.exit(1);
  }

  for (const { size, source } of SIZES) {
    const out = path.join(ICONS, `icon-${size}.png`);
    await run('magick', [
      '-background',
      'none',
      path.join(ICONS, source),
      '-resize',
      `${size}x${size}`,
      // 8-bit RGBA keeps files small and avoids 16-bit PNGs, which some store
      // validators reject.
      '-depth',
      '8',
      '-define',
      'png:color-type=6',
      '-strip',
      out,
    ]);
    const { size: bytes } = await fs.stat(out);
    console.log(`icon-${size}.png  ${bytes} bytes  (${source})`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
