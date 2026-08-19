/**
 * The two things about this stylesheet that have been wrong in a shipped
 * release, checked by reading the stylesheet rather than by looking at it.
 *
 * Both were invisible to review for the same reason. A colour that fails is
 * still a colour, and it renders; a reduced-motion override that loses on
 * specificity is still in the file, and reading the block finds it there. The
 * only way either one announces itself is arithmetic, so it is done here every
 * time the suite runs instead of once by hand when somebody remembers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSS = await fs.readFile(path.join(ROOT, 'src', 'app', 'app.css'), 'utf8');

/** Comments hold example values and prose about colours, and neither is a rule. */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Pull one at-rule's body out, balanced.
 *
 * A regex cannot do this: the media block contains nested rules with their own
 * braces, so the first `}` is several rules early.
 */
function blockAfter(text, opener) {
  const at = text.indexOf(opener);
  if (at === -1) return null;
  let depth = 0;
  for (let i = text.indexOf('{', at); i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(text.indexOf('{', at) + 1, i);
  }
  return null;
}

/** Every `selector { ... }` pair at the top level of the text handed in. */
function rules(text) {
  const found = [];
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf('{', cursor);
    if (open === -1) break;
    let depth = 0;
    let close = -1;
    for (let i = open; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}' && --depth === 0) {
        close = i;
        break;
      }
    }
    if (close === -1) break;
    found.push({
      selector: text.slice(cursor, open).trim(),
      body: text.slice(open + 1, close),
    });
    cursor = close + 1;
  }
  return found;
}

/** One selector list into its selectors, each squashed to a comparable form. */
function selectorsOf(list) {
  return list
    .split(',')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s && !s.startsWith('@') && !/^(from|to|\d+%)$/.test(s));
}

const CLEAN = stripComments(CSS);
const REDUCED = blockAfter(CLEAN, '@media (prefers-reduced-motion: reduce)');

test('the reduced-motion block exists at all', () => {
  assert.ok(REDUCED, 'nothing in this file honours prefers-reduced-motion');
});

test('every animation is switched off by a selector identical to the one that starts it', () => {
  /*
   * Specificity, not presence. The radio's landing dot names an attribute
   * (`.choice input[type='radio']:checked::before`, 0-3-2) and the plainer
   * override beside it did not (0-2-2), so the override lost and the animation
   * the reader had asked not to see went on playing. Reading the block finds a
   * rule that looks like it covers it; only comparing the selectors finds that
   * it does not.
   *
   * Animations only. The transitions left running are colour and shadow changes
   * under a fifth of a second, which is feedback rather than motion; the ones
   * that move something are in the block and are covered by the same comparison
   * being about animations, since every moving thing here is an animation.
   */
  const outside = CLEAN.replace(REDUCED, '');
  const starts = new Set();
  for (const rule of rules(outside)) {
    if (!/(^|[\s;{])animation(-name)?\s*:/.test(rule.body)) continue;
    if (/animation(-name)?\s*:\s*none/.test(rule.body)) continue;
    for (const selector of selectorsOf(rule.selector)) starts.add(selector);
  }

  const stopped = new Set();
  for (const rule of rules(REDUCED)) {
    if (!/animation\s*:\s*none/.test(rule.body)) continue;
    for (const selector of selectorsOf(rule.selector)) stopped.add(selector);
  }

  assert.ok(starts.size > 0, 'no animations were found, so this test proves nothing');
  const missed = [...starts].filter((s) => !stopped.has(s));
  assert.deepEqual(
    missed,
    [],
    `these animate with no identical override under reduced motion:\n  ${missed.join('\n  ')}`
  );
});

/* ------------------------------------------------------------------ */
/* Contrast                                                            */
/* ------------------------------------------------------------------ */

/** The custom properties one block declares, as name -> value. */
function tokensIn(body) {
  const out = {};
  for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out[name] = value.trim();
  }
  return out;
}

const LIGHT = tokensIn(blockAfter(CLEAN, ':root') || '');
const DARK = { ...LIGHT, ...tokensIn(blockAfter(CLEAN, '@media (prefers-color-scheme: dark)') || '') };

function channel(value) {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  assert.ok(m, `${hex} is not a plain six-digit hex colour`);
  const n = parseInt(m[1], 16);
  return (
    0.2126 * channel((n >> 16) & 255) +
    0.7152 * channel((n >> 8) & 255) +
    0.0722 * channel(n & 255)
  );
}

