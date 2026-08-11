/**
 * Clearline build.
 *
 * Produces dist/chrome and dist/firefox from one source tree, and optionally
 * zips them for store upload. There is no bundler: shared library files are
 * plain classic scripts that hang off a `CL` global, and this script
 * concatenates them into one background script per target so the Chrome service
 * worker and the Firefox event page run identical, module-free code.
 *
 *   node tools/build.mjs           build both targets
 *   node tools/build.mjs --zip     build, then write store zips
 *   node tools/build.mjs --check   build, then run the release gate
 */

import { execFile as execFileCb } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { deflateRaw } from 'node:zlib';
import { promisify } from 'node:util';

const deflate = promisify(deflateRaw);
const execFile = promisify(execFileCb);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');

const TARGETS = ['chrome', 'firefox'];

/** Concatenated in order into background.js. Order matters: no forward refs. */
const BACKGROUND_MODULES = ['lib/browser.js', 'background.main.js'];

/** Copied verbatim. `lib` ships too, because the app page loads it directly. */
const STATIC_DIRS = ['content', 'lib'];
const OPTIONAL_DIRS = ['app', 'icons'];

const ALLOWED_PERMISSIONS = ['storage', 'unlimitedStorage', 'downloads'];

/**
 * The one host this extension may ever touch.
 *
 * Discrub-style tools are reviewed suspiciously because they read an auth token
 * out of a first party site, and the only durable answer to that is a permission
 * surface narrow enough to audit in one glance. A wildcard host here would be
 * indefensible on review no matter what the code does, so the build refuses to
 * produce one rather than trusting anyone to remember.
 */
const ALLOWED_HOSTS = ['*://discord.com/*'];

/**
 * Files permitted to make network calls, and the only hosts they may name.
 *
 * Inverted from the usual gate. Talking to Discord is the product, so the rule
 * is not "no network", it is "network from exactly one reviewable module, to
 * exactly one origin". Anything else is either a bug or an exfiltration path,
 * and both should fail the build rather than ship.
 */
const NETWORK_ALLOWED_FILES = ['lib/api.js'];
const ALLOWED_FETCH_HOSTS = ['discord.com', 'cdn.discordapp.com', 'media.discordapp.net'];

/**
 * Hosts allowed to appear as a link the user can click, and nothing more.
 *
 * Separate from the fetch list on purpose. An anchor the user chooses to follow
 * and a connection the extension opens by itself are different risks, and
 * collapsing them into one list would mean either refusing to ever link
 * anywhere, or quietly granting a support page the same standing as the API.
 *
 * The separation is enforced below: a host in this list is still rejected
 * inside the one file permitted to open a connection, so a link host can never
 * become a fetch target.
 */
const ALLOWED_LINK_HOSTS = ['buymeacoffee.com'];

const MAX_DESCRIPTION = 132;
const MAX_NAME = 75;

/**
 * `externally_connectable` would let a web page drive the extension, which on a
 * tool holding a Discord token is the worst possible hole. Never declare it.
 *
 * The rest are here because the permission checks below read `permissions` and
 * `host_permissions` and nothing else, so every one of these was a way to widen
 * the extension's reach while the gate printed "permissions, single host".
 * `optional_host_permissions: ["<all_urls>"]` would have shipped clean.
 */
const FORBIDDEN_MANIFEST_KEYS = [
  'externally_connectable',
  'declarative_net_request',
  'optional_permissions',
  'optional_host_permissions',
  'web_accessible_resources',
  'content_security_policy',
];

const args = new Set(process.argv.slice(2));

async function rmrf(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function copyDir(from, to, keep) {
  await fs.mkdir(to, { recursive: true });
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    const s = path.join(from, entry.name);
    const d = path.join(to, entry.name);
    if (entry.isDirectory()) await copyDir(s, d, keep);
    else if (!keep || keep(entry.name)) await fs.copyFile(s, d);
  }
}

/**
 * Chrome and Firefox diverge in exactly two places: how the background script is
 * declared, and Firefox's requirement for an explicit add-on id. Expressing that
 * here beats maintaining two manifests that drift apart.
 */
