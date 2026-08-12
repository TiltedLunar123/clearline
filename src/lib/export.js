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
    // Tab and carriage return belong in this set alongside the obvious four.
    // Excel strips leading whitespace before deciding whether a cell is a
    // formula, so "\t=cmd" evaluates while "=cmd" alone is what most guards
    // check for.
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
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

  /** Readable rather than exact. Nobody reading an export wants 4823710 bytes. */
  function formatSize(size) {
    if (size === null || size === undefined || size === '') return '';
    const n = Number(size);
    if (!Number.isFinite(n) || n < 0) return '';
    if (n < 1024) return String(Math.round(n)) + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function toHTML(messages, meta) {
    const m = meta || {};
    const rows = messages || [];
    const exported = isoOf(m.generatedAt);

    const parts = [];
    parts.push('<!doctype html>');
    parts.push('<html lang="en">');
    parts.push('<head>');
    parts.push('<meta charset="utf-8">');
    parts.push('<title>' + escapeHtml('Clearline export') + '</title>');
    parts.push('<style>');
    parts.push(
      'body{margin:0;padding:1.5rem;background:#1e1f22;color:#dbdee1;' +
        'font:14px/1.5 system-ui,sans-serif}'
    );
    parts.push(
      'header{border-bottom:1px solid #3f4147;padding-bottom:1rem;margin-bottom:1.5rem}'
    );
    parts.push('header h1{margin:0 0 0.5rem;font-size:1.25rem;color:#f2f3f5}');
    parts.push('header dl{margin:0;display:grid;grid-template-columns:auto 1fr;gap:0.25rem 1rem}');
    parts.push('header dt{color:#949ba4}header dd{margin:0}');
    parts.push(
      'article{background:#2b2d31;border:1px solid #3f4147;border-radius:8px;' +
        'padding:1rem;margin:0 0 0.75rem}'
    );
    parts.push('.meta{color:#949ba4;font-size:0.85rem;margin-bottom:0.5rem}');
    parts.push('.meta .mark{display:inline-block;margin-left:0.5rem;color:#f0b232}');
    parts.push('.content{white-space:pre-wrap;word-break:break-word;margin:0.5rem 0 0}');
    parts.push(
      'ul.attachments{margin:0.5rem 0 0;padding-left:1.25rem;color:#b5bac1;font-size:0.9rem}'
    );
    parts.push('</style>');
    parts.push('</head>');
    parts.push('<body>');
    parts.push('<header>');
    parts.push('<h1>' + escapeHtml('Clearline export') + '</h1>');
    parts.push('<dl>');
    parts.push('<dt>' + escapeHtml('Account') + '</dt><dd>' + escapeHtml(cellText(m.account)) + '</dd>');
    parts.push('<dt>' + escapeHtml('Scope') + '</dt><dd>' + escapeHtml(cellText(m.scope)) + '</dd>');
    parts.push('<dt>' + escapeHtml('Messages') + '</dt><dd>' + escapeHtml(cellText(m.total)) + '</dd>');
    parts.push(
      '<dt>' +
        escapeHtml('Filter') +
        '</dt><dd>' +
        escapeHtml(cellText(m.filterSummary)) +
        '</dd>'
    );
    parts.push('<dt>' + escapeHtml('Exported') + '</dt><dd>' + escapeHtml(exported) + '</dd>');
    parts.push('</dl>');
    parts.push('</header>');

    for (let i = 0; i < rows.length; i++) {
      const msg = rows[i] || {};
      const author = cellText(msg.authorName);
      const ts = cellText(msg.timestamp);
      const content = cellText(msg.content);
      const edited = msg.editedTimestamp != null && msg.editedTimestamp !== '';
      const pinned = !!msg.pinned;

      parts.push('<article>');
      parts.push('<div class="meta">');
      parts.push('<strong>' + escapeHtml(author) + '</strong>');
      parts.push(' <time>' + escapeHtml(ts) + '</time>');
      if (edited) parts.push('<span class="mark">' + escapeHtml('edited') + '</span>');
      if (pinned) parts.push('<span class="mark">' + escapeHtml('pinned') + '</span>');
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
   * Safe download name from scope and export time.
   *
   * Only a-z, 0-9 and hyphen survive. Everything else becomes a hyphen so a
   * scope like "My Server / #general" turns into a path-safe slug without
   * inventing host-looking fragments.
   */
  function filenameFor(meta, ext) {
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
      d.getUTCFullYear() +
      pad(d.getUTCMonth() + 1) +
      pad(d.getUTCDate()) +
      '-' +
      pad(d.getUTCHours()) +
      pad(d.getUTCMinutes()) +
      pad(d.getUTCSeconds());

    const bits = ['clearline'];
    if (slug) bits.push(slug);
    bits.push(stamp);
    return bits.join('-') + '.' + String(ext || 'txt');
  }

  return { toJSON, toCSV, toHTML, filenameFor };
})();
