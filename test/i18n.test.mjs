/**
 * Translation, the locale that actually answered, and reading a count back.
 *
 * The last of those is the one that matters most. The confirm box is the final
 * thing standing between a person and an irreversible delete, and it compares
 * what they typed against a number the app printed somewhere else. Any way for
 * those two to be written in different digits is a way to make the product's
 * main path impossible to start, so both directions are pinned here, per locale.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadLib, STUB_CHROME, chromeFor } from './helper.mjs';

const LOCALES = ['en', 'es', 'pt_BR', 'fr', 'de', 'it', 'pl', 'tr', 'ru', 'ja', 'ko'];

async function i18nFor(locale, uiLanguage) {
  const ctx = await loadLib(['lib/browser.js', 'lib/i18n.js'], {
    chrome: await chromeFor(locale, uiLanguage),
  });
  return ctx.CL.i18n;
}

test('a count reads back exactly as it was printed, in every shipped locale', async () => {
  for (const locale of LOCALES) {
    const i18n = await i18nFor(locale);
    for (const n of [0, 7, 100, 101, 150, 1234, 999999]) {
      const printed = i18n.num(n);
      assert.equal(
        i18n.parseCount(printed),
        n,
        `${locale}: the box refuses ${JSON.stringify(printed)}, which is what the label says to type`
      );
    }
  }
});

test('a count typed in plain ASCII is accepted whatever the locale prints', async () => {
  // Somebody who gives up on the grouped form and types the bare digits has
  // still demonstrated they know the number.
  for (const locale of LOCALES) {
    const i18n = await i18nFor(locale);
    assert.equal(i18n.parseCount('1234'), 1234, locale);
  }
});

test('a count in a numbering system the locale does not use is still readable', async () => {
  // The shipped locales all print Latin digits, so this pins the property
  // rather than a current coincidence: parseCount is the inverse of num, and it
  // has to stay the inverse of num if a locale is ever added that is not.
  const i18n = await i18nFor('en');
  assert.equal(i18n.parseCount('1,234'), 1234);
  assert.equal(i18n.parseCount('1 234'), 1234, 'a narrow no-break space');
  assert.equal(i18n.parseCount('1 234'), 1234, 'a non-breaking space');
  assert.equal(i18n.parseCount("1'234"), 1234, 'the Swiss grouping apostrophe');
  assert.equal(i18n.parseCount('1.234'), 1234);
  assert.equal(i18n.parseCount('0150'), 150, 'leading zeros are still the number');
});

test('anything that is not cleanly a number is refused rather than guessed at', async () => {
  const i18n = await i18nFor('en');
  for (const bad of ['', '   ', 'all', '12a', 'a12', '1234x', 'null', '-5', '1e3']) {
    assert.equal(i18n.parseCount(bad), null, JSON.stringify(bad) + ' must not open a delete run');
  }
  assert.equal(i18n.parseCount(null), null);
  assert.equal(i18n.parseCount(undefined), null);
});

test('the refusal is exact: one digit out is still a refusal', async () => {
  const i18n = await i18nFor('en');
  assert.notEqual(i18n.parseCount('1233'), 1234);
  assert.notEqual(i18n.parseCount('12340'), 1234);
});

test('the locale reported is the one that supplied the messages', async () => {
  // The browser's UI language is a different question and was being used as the
  // answer to this one. A browser set to Dutch has no _locales/nl to read, so
  // every string comes from English while getUILanguage still says "nl": the
  // page was tagged as Dutch, a screen reader pronounced English text with
  // Dutch phonetics, and the same wrong tag went into the saved export.
  const dutchBrowser = await i18nFor('en', 'nl');
  assert.equal(dutchBrowser.language(), 'en');

  const russianBrowser = await i18nFor('ru', 'ru-RU');
  assert.equal(russianBrowser.language(), 'ru', 'a locale that does ship is reported as itself');

  const brazilian = await i18nFor('pt_BR', 'pt-BR');
  assert.equal(brazilian.language(), 'pt-BR', 'as a language tag, not a folder name');
});

test('every shipped locale names itself with a tag Intl accepts', async () => {
  for (const locale of LOCALES) {
    const i18n = await i18nFor(locale);
    const tag = i18n.language();
    assert.ok(tag, `${locale} must name itself`);
    assert.doesNotThrow(
      () => new Intl.PluralRules(tag),
      `${locale} reports "${tag}", which Intl cannot use, so plural forms would fall back silently`
    );
    assert.equal(
      new Intl.Locale(tag).language,
      locale.split('_')[0],
      `${locale} reports "${tag}", which is a different language`
    );
  }
});

test('plural forms come from the language the text is in', async () => {
  // Russian needs four categories and English two, so a browser set to Russian
  // reading English text must not be given Russian plural rules: the key it
  // asks for would not exist and the sentence would fall back for no reason.
  const englishTextRussianBrowser = await i18nFor('en', 'ru');
  assert.equal(englishTextRussianBrowser.plural('messages', 1), '1 message');
  assert.equal(englishTextRussianBrowser.plural('messages', 3), '3 messages');

  const russian = await i18nFor('ru');
  assert.notEqual(russian.plural('messages', 1), russian.plural('messages', 3));
  assert.notEqual(russian.plural('messages', 3), russian.plural('messages', 11));
});

test('a missing key shows itself rather than rendering as a blank label', async () => {
  const ctx = await loadLib(['lib/browser.js', 'lib/i18n.js'], { chrome: STUB_CHROME });
  assert.equal(ctx.CL.i18n.t('noSuchKeyAnywhere'), 'noSuchKeyAnywhere');
});