function manifestFor(target, base) {
  const m = structuredClone(base);
  if (target === 'chrome') {
    m.background = { service_worker: 'background.js' };
  } else {
    // Firefox MV3 uses a non-persistent event page, not a service worker.
    m.background = { scripts: ['background.js'] };
    m.browser_specific_settings = {
      gecko: {
        id: 'clearline@tiltedlunar.dev',
        // AMO requires data_collection_permissions on new submissions, which
        // landed in 140. Declaring "none" is also the honest answer: nothing
        // leaves the machine.
        strict_min_version: '140.0',
        data_collection_permissions: { required: ['none'] },
      },
      gecko_android: { strict_min_version: '142.0' },
    };
  }
  return m;
}

async function buildBackground() {
  const parts = [
    '/* Clearline background bundle. Generated by tools/build.mjs - do not edit. */',
    "'use strict';",
  ];
  for (const rel of BACKGROUND_MODULES) {
    const code = await fs.readFile(path.join(SRC, rel), 'utf8');
    parts.push(`\n/* ---- ${rel} ---- */\n${code}`);
  }
  return parts.join('\n');
}

async function buildTarget(target, base, background) {
  const out = path.join(DIST, target);
  await rmrf(out);
  await fs.mkdir(out, { recursive: true });

  // Only the icons the manifest actually names. src/icons also holds the two
  // SVG masters that tools/icons.mjs rasterises from and a 256 for store
  // listings, none of which the extension ever loads, so shipping them just put
  // three unreferenced files into both uploads.
  const wanted = new Set(Object.values(base.icons || {}).map((rel) => path.posix.basename(rel)));
  const keepIcon = (name) => wanted.has(name);

  for (const dir of [...STATIC_DIRS, ...OPTIONAL_DIRS]) {
    const from = path.join(SRC, dir);
    if (!(await exists(from))) continue;
    await copyDir(from, path.join(out, dir), dir === 'icons' ? keepIcon : null);
  }
  await fs.writeFile(path.join(out, 'background.js'), background);
  await fs.writeFile(
    path.join(out, 'manifest.json'),
    JSON.stringify(manifestFor(target, base), null, 2) + '\n'
  );
  return out;
}

/* ------------------------------------------------------------------ */
/* Release gate                                                        */
/* ------------------------------------------------------------------ */