function ratio(scheme, fg, bg) {
  const a = luminance(scheme[fg]);
  const b = luminance(scheme[bg]);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * Every pair this app actually draws, as ink on a surface.
 *
 * A list rather than a crawl of the stylesheet, because what matters is which
 * pairs meet on screen and no parser can tell that: `--accent` on `--card` is a
 * link and reads, `--accent` on `--accent` is the button that shipped for four
 * releases with white text at 2.4:1. Adding a colour to the palette means
 * adding the pairs it is drawn in.
 */
const TEXT_PAIRS = [
  ['--ink', '--bg'],
  ['--ink', '--card'],
  ['--ink', '--sunk'],
  ['--ink', '--hover'],
  ['--muted', '--bg'],
  ['--muted', '--card'],
  // The channel breakdown, and a spared row: both are muted ink on the recessed
  // fill. The spared row used to be the card's own ink at 40% opacity, which is
  // 2.6:1 for the message and 1.8:1 for the date and channel beside it, on the
  // rows somebody is squinting at to decide whether to put one back.
  ['--muted', '--sunk'],
  ['--muted', '--hover'],
  // The pairs that name each other. A token named for a colour has to carry its
  // own ink, and these are the two that do.
  ['--accent-ink', '--accent'],
  ['--danger-ink', '--danger'],
  // The two soft fills, which carry ordinary body text.
  ['--ink', '--accent-soft'],
  ['--ink', '--danger-soft'],
  ['--ink', '--warn-bg'],
  ['--danger', '--danger-soft'],
  ['--danger', '--warn-bg'],
  ['--accent', '--card'],
];

/**
 * Boundaries that identify a control, which WCAG asks 3:1 of rather than 4.5.
 *
 * The tick box is the one that matters here: an empty one is nothing but its
 * border, and this whole app is driven by them.
 */
const BOUNDARY_PAIRS = [
  ['--muted', '--card'],
  ['--muted', '--sunk'],
  // The outline of every secondary button in the app, which is the whole of
  // what says those are controls and not captions. Checked on all four surfaces
  // because they are drawn on all four: in a card, on the page behind one, on
  // the recessed fill of a chip, and against their own hover.
  ['--line-strong', '--card'],
  ['--line-strong', '--bg'],
  ['--line-strong', '--sunk'],
  ['--line-strong', '--hover'],
  ['--accent', '--card'],
  ['--accent', '--sunk'],
];

/**
 * Selectors allowed to fade something, and why each one may.
 *
 * The check below is the inverse of a pair list, because a pair list cannot see
 * this: the colour named in a faded rule measures fine and the colour on screen
 * does not. The footer disclaimer spent every release compositing to 3.33:1
 * while the token it names measured 6.21, and the review table struck rows out
 * at 40% and put them at 2.6:1 on the screen immediately before a delete.
 *
 * So the rule is that this stylesheet does not fade text at all, and anything
 * that wants to be quiet says so with a colour, which is measurable. Every
 * exception is named here with the reason it is not text:
 *
 *   :disabled          an inactive control, which WCAG exempts by name.
 *   .bar.waiting .fill a progress bar with nothing written in it, dimmed under
 *                      reduced motion in place of the sweep it cannot use.
 *   button.busy::after the spinner ring, which is a border and no text.
 */
const MAY_FADE = [/:disabled\b/, /^\.bar\.waiting \.fill$/, /^button\.busy::after$/];

test('nothing readable is made quiet by fading it', () => {
  const faded = [];
  // Keyframes are how a thing arrives, not how it sits, so their steps are read
  // out of the comparison rather than exempted one at a time.
  const withoutKeyframes = CLEAN.replace(/@keyframes[^{]*\{[\s\S]*?\n\}/g, '');
  const scan = (text) => {
    for (const rule of rules(text)) {
      if (rule.selector.startsWith('@')) {
        scan(rule.body);
        continue;
      }
      const match = /(^|[\s;{])opacity\s*:\s*([\d.]+)/.exec(rule.body);
      if (!match || Number(match[2]) >= 1) continue;
      for (const selector of selectorsOf(rule.selector)) {
        if (MAY_FADE.some((allowed) => allowed.test(selector))) continue;
        faded.push(`${selector} draws at ${match[2]}`);
      }
    }
  };
  scan(withoutKeyframes);
  assert.deepEqual(
    faded,
    [],
    `these fade something the reader may need to read:\n  ${faded.join('\n  ')}`
  );
});

for (const [name, scheme] of [
  ['light', LIGHT],
  ['dark', DARK],
]) {
  test(`text meets AA everywhere it is drawn, in the ${name} scheme`, () => {
    const failed = [];
    for (const [fg, bg] of TEXT_PAIRS) {
      const value = ratio(scheme, fg, bg);
      if (value < 4.5) failed.push(`${fg} on ${bg} is ${value.toFixed(2)}:1`);
    }
    assert.deepEqual(failed, [], `under 4.5:1:\n  ${failed.join('\n  ')}`);
  });

  test(`a control's own edges are visible, in the ${name} scheme`, () => {
    const failed = [];
    for (const [fg, bg] of BOUNDARY_PAIRS) {
      const value = ratio(scheme, fg, bg);
      if (value < 3) failed.push(`${fg} on ${bg} is ${value.toFixed(2)}:1`);
    }
    assert.deepEqual(failed, [], `under 3:1:\n  ${failed.join('\n  ')}`);
  });
}

test('the two schemes declare the same tokens as each other', () => {
  // A token the dark scheme forgets keeps the light value, which is how a fill
  // and its ink end up from different schemes and neither of the pairs above
  // describes what is on screen.
  const dark = tokensIn(blockAfter(CLEAN, '@media (prefers-color-scheme: dark)') || '');
  const colourish = (name) => !/^--(radius|speed|shadow)/.test(name);
  const missing = Object.keys(LIGHT).filter((k) => colourish(k) && !(k in dark));
  assert.deepEqual(missing, [], `the dark scheme never redefines: ${missing.join(', ')}`);
});
