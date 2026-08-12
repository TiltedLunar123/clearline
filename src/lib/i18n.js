/**
 * Translation.
 *
 * Thin on purpose. The browser already ships a message store, picks a locale
 * from the user's own browser settings and falls back to the default locale on
 * its own, so this file exists to do the three things that store does not:
 * fill the static markup, choose a plural form, and fail visibly rather than
 * silently when a key is missing.
 *
 * The store is `_locales/<lang>/messages.json` and the browser resolves it
 * before the page ever runs, which is why nothing here fetches anything.
 */
CL.i18n = (function () {
  'use strict';

  const api = CL.api.i18n;

  /**
   * A missing key returns an empty string from getMessage, which renders as a
   * blank label rather than as an error. Showing the key is uglier and far
   * easier to notice, and it is the difference between spotting a gap in
   * translation during a five minute pass and shipping an unlabelled button.
   */
  function t(key, subs) {
    const value = api.getMessage(key, subs);
    return value || key;
  }

  /** True when the key exists at all, which is what the plural picker needs. */
  function has(key) {
    return !!api.getMessage(key);
  }

  /**
   * Plural forms, which the extension message store has no concept of.
   *
   * English needs two and Russian and Polish need four, so a one/other split
   * hard-coded in the caller reads as broken in half the languages this ships
   * in. Intl.PluralRules knows the categories for the locale the browser chose,
   * and each category is just another key: `matched_one`, `matched_few`,
   * `matched_many`, `matched_other`. Only `_other` is required; a language that
   * does not use a category simply has no key for it.
   *
   * `n` is passed through as $1 by convention so every plural message can name
   * the number without the caller building the string.
   */
  const rules = (function () {
    try {
      return new Intl.PluralRules(api.getUILanguage());
    } catch {
      return null;
    }
  })();

  function plural(key, n, subs) {
    const args = subs === undefined ? [num(n)] : subs;
    const category = rules ? rules.select(n) : 'other';
    const exact = `${key}_${category}`;
    if (has(exact)) return t(exact, args);
    return t(`${key}_other`, args);
  }

  /**
   * A number written the way the reader's locale writes numbers.
   *
   * Group separators are not cosmetic here: 1,234 and 1.234 mean different
   * things to different readers, and one of the places this lands is the box
   * that asks somebody to type back how many messages they are about to
   * destroy. Everything that prints a count goes through this so the sentence
   * and the box always agree.
   */
  function num(value) {
    try {
      return Number(value).toLocaleString(api.getUILanguage());
    } catch {
      return String(value);
    }
  }

  /**
   * Join clauses the way the reader's language joins them.
   *
   * "a, b and c" is an English rule. German wants "und", Japanese wants a
   * different separator entirely and no conjunction, and Spanish switches "y"
   * to "e" before an i sound. Intl.ListFormat knows all of that; a hand-rolled
   * join with a translated "and" does not.
   */
  const listFormat = (function () {
    try {
      return new Intl.ListFormat(api.getUILanguage(), { style: 'long', type: 'conjunction' });
    } catch {
      return null;
    }
  })();

  function list(items) {
    const parts = (items || []).filter(Boolean);
    if (listFormat) return listFormat.format(parts);
    return parts.join(', ');
  }

  /**
   * Fill the static markup.
   *
   * `data-i18n` sets text. `data-i18n-attr` sets attributes, as
   * `attr:key` pairs, for the placeholders and titles that are equally
   * user-facing and cannot be text nodes.
   */
  function apply(root) {
    const scope = root || document;
    for (const el of scope.querySelectorAll('[data-i18n]')) {
      el.textContent = t(el.dataset.i18n);
    }
    for (const el of scope.querySelectorAll('[data-i18n-attr]')) {
      for (const pair of el.dataset.i18nAttr.split(',')) {
        const [attr, key] = pair.split(':');
        if (attr && key) el.setAttribute(attr.trim(), t(key.trim()));
      }
    }
    // The document language drives hyphenation, quote marks, and how a screen
    // reader pronounces the page, so it has to follow the locale actually used
    // rather than stay at the `en` the file was authored in.
    document.documentElement.lang = api.getUILanguage();
  }

  /**
   * The locale the browser actually picked.
   *
   * Wanted by anything that builds a document rather than the page: an export
   * needs it on `<html lang>` for hyphenation, quote marks and how a screen
   * reader pronounces it, and has no DOM of its own to read it back from.
   */
  function language() {
    try {
      return api.getUILanguage() || 'en';
    } catch {
      return 'en';
    }
  }

  return { t, plural, num, list, has, apply, language };
})();