async function check(base) {
  const problems = [];
  const pkgVersion = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8')).version;

  for (const target of TARGETS) {
    const dir = path.join(DIST, target);
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'));
    const tag = `[${target}]`;

    for (const p of manifest.permissions ?? []) {
      if (!ALLOWED_PERMISSIONS.includes(p)) problems.push(`${tag} unexpected permission "${p}"`);
      if (p.includes('://') || p === '<all_urls>') {
        problems.push(`${tag} host permission "${p}" must be declared in host_permissions`);
      }
    }

    const hosts = manifest.host_permissions ?? [];
    for (const h of hosts) {
      if (!ALLOWED_HOSTS.includes(h)) problems.push(`${tag} host permission "${h}" is not allowed`);
    }
    if (hosts.length === 0) problems.push(`${tag} host_permissions missing; the API is unreachable`);

    // A content script on anything wider than Discord would be reading pages it
    // has no business reading, and reviewers check this before they read code.
    for (const cs of manifest.content_scripts ?? []) {
      for (const m of cs.matches ?? []) {
        if (!ALLOWED_HOSTS.includes(m)) problems.push(`${tag} content script matches "${m}"`);
      }
      if (cs.world === 'MAIN') {
        // Page-context injection is not needed: an isolated content script
        // already reads the same origin's localStorage, and MAIN world means
        // Discord's own code could reach in and tamper with the handoff.
        problems.push(`${tag} content script must not run in the MAIN world`);
      }
    }

    for (const key of FORBIDDEN_MANIFEST_KEYS) {
      if (key in manifest) problems.push(`${tag} manifest must not declare "${key}"`);
    }

    // Compared against package.json, not against `base`. `manifest` is built
    // from `base` a few lines above, so the old check compared a value with
    // itself and could not fail under any circumstances. The version that
    // matters is the one two stores read off the package while the changelog and
    // the release zips are named from package.json.
    if (manifest.version !== pkgVersion) {
      problems.push(`${tag} manifest version ${manifest.version} does not match package.json ${pkgVersion}`);
    }

    if ((manifest.description ?? '').length > MAX_DESCRIPTION) {
      problems.push(
        `${tag} description is ${manifest.description.length} characters, ` +
          `over the store limit of ${MAX_DESCRIPTION}`
      );
    }
    if ((manifest.name ?? '').length > MAX_NAME) {
      problems.push(`${tag} name is ${manifest.name.length} characters, over the limit of ${MAX_NAME}`);
    }

    for (const [size, rel] of Object.entries(manifest.icons ?? {})) {
      const file = path.join(dir, rel);
      let buf;
      try {
        buf = await fs.readFile(file);
      } catch {
        problems.push(`${tag} icon ${size} missing: ${rel}`);
        continue;
      }
      const isPng = buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      if (!isPng) {
        problems.push(`${tag} icon ${size} is not a PNG: ${rel}`);
        continue;
      }
      // PNG IHDR carries width and height as big-endian uint32 at 16 and 20.
      const w = buf.readUInt32BE(16);
      const h = buf.readUInt32BE(20);
      if (w !== Number(size) || h !== Number(size)) {
        problems.push(`${tag} icon ${size} is ${w}x${h}, expected ${size}x${size}`);
      }
    }

    for (const cs of manifest.content_scripts ?? []) {
      for (const rel of cs.js ?? []) {
        if (!(await exists(path.join(dir, rel)))) {
          problems.push(`${tag} missing content script: ${rel}`);
        }
      }
    }

    // Every shipped script, not just the background bundle. The app page and the
    // content script run with the same privileges and hold the same token, so
    // reading one file and printing "no remote code" was a claim about a third
    // of the package.
    await walk(dir, async (file) => {
      if (!file.endsWith('.js')) return;
      const where = path.relative(dir, file).split(path.sep).join('/');
      const code = blankCommentsAndStrings(await fs.readFile(file, 'utf8'));
      for (const banned of ['importScripts(', 'eval(', 'new Function(']) {
        if (code.includes(banned)) problems.push(`${tag} ${where} uses forbidden "${banned}"`);
      }
    });

    // The extension page pulls its own scripts and styles by relative path, and
    // nothing checked they exist. Renaming app.css shipped a page with no
    // styles and a green gate.
    const page = path.join(dir, 'app', 'app.html');
    if (await exists(page)) {
      const html = await fs.readFile(page, 'utf8');
      const refs = [
        ...html.matchAll(/<script[^>]+src=("|')([^"']+)\1/gi),
        ...html.matchAll(/<link[^>]+href=("|')([^"']+)\1/gi),
      ].map((m) => m[2]);
      for (const ref of refs) {
        if (/^(https?:)?\/\//i.test(ref)) {
          problems.push(`${tag} app.html references a remote asset: ${ref}`);
          continue;
        }
        if (!(await exists(path.resolve(path.dirname(page), ref)))) {
          problems.push(`${tag} app.html references a missing file: ${ref}`);
        }
      }
    }
  }

  /*
   * Network gate.
   *
   * Two rules, both about the token. Only the API module may open a connection,
   * and every literal host it names must be Discord. That is what makes "your
   * token never leaves the browser" a claim the build enforces instead of a
   * sentence in a listing.
   */
  await walk(SRC, async (file) => {
    // CSS is in the list because it is shipped, it is fetched by the extension
    // page, and it can name a host: `background-image: url(https://...)` and a
    // top-of-file `@import` both reach the network from a privileged page. The
    // scan filtered on .js and .html, so a third-party URL in app.css passed
    // both "no remote code" and "network confined to Discord" and printed both.
    if (!/\.(js|html|css|json)$/.test(file)) return;
    const rel = path.relative(SRC, file).split(path.sep).join('/');
    const text = await fs.readFile(file, 'utf8');
    // Comments and string literals are blanked first, so prose that mentions an
    // API does not fail a file that never calls it.
    const code = /\.(js|html)$/.test(file) ? blankCommentsAndStrings(text) : text;

    if (!NETWORK_ALLOWED_FILES.includes(rel)) {
      for (const m of code.matchAll(/\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\s*\(/g)) {
        const line = code.slice(0, m.index).split('\n').length;
        problems.push(`network call outside the API module -> ${rel}:${line} ${m[1]}(`);
      }
    }

    // Hosts are read from the original text, since blanking removed the strings.
    // The file that may open a connection is held to the fetch list alone, so a
    // host approved only for linking cannot turn into a request from there.
    const permitted = NETWORK_ALLOWED_FILES.includes(rel)
      ? ALLOWED_FETCH_HOSTS
      : ALLOWED_FETCH_HOSTS.concat(ALLOWED_LINK_HOSTS);

    for (const m of text.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) {
      const host = m[1].toLowerCase();
      if (!permitted.includes(host)) {
        const line = text.slice(0, m.index).split('\n').length;
        problems.push(`host not allowed in shipped source -> ${rel}:${line} ${host}`);
      }
    }

    // A link host is only ever a link. If one shows up in an anchor without the
    // tab isolation, or as anything other than an href, that is worth failing.
    for (const host of ALLOWED_LINK_HOSTS) {
      if (!text.includes(host)) continue;
      const anchors = text.match(new RegExp(`<a[^>]*${host.replace('.', '\\.')}[^>]*>`, 'gi')) || [];
      for (const anchor of anchors) {
        if (!/rel=("|')[^"']*noopener/i.test(anchor) || !/rel=("|')[^"']*noreferrer/i.test(anchor)) {
          problems.push(`link to ${host} in ${rel} must carry rel="noopener noreferrer"`);
        }
        if (!/target=("|')_blank\1/i.test(anchor)) {
          problems.push(`link to ${host} in ${rel} must open in a new tab`);
        }
      }
    }
  });

  // Every shipped script must parse. A syntax error in a content script is
  // invisible until a user hits the flow it was supposed to serve, and the
  // background is concatenated from several files, so a stray brace in one of
  // them takes out the whole worker rather than the file it came from.
  //
  // Compiled, not just scanned. This used to check for control characters and
  // say it checked syntax, which is a comment that reads as a guarantee and is
  // not one. vm.Script compiles without running, which is exactly the question
  // being asked, and it parses classic scripts, which is what ships.
  for (const target of TARGETS) {
    await walk(path.join(DIST, target), async (file) => {
      if (!file.endsWith('.js')) return;
      const source = await fs.readFile(file, 'utf8');
      const where = path.relative(ROOT, file);
      // eslint-disable-next-line no-control-regex
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(source)) {
        problems.push(`[${target}] control characters in ${where}`);
      }
      try {
        new vm.Script(source, { filename: file });
      } catch (err) {
        problems.push(`[${target}] ${where} does not parse: ${err.message}`);
      }
    });
  }

  if (problems.length) {
    console.error('\nRelease gate FAILED:\n' + problems.map((p) => `  x ${p}`).join('\n') + '\n');
    process.exit(1);
  }
  console.log(
    'Release gate passed: permissions, single host, no MAIN world, store field limits, icons, ' +
      'content scripts, no remote code, network confined to the API module and Discord hosts.'
  );
}

/**
 * Words after which a `/` opens a regular expression rather than dividing.
 *
 * Everything else that can precede a slash is either a value, in which case the
 * slash is division, or punctuation, in which case it opens a regex.
 */
const REGEX_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'case', 'do', 'else', 'yield', 'await', 'throw',
]);

/**
 * Decide whether the slash at `at` starts a regex literal or is a division.
 *
 * Only the previous significant character can tell them apart. After a closing
 * bracket or a plain value the slash divides; after punctuation or one of the
 * keywords above it opens a literal.
 */
function opensRegex(source, at) {
  let k = at - 1;
  while (k >= 0 && /\s/.test(source[k])) k--;
  if (k < 0) return true;
  const c = source[k];
  if (c === ')' || c === ']') return false;
  if (/[A-Za-z0-9_$]/.test(c)) {
    const end = k + 1;
    while (k >= 0 && /[A-Za-z0-9_$]/.test(source[k])) k--;
    return REGEX_KEYWORDS.has(source.slice(k + 1, end));
  }
  return true;
}

/**
 * Replace comments, string/template literals and regex literals with spaces,
 * preserving byte offsets and newlines so reported line numbers stay accurate.
 *
 * A scanner rather than a regex, because a regex cannot tell a comment from a
 * `//` inside a URL string, and getting that wrong either hides a real call or
 * blocks a clean build.
 *
 * Regex literals have to be recognised, not walked past. A pattern like
 * /["']/ is ordinary code, and skipping it leaves the scanner staring at a
 * quote with no pair on the line, so it blanks everything after it and any
 * call on the rest of that line vanishes from the gate. That is not a
 * hypothetical: a fetch() planted in the app page, in a file the gate exists to
 * keep away from the network, passed a full release check that way.
 */
function blankCommentsAndStrings(source) {
  const out = source.split('');
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k++) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  };

  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);

    if (two === '//') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (two === '/*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }

    const ch = source[i];

    if (ch === '/' && opensRegex(source, i)) {
      let j = i + 1;
      let inClass = false;
      while (j < source.length) {
        const c = source[j];
        if (c === '\\') {
          j += 2;
          continue;
        }
        // An unterminated literal is a misread, not a regex spanning lines.
        // Stopping at the newline keeps the damage to one line either way.
        if (c === '\n') break;
        if (inClass) {
          if (c === ']') inClass = false;
        } else if (c === '[') {
          // A slash inside a character class is a literal slash, not the end.
          inClass = true;
        } else if (c === '/') {
          break;
        }
        j++;
      }
      blank(i + 1, j);
      i = j + 1;
      continue;
    }

    // A template literal is not one string. The parts between `${` and `}` are
    // ordinary code, and blanking the literal whole hid them: a fetch() written
    // inside a substitution was invisible to the gate that exists to find
    // exactly that. So the literal text is blanked and each substitution is run
    // back through this same scanner, which also handles a string or a nested
    // template inside one.
    if (ch === '`') {
      let j = i + 1;
      let literalFrom = i + 1;
      while (j < source.length) {
        const c = source[j];
        if (c === '\\') {
          j += 2;
          continue;
        }
        if (c === '`') break;
        if (c === '$' && source[j + 1] === '{') {
          blank(literalFrom, j);
          const from = j + 2;
          const to = matchingBrace(source, from);
          const inner = blankCommentsAndStrings(source.slice(from, to));
          for (let k = 0; k < inner.length; k++) out[from + k] = inner[k];
          j = to + 1;
          literalFrom = j;
          continue;
        }
        j++;
      }
      blank(literalFrom, j);
      i = j + 1;
      continue;
    }

    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === '\\') {
          j += 2;
          continue;
        }
        if (source[j] === ch) break;
        // An unterminated single quote is almost certainly an apostrophe in
        // prose; stop at the newline rather than eating the rest of the file.
        if (source[j] === '\n') break;
        j++;
      }
      blank(i + 1, j);
      i = j + 1;
      continue;
    }
    i++;
  }
  return out.join('');
}

