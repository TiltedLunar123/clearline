/**
 * The scanner the release gate sees through.
 *
 * Everything the gate claims about shipped source runs on the output of this
 * one function: no eval, no importScripts, no new Function, and no network call
 * outside the API module. If it blanks code it should have left visible, all
 * four claims quietly become claims about a shorter file, and a build with a
 * hole in it looks exactly like a clean one. That has now happened twice, both
 * times through a regex literal the scanner failed to recognise, so the cases
 * are pinned here rather than left to be rediscovered.
 *
 * Read as: "code the gate must still be able to see".
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { scanSource, blankCommentsAndStrings, opensRegex } from '../tools/build.mjs';

/** Everything the gate greps for, so one helper covers all of them. */
const BANNED = ['eval(', 'new Function(', 'importScripts(', 'fetch('];

function sees(source, needle) {
  return blankCommentsAndStrings(source).includes(needle);
}

test('a regex literal after an if condition does not hide the rest of the line', () => {
  // The shape that shipped. `)` was read as a value, so the slash was taken for
  // division, the scanner walked into the pattern, met the quote inside it, and
  // blanked to end of line. A planted eval() on that line passed a full release
  // check that printed "no remote code".
  const line =
    `if (a) /['"]/.test(b); eval('1+1'); fetch(u); new Function('x'); importScripts('y');`;
  for (const banned of BANNED) {
    assert.ok(sees(line, banned), `the gate must still see ${banned}`);
  }
});

test('the same for while, for, switch and catch heads', () => {
  const heads = [
    `while (x) /['"]/.test(b); eval(1);`,
    `for (;;) /['"]/.exec(s); eval(1);`,
    `switch (v) { default: /['"]/.test(b); eval(1); }`,
    `try { g(); } catch (e) { /['"]/.test(b); eval(1); }`,
  ];
  for (const source of heads) {
    assert.ok(sees(source, 'eval('), `hidden by: ${source}`);
  }
});

test('division after a call or an index is still division, not a regex', () => {
  // The other half of the ambiguity, and the reason `)` cannot simply be
  // treated as punctuation. Getting this wrong the other way would make the
  // scanner eat live code as though it were a pattern.
  assert.ok(sees('const r = arr[0] / 2; fetch(u);', 'fetch('));
  assert.ok(sees('const y = f(1) / 2; fetch(u);', 'fetch('));
  assert.ok(sees('const z = (a + b) / 2; fetch(u);', 'fetch('));
  assert.ok(sees('const w = total(x) / count(y); fetch(u);', 'fetch('));
});

test('a return, a keyword or punctuation still opens a regex', () => {
  assert.equal(opensRegex('return /x/', 7, null), true);
  assert.equal(opensRegex('typeof /x/', 7, null), true);
  assert.equal(opensRegex('a = /x/', 4, null), true);
  assert.equal(opensRegex('x / y', 2, null), false, 'a plain value divides');
});

test('a call inside a template substitution is not hidden by the template', () => {
  const source = 'const u = `${fetch(evil)}`;';
  assert.ok(sees(source, 'fetch('), 'substitutions are code, not literal text');
});

test('a call inside a nested template substitution is not hidden either', () => {
  const source = 'const u = `${`${eval(x)}`}`;';
  assert.ok(sees(source, 'eval('));
});

test('prose in a comment or a string is not mistaken for a call', () => {
  // The other direction: the gate has to be usable. A file that talks about
  // fetch must not fail for talking about it.
  assert.ok(!sees('// we never call fetch(url) here\nconst a = 1;', 'fetch('));
  assert.ok(!sees(`const doc = "call eval( if you like";`, 'eval('));
  assert.ok(!sees('/* eval( in a block comment */', 'eval('));
});

test('a span the scanner cannot close is reported rather than absorbed', () => {
  // The durable half of the fix. Every blanked span ends at a delimiter the
  // scanner recognises; one ending at a newline means it misread the code, and
  // a misread is precisely how something invisible gets through. A gate that
  // cannot read a file has to fail on it, not pass it.
  const unterminated = `const oops = 'no pair; fetch(u);`;
  assert.equal(scanSource(unterminated).misreads.length, 1);
  assert.match(scanSource(unterminated).misreads[0].kind, /quote/);

  assert.equal(scanSource('/* never closed').misreads[0].kind, 'block comment with no end');
  assert.equal(scanSource('const t = `never closed').misreads[0].kind, 'template literal with no end');
});

test('ordinary source produces no misreads at all', () => {
  const source = [
    "const RE = /['\"]/g;",
    'if (RE.test(x)) { y = f(1) / 2; }',
    'const s = `a ${b} c`;',
    "// a comment with an apostrophe: don't",
    'const q = "a string with a / slash";',
  ].join('\n');
  assert.deepEqual(scanSource(source).misreads, []);
});

test('a misread reports the line it happened on', () => {
  const source = ['const a = 1;', 'const b = 2;', "const c = 'unterminated"].join('\n');
  assert.equal(scanSource(source).misreads[0].line, 3);
});

test('every shipped script is one the scanner can read end to end', () => {
  // The assertion that makes the two above matter. If this ever fails, the gate
  // is reporting on a file it did not understand.
  return (async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const url = await import('node:url');
    const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
    const dirs = ['src/lib', 'src/app', 'src/content'];
    for (const dir of dirs) {
      for (const name of await fs.readdir(path.join(root, dir))) {
        if (!name.endsWith('.js')) continue;
        const file = path.join(root, dir, name);
        const { misreads } = scanSource(await fs.readFile(file, 'utf8'));
        assert.deepEqual(misreads, [], `${dir}/${name} is not fully readable by the gate`);
      }
    }
  })();
});
