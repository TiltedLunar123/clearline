/**
 * Export normalised messages to downloadable strings.
 *
 * These are pure string builders so the same code can run in the service worker
 * and under node:vm in the tests. Nothing here touches the DOM or the network:
 * the caller decides how to hand the result to the user.
 *
 * CSV is the risky path. Message content is attacker-controlled text that a
 * spreadsheet will happily treat as a formula, so every cell is neutralised
 * before it is serialised. HTML is the safer human-readable path and still
 * escapes every interpolated value, because an export is something people open
 * in a browser.
 *
 * The HTML document is written in the reader's language. It is the record that
 * outlives the messages, and an app that speaks eleven languages handing back an
 * English document is the one place that stopped being true. CSV stays as it is:
 * its header row is a column contract other software reads, not prose.
 */
CL.exporter = (function () {
  'use strict';

  const CSV_HEADER =
    'id,timestamp,edited,guild,channel,author,content,attachments,embeds,pinned';

  /**
   * Byte order mark, so a spreadsheet reads the file as UTF-8.
   *
   * Excel on Windows opens a .csv with the system ANSI codepage unless the file
   * says otherwise, and this one is full of Discord messages: accents, emoji,
   * every script people actually chat in. Without the mark a backup taken
   * immediately before an irreversible delete opens as mojibake in the one
   * program most people take a CSV to. The mark costs three bytes and every
   * parser worth using either strips it or ignores it.
   */
  const BOM = '﻿';

  /**
   * Escape for HTML text and attribute contexts.
   *
   * Ampersand first, or the entities we write for the other characters get
   * re-escaped and the document shows the entity source instead of the char.
   */
  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function cellText(value) {
    if (value === null || value === undefined) return '';
    return String(value);
  }

  /**
   * An ISO stamp that cannot throw.
   *
   * `new Date(undefined).toISOString()` raises RangeError, and the one caller
   * that matters is the automatic backup taken immediately before a delete run.
   * Losing the export there because a header field was not filled in would mean
   * losing the only copy of the messages, so an absent timestamp falls back to
   * now rather than taking the whole export down with it.
   */
  function isoOf(value) {
    const d = new Date(value === null || value === undefined ? Date.now() : value);
    return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  }

  /**
   * One CSV field per RFC 4180, with spreadsheet formula injection blocked.
   *
   * A leading = + - or @ makes Excel and friends evaluate the cell. Prefixing
   * a single quote forces plain text. The quote is a data character, not CSV
   * quoting: CSV quoting is applied after, if the field still needs it.
   */
  function csvCell(value) {
    let s = cellText(value);
    /*
     * Two tests, and the second is the one that was missing.
     *
     * Tab and carriage return are neutralised on sight, which is what this has
     * always done and is left alone. The reason given for them, that a
     * spreadsheet strips leading whitespace before deciding whether a cell is a
     * formula, is right and was applied to two characters rather than to the
     * idea: an ordinary space is whitespace too, so " =cmd|'/C calc'!A0" walked
     * through a guard written against precisely that payload. Asking after the
     * first character that is not whitespace covers every spelling of the gap,
     * including several spaces, a space after a tab, and whatever else, while
     * leaving a cell that merely begins with a space as it was written.
     */
    if (/^[\t\r]/.test(s) || /^\s*[=+\-@]/.test(s)) s = "'" + s;
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function attachmentNames(message) {
    const list = message && message.attachments;
    if (!list || !list.length) return '';
    const names = [];
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      names.push(a && a.filename != null ? String(a.filename) : '');
    }
    return names.join('; ');
  }

  function toJSON(messages, meta) {
    const m = meta || {};
    const rows = messages || [];
    return JSON.stringify(
      {
        clearline: {
          version: 1,
          exported: isoOf(m.generatedAt),
          account: m.account,
          scope: m.scope,
          filterSummary: m.filterSummary,
          total: m.total,
          // Whether this is all of it. A stopped search is still a useful file
          // and a misleading one if it does not say so.
          partial: !!m.truncated,
        },
        messages: rows,
      },
      null,
      2
    );
  }

  function toCSV(messages) {
    const rows = messages || [];
    const lines = [CSV_HEADER];
    for (let i = 0; i < rows.length; i++) {
      const msg = rows[i] || {};
      lines.push(
        [
          csvCell(msg.id),
          csvCell(msg.timestamp),
          csvCell(msg.editedTimestamp),
          csvCell(msg.guildName),
          csvCell(msg.channelName),
          csvCell(msg.authorName),
          csvCell(msg.content),
          csvCell(attachmentNames(msg)),
          csvCell(msg.embedCount),
          csvCell(msg.pinned),
        ].join(',')
      );
    }
    return BOM + lines.join('\r\n') + (lines.length ? '\r\n' : '');
  }

  /**
   * A Discord instant in the reader's own timezone.
   *
   * The screen and the run report both print local time, and this document did
   * not: it wrote the raw instant, offset and all, so the backup taken moments
   * before a delete disagreed with the table the user had just read and with
   * the date range they had typed. Same moment either way; only the label was
   * different, which is the version that is hardest to notice.
   *
   * CSV and JSON keep the raw instant on purpose. They are read by other
   * software, which wants something unambiguous.
   */
  function localStamp(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso).slice(0, 16).replace('T', ' ');
    const pad = (n) => String(n).padStart(2, '0');
    return (
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())}`
    );
  }

  /** Readable rather than exact. Nobody reading an export wants 4823710 bytes. */
  function formatSize(size) {
    if (size === null || size === undefined || size === '') return '';
    const n = Number(size);
    if (!Number.isFinite(n) || n < 0) return '';
    if (n < 1024) return String(Math.round(n)) + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  /** Shared by both documents this file produces, so they look like one tool. */
  const SHARED_CSS = [
    'body{margin:0;padding:1.5rem;background:#1e1f22;color:#dbdee1;font:14px/1.5 system-ui,sans-serif}',
    'header{border-bottom:1px solid #3f4147;padding-bottom:1rem;margin-bottom:1.5rem}',
    'header h1{margin:0 0 0.5rem;font-size:1.25rem;color:#f2f3f5}',
    'header dl{margin:0;display:grid;grid-template-columns:auto 1fr;gap:0.25rem 1rem}',
    'header dt{color:#949ba4}header dd{margin:0}',
    'article{background:#2b2d31;border:1px solid #3f4147;border-radius:8px;padding:1rem;margin:0 0 0.75rem}',
    '.meta{color:#949ba4;font-size:0.85rem;margin-bottom:0.5rem}',
    '.meta .mark{display:inline-block;margin-left:0.5rem;color:#f0b232}',
    '.content{white-space:pre-wrap;word-break:break-word;margin:0.5rem 0 0}',
    '.partial{margin:1rem 0 0;color:#f0b232}',
  ].join('\n');

  function toHTML(messages, meta) {
    const m = meta || {};
    const rows = messages || [];
    const exported = isoOf(m.generatedAt);

    const t = CL.i18n.t;

    const parts = [];
    parts.push('<!doctype html>');
    // The locale the reader's browser actually chose, not the one this file was
    // written in. It drives hyphenation, quote marks, and how a screen reader
    // pronounces the whole document.
    parts.push('<html lang="' + escapeHtml(CL.i18n.language()) + '">');
    parts.push('<head>');
    parts.push('<meta charset="utf-8">');
    parts.push('<title>' + escapeHtml(t('exportTitle')) + '</title>');
    parts.push('<style>');
    parts.push(SHARED_CSS);
    parts.push(
      'ul.attachments{margin:0.5rem 0 0;padding-left:1.25rem;color:#b5bac1;font-size:0.9rem}'
    );
    parts.push('</style>');
    parts.push('</head>');
    parts.push('<body>');
    parts.push('<header>');
    parts.push('<h1>' + escapeHtml(t('exportTitle')) + '</h1>');
    parts.push('<dl>');
    parts.push('<dt>' + escapeHtml(t('labelAccount')) + '</dt><dd>' + escapeHtml(cellText(m.account)) + '</dd>');
    parts.push('<dt>' + escapeHtml(t('exportWhere')) + '</dt><dd>' + escapeHtml(cellText(m.scope)) + '</dd>');
    parts.push('<dt>' + escapeHtml(t('exportCount')) + '</dt><dd>' + escapeHtml(cellText(m.total)) + '</dd>');
    parts.push(
      '<dt>' +
        escapeHtml(t('exportFilter')) +
        '</dt><dd>' +
        escapeHtml(cellText(m.filterSummary)) +
        '</dd>'
    );
    parts.push('<dt>' + escapeHtml(t('exportWhen')) + '</dt><dd>' + escapeHtml(exported) + '</dd>');
    parts.push('</dl>');
    // Said in the file, not only on the screen it was made from. A stopped
    // search puts a notice above the results and the copy taken from it looked
    // like the whole picture, which is the wrong thing to be unsure about later
    // when it is the only record left of messages that no longer exist.
    if (m.truncated) {
      parts.push('<p class="partial">' + escapeHtml(t('exportPartial')) + '</p>');
    }
    parts.push('</header>');

    for (let i = 0; i < rows.length; i++) {
      const msg = rows[i] || {};
      const author = cellText(msg.authorName);
      const ts = localStamp(msg.timestamp);
      const content = cellText(msg.content);
      const edited = msg.editedTimestamp != null && msg.editedTimestamp !== '';
      const pinned = !!msg.pinned;

      parts.push('<article>');
      parts.push('<div class="meta">');
      parts.push('<strong>' + escapeHtml(author) + '</strong>');
      parts.push(' <time>' + escapeHtml(ts) + '</time>');
      if (edited) parts.push('<span class="mark">' + escapeHtml(t('exportEdited')) + '</span>');
      if (pinned) parts.push('<span class="mark">' + escapeHtml(t('exportPinned')) + '</span>');
      parts.push('</div>');
      parts.push('<div class="content">' + escapeHtml(content) + '</div>');

      const atts = msg.attachments;
      if (atts && atts.length) {
        parts.push('<ul class="attachments">');
        for (let j = 0; j < atts.length; j++) {
          const a = atts[j] || {};
          const name = cellText(a.filename);
          const size = formatSize(a.size);
          const label = size ? name + ' (' + size + ')' : name;
          parts.push('<li>' + escapeHtml(label) + '</li>');
        }
        parts.push('</ul>');
      }

      parts.push('</article>');
    }

    parts.push('</body>');
    parts.push('</html>');
    return parts.join('\n');
  }

  /**
   * The run report as a file.
   *
   * What a run did is only ever on screen, and a run can take hours: which
   * messages were left alone and why, which failed and with what error, how
   * many were never reached at all. Close the tab and that is gone, and unlike
   * an ordinary lost page there is nothing to go back and look at, because the
   * messages it describes have been deleted.
   *
   * Every string arrives already translated. The app builds these sentences for
   * the screen, and rebuilding them here would mean a second set of message
   * keys saying the same things, free to drift from the first.
   */
  function reportToHTML(report, meta) {
    const r = report || {};
    const m = meta || {};
    const t = CL.i18n.t;

    const parts = [];
    parts.push('<!doctype html>');
    parts.push('<html lang="' + escapeHtml(CL.i18n.language()) + '">');
    parts.push('<head>');
    parts.push('<meta charset="utf-8">');
    parts.push('<title>' + escapeHtml(t('reportTitle')) + '</title>');
    parts.push('<style>');
    parts.push(SHARED_CSS);
    parts.push('h2{font-size:1rem;color:#f2f3f5;margin:1.5rem 0 0.5rem}');
    parts.push('.headline{font-size:1.05rem;color:#f2f3f5;margin:0 0 0.5rem}');
    parts.push('.error{color:#f08a80;margin:0 0 0.5rem}');
    parts.push('.reason{color:#f0b232}');
    parts.push('</style>');
    parts.push('</head>');
    parts.push('<body>');
    parts.push('<header>');
    parts.push('<h1>' + escapeHtml(t('reportTitle')) + '</h1>');
    parts.push('<dl>');
    parts.push('<dt>' + escapeHtml(t('labelAccount')) + '</dt><dd>' + escapeHtml(cellText(m.account)) + '</dd>');
    parts.push('<dt>' + escapeHtml(t('exportWhere')) + '</dt><dd>' + escapeHtml(cellText(m.scope)) + '</dd>');
    parts.push('<dt>' + escapeHtml(t('exportFilter')) + '</dt><dd>' + escapeHtml(cellText(m.filterSummary)) + '</dd>');
    parts.push('<dt>' + escapeHtml(t('exportWhen')) + '</dt><dd>' + escapeHtml(isoOf(m.generatedAt)) + '</dd>');
    parts.push('</dl>');
    parts.push('</header>');

    parts.push('<p class="headline">' + escapeHtml(cellText(r.headline)) + '</p>');
    if (r.error) parts.push('<p class="error">' + escapeHtml(cellText(r.error)) + '</p>');
    for (const line of r.lines || []) {
      parts.push('<p>' + escapeHtml(cellText(line)) + '</p>');
    }

    for (const section of r.sections || []) {
      const entries = (section && section.entries) || [];
      if (!entries.length) continue;
      parts.push('<h2>' + escapeHtml(cellText(section.title)) + '</h2>');
      for (const entry of entries) {
        const e = entry || {};
        parts.push('<article>');
        parts.push('<div class="meta">');
        parts.push('<time>' + escapeHtml(cellText(e.when)) + '</time>');
        if (e.where) parts.push(' <span>' + escapeHtml(cellText(e.where)) + '</span>');
        if (e.id) parts.push(' <span>' + escapeHtml(cellText(e.id)) + '</span>');
        parts.push('</div>');
        if (e.text) parts.push('<div class="content">' + escapeHtml(cellText(e.text)) + '</div>');
        parts.push('<p class="reason">' + escapeHtml(cellText(e.reason)) + '</p>');
        parts.push('</article>');
      }
    }

    parts.push('</body>');
    parts.push('</html>');
    return parts.join('\n');
  }

  /**
   * Safe download name from scope and export time.
   *
   * Only a-z, 0-9 and hyphen survive. Everything else becomes a hyphen so a
   * scope like "My Server / #general" turns into a path-safe slug without
   * inventing host-looking fragments.
   *
   * `tag` distinguishes one kind of file from another in a downloads folder
   * that will hold several of them from the same run.
   *
   * The stamp is the local clock, like every timestamp inside the documents and
   * on the screen they were made from. It was UTC, which for most of the world
   * means an export saved in the evening is filed under tomorrow: three files
   * from one sitting sort into two days, and the date on the name disagrees with
   * the date on the first line inside it. CSV and JSON still carry the exact
   * instant in their contents, which is where software reads it; a filename is
   * read by a person looking for the copy they saved last night.
   */
  function filenameFor(meta, ext, tag) {
    const m = meta || {};
    let slug = String(m.scope || '')
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (slug.length > 60) {
      slug = slug.slice(0, 60).replace(/-+$/g, '');
    }

    const d = new Date(m.generatedAt || 0);
    const pad = function (n) {
      return String(n).padStart(2, '0');
    };
    const stamp =
      d.getFullYear() +
      pad(d.getMonth() + 1) +
      pad(d.getDate()) +
      '-' +
      pad(d.getHours()) +
      pad(d.getMinutes()) +
      pad(d.getSeconds());

    const bits = ['clearline'];
    if (tag) bits.push(String(tag));
    if (slug) bits.push(slug);
    bits.push(stamp);
    return bits.join('-') + '.' + String(ext || 'txt');
  }

  return { toJSON, toCSV, toHTML, reportToHTML, filenameFor, localStamp };
})();