/**
 * Index of the `}` closing a substitution that starts at `from`.
 *
 * Quoted spans are stepped over so a brace inside a string does not close it.
 * When it cannot tell, it runs to the end of the file, which leaves more code
 * visible to the scan rather than less: this gate should fail loudly rather than
 * quietly pass something it did not understand.
 */
function matchingBrace(source, from) {
  let depth = 1;
  let k = from;
  while (k < source.length) {
    const c = source[k];
    if (c === '\\') {
      k += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      k = endOfQuoted(source, k);
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return k;
    k++;
  }
  return source.length;
}

/** Index just past the quote closing the span opened at `at`. */
function endOfQuoted(source, at) {
  const quote = source[at];
  let k = at + 1;
  while (k < source.length) {
    const c = source[k];
    if (c === '\\') {
      k += 2;
      continue;
    }
    if (c === quote) return k + 1;
    if (c === '\n' && quote !== '`') return k;
    // A nested template's own substitutions can carry braces, so they are
    // stepped over here too rather than counted by the caller.
    if (quote === '`' && c === '$' && source[k + 1] === '{') {
      k = matchingBrace(source, k + 2) + 1;
      continue;
    }
    k++;
  }
  return source.length;
}

async function walk(dir, fn) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, fn);
    else await fn(full);
  }
}

/* ------------------------------------------------------------------ */
/* Zip writer (store upload format, no dependencies)                   */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Minimal deflate zip, so packaging a release needs no dependency. */
async function writeZip(sourceDir, zipPath) {
  const files = [];
  await walk(sourceDir, async (full) => {
    files.push({
      name: path.relative(sourceDir, full).split(path.sep).join('/'),
      data: await fs.readFile(full),
    });
  });
  files.sort((a, b) => a.name.localeCompare(b.name));

  const chunks = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const crc = crc32(f.data);
    const compressed = await deflate(f.data, { level: 9 });
    const useDeflate = compressed.length < f.data.length;
    const body = useDeflate ? compressed : f.data;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12); // deterministic date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(f.data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  await fs.writeFile(zipPath, Buffer.concat([...chunks, centralBuf, end]));
  return files.length;
}

/**
 * The source archive Firefox asks for.
 *
 * AMO requires source whenever the uploaded package is not what the developer
 * wrote, and concatenating the background script counts. It was a hand run
 * command living in a note, which is the kind of step that gets forgotten on
 * the one release nobody is paying attention to, and forgetting it does not
 * fail loudly: the upload succeeds and review stalls.
 *
 * git archive rather than zipping the working tree, so what a reviewer builds
 * from is exactly what is committed. That matters more than it sounds: this
 * machine checks out CRLF while git stores LF, so a zip of the working tree
 * would differ from a fresh clone by invisible bytes and the reviewer's build
 * would not match the upload.
 */
async function writeSourceZip(version) {
  const out = path.join(ROOT, 'release', `clearline-source-v${version}.zip`);
  try {
    // The packages beside this archive are built from the working tree and this
    // archive is HEAD, so an uncommitted change means a reviewer building from
    // the source cannot reproduce the upload. Said out loud rather than left to
    // be discovered during review, which is where it would otherwise surface.
    const { stdout } = await execFile('git', ['status', '--porcelain'], { cwd: ROOT });
    if (stdout.trim()) {
      console.log('WARNING: the working tree has uncommitted changes, so the source zip (HEAD) does not match the packages.');
    }
  } catch {
    // No repository. The next call reports that properly.
  }
  try {
    await execFile(
      'git',
      ['archive', '--format=zip', `--prefix=clearline-${version}/`, '-o', out, 'HEAD'],
      { cwd: ROOT }
    );
    console.log(`zipped source -> ${path.relative(ROOT, out)}`);
  } catch (err) {
    // Building from an extracted archive has no repository to read, which is a
    // reviewer doing exactly the right thing. Say so rather than failing.
    console.log(`skipped the source zip, no git repository here (${err.code || 'failed'})`);
  }
}

/* ------------------------------------------------------------------ */

async function main() {
  const base = JSON.parse(await fs.readFile(path.join(SRC, 'manifest.base.json'), 'utf8'));
  const background = await buildBackground();

  for (const target of TARGETS) {
    const out = await buildTarget(target, base, background);
    console.log(`built ${target} -> ${path.relative(ROOT, out)}`);
  }

  // Before the zips, not after and not on a separate flag. --zip and --check
  // were independent branches and package.json mapped `zip` to --zip alone, so
  // the artifacts actually uploaded to two stores were the one output nothing
  // verified. README presents this gate as the enforcement mechanism, so the
  // path that produces the upload is the path that most needs to run it.
  if (args.has('--zip') || args.has('--check')) await check(base);

  if (args.has('--zip')) {
    await fs.mkdir(path.join(ROOT, 'release'), { recursive: true });
    for (const target of TARGETS) {
      const zip = path.join(ROOT, 'release', `clearline-${target}-v${base.version}.zip`);
      const n = await writeZip(path.join(DIST, target), zip);
      console.log(`zipped ${target} (${n} files) -> ${path.relative(ROOT, zip)}`);
    }
    await writeSourceZip(base.version);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
