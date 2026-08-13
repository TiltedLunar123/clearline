import test from 'node:test';
import assert from 'node:assert/strict';
import { loadLib, STUB_CHROME } from './helper.mjs';

const ctx = await loadLib(['lib/browser.js', 'lib/i18n.js', 'lib/export.js'], { chrome: STUB_CHROME });
const exp = ctx.CL.exporter;

const META = {
  account: 'username',
  scope: 'My Server / #general',
  generatedAt: 1709287200000,
  filterSummary: 'contains "hello", after 2024-01-01',
  total: 1,
};

function msg(overrides = {}) {
  return {
    id: '1234567890123456789',
    channelId: '999',
    channelName: 'general',
    guildId: '888',
    guildName: 'My Server',
    timestamp: '2024-03-01T10:00:00.000Z',
    editedTimestamp: null,
    authorId: '111',
    authorName: 'someone',
    content: 'hello',
    attachments: [],
    embedCount: 0,
    pinned: false,
    type: 0,
    ...overrides,
  };
}

const CSV_HEADER = 'id,timestamp,edited,guild,channel,author,content,attachments,embeds,pinned';

function csvRows(csv) {
  // Split only on CRLF that are not inside quotes. Enough for these tests.
  const rows = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i];
    const next = csv[i + 1];
    if (ch === '"') {
      inQuotes = !inQuotes;
      cur += ch;
    } else if (!inQuotes && ch === '\r' && next === '\n') {
      rows.push(cur);
      cur = '';
      i++;
    } else {
      cur += ch;
    }
  }
  if (cur.length) rows.push(cur);
  // Trailing CRLF leaves an empty final segment; drop it.
  if (rows.length && rows[rows.length - 1] === '') rows.pop();
  return rows;
}

test('CSV quotes a field containing a comma', () => {
  const csv = exp.toCSV([msg({ content: 'hello, world' })]);
  assert.match(csv, /"hello, world"/);
});

test('CSV doubles an embedded double quote', () => {
  const csv = exp.toCSV([msg({ content: 'say "hi"' })]);
  assert.match(csv, /"say ""hi"""/);
});

test('CSV keeps a newline inside a quoted field rather than breaking the row', () => {
  const csv = exp.toCSV([msg({ content: 'line one\nline two' })]);
  const rows = csvRows(csv);
  assert.equal(rows.length, 2, 'header plus one data row');
  assert.match(rows[1], /"line one\nline two"/);
});

test('CSV neutralises a formula-injection payload starting with =', () => {
  const csv = exp.toCSV([msg({ content: '=1+1' })]);
  // Leading single quote forces spreadsheets to treat the cell as plain text.
  assert.match(csv, /,'=1\+1,/);
  assert.doesNotMatch(csv, /(?<=,)(=1\+1)/);
});

test('CSV row count matches message count plus the header', () => {
  const messages = [msg({ id: '1' }), msg({ id: '2' }), msg({ id: '3' })];
  const rows = csvRows(exp.toCSV(messages));
  assert.equal(rows.length, 4);
  assert.equal(rows[0].replace('﻿', ''), CSV_HEADER);
});

test('CSV renders a null field as empty, not the string "null"', () => {
  const csv = exp.toCSV([
    msg({
      guildName: null,
      editedTimestamp: null,
      content: 'ok',
    }),
  ]);
  const rows = csvRows(csv);
  // id,timestamp,edited,guild,channel,author,content,...
  // edited and guild sit between timestamp and channel.
  assert.match(rows[1], /2024-03-01T10:00:00\.000Z,,,general,/);
  assert.doesNotMatch(rows[1], /null/);
});

test('HTML escapes script tags in message content so they cannot execute', () => {
  const html = exp.toHTML([msg({ content: '<script>alert(1)</script>' })], META);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('HTML escapes a quote inside an attachment filename', () => {
  const html = exp.toHTML(
    [
      msg({
        attachments: [{ id: '1', filename: 'evil"name.png', size: 10, url: '' }],
      }),
    ],
    META
  );
  assert.doesNotMatch(html, /evil"name/);
  assert.match(html, /evil&quot;name\.png/);
});

test('HTML escapes the scope and account in the header', () => {
  const html = exp.toHTML([], {
    ...META,
    account: '<admin>',
    scope: 'Server & "channel"',
  });
  assert.match(html, /&lt;admin&gt;/);
  assert.match(html, /Server &amp; &quot;channel&quot;/);
  assert.doesNotMatch(html, /<admin>/);
});

test('HTML preserves newlines in content', () => {
  const html = exp.toHTML([msg({ content: 'first\nsecond' })], META);
  assert.match(html, /white-space:\s*pre-wrap/);
  assert.match(html, /first\nsecond/);
});

test('HTML marks an edited message and a pinned message', () => {
  const html = exp.toHTML(
    [
      msg({
        editedTimestamp: '2024-03-01T10:05:00.000Z',
        pinned: true,
      }),
    ],
    META
  );
  assert.match(html, />edited</);
  assert.match(html, />pinned</);
});

test('HTML contains no external URL', () => {
  const html = exp.toHTML(
    [
      msg({
        attachments: [
          {
            id: '1',
            filename: 'a.png',
            size: 12,
            url: 'https://cdn.discordapp.com/attachments/1/a.png',
          },
        ],
      }),
    ],
    META
  );
  assert.doesNotMatch(html, /https?:\/\//i);
  // The locale that supplied the messages, which is what the document is
  // actually written in. Not the browser's UI language: the stub reports
  // "en-US" and there is no _locales/en-US, so tagging the document with it
  // named a locale that contributed nothing to it.
  assert.match(html, /^<!doctype html>\n<html lang="en">/);
});

test('the export document is written in the reader language', () => {
  // An app that speaks eleven languages handing back an English document was
  // the one place that stopped being true, and this document is the record that
  // outlives the messages it describes.
  const html = exp.toHTML(
    [msg({ pinned: true, editedTimestamp: '2024-03-01T11:00:00.000Z' })],
    META
  );
  const keys = [
    'exportTitle',
    'exportWhere',
    'exportCount',
    'exportFilter',
    'exportWhen',
    'exportEdited',
    'exportPinned',
    'labelAccount',
  ];
  for (const key of keys) {
    const text = ctx.CL.i18n.t(key);
    assert.notEqual(text, key, `${key} has to exist in the message store`);
    assert.ok(html.includes(text), `${key} ("${text}") never made it into the document`);
  }
});

test('JSON round-trips through JSON.parse with the message array intact', () => {
  const messages = [msg({ content: 'a' }), msg({ id: '2', content: 'b' })];
  const parsed = JSON.parse(exp.toJSON(messages, META));
  assert.equal(parsed.messages.length, 2);
  assert.equal(parsed.messages[0].content, 'a');
  assert.equal(parsed.messages[1].id, '2');
});

test('JSON header carries the account, scope and total', () => {
  const parsed = JSON.parse(exp.toJSON([msg()], META));
  assert.equal(parsed.clearline.version, 1);
  assert.equal(parsed.clearline.account, 'username');
  assert.equal(parsed.clearline.scope, 'My Server / #general');
  assert.equal(parsed.clearline.total, 1);
  assert.equal(parsed.clearline.exported, new Date(META.generatedAt).toISOString());
  assert.equal(parsed.clearline.filterSummary, META.filterSummary);
});

test('filenameFor lowercases, strips punctuation, and collapses dashes', () => {
  const name = exp.filenameFor(META, 'csv');
  assert.equal(name, 'clearline-my-server-general-20240301-100000.csv');
});

test('filenameFor caps a very long scope', () => {
  const long = 'A'.repeat(100) + ' / #' + 'B'.repeat(100);
  const name = exp.filenameFor({ ...META, scope: long }, 'json');
  const slug = name.replace(/^clearline-/, '').replace(/-20240301-100000\.json$/, '');
  assert.ok(slug.length <= 60, 'slug is at most 60 characters');
  assert.match(name, /^clearline-[a-z0-9-]+-20240301-100000\.json$/);
  assert.doesNotMatch(name, /--/);
});

test('empty message array produces valid output from all three exporters', () => {
  const json = exp.toJSON([], { ...META, total: 0 });
  const csv = exp.toCSV([]);
  const html = exp.toHTML([], { ...META, total: 0 });

  const parsed = JSON.parse(json);
  assert.deepEqual(parsed.messages, []);
  assert.equal(parsed.clearline.total, 0);

  const rows = csvRows(csv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].replace('﻿', '').split(',')[0], 'id');

  assert.match(html, /<!doctype html>/);
  assert.match(html, /<\/html>/);
});

test('a message with missing optional fields does not throw in any exporter', () => {
  const sparse = { id: '1', content: 'x' };
  assert.doesNotThrow(() => exp.toJSON([sparse], META));
  assert.doesNotThrow(() => exp.toCSV([sparse]));
  assert.doesNotThrow(() => exp.toHTML([sparse], META));
  assert.doesNotThrow(() => exp.filenameFor({}, 'txt'));

  const csv = exp.toCSV([sparse]);
  assert.match(csv, /\r\n1,,,,,,x,,,/);
});

/*
 * The four below cover the automatic backup taken immediately before a delete
 * run. That export is the only copy of the messages about to be destroyed, so
 * "it threw" is not an acceptable outcome for any input it can be handed.
 */

test('an export with no timestamp in its header still works', () => {
  assert.doesNotThrow(() => exp.toJSON([msg()], { account: 'a' }));
  assert.doesNotThrow(() => exp.toHTML([msg()], { account: 'a' }));

  const parsed = JSON.parse(exp.toJSON([msg()], { account: 'a' }));
  assert.match(parsed.clearline.exported, /^\d{4}-\d{2}-\d{2}T/);
});

test('a garbled timestamp in the header does not take the export down', () => {
  assert.doesNotThrow(() => exp.toJSON([msg()], { ...META, generatedAt: 'not a date' }));
  assert.doesNotThrow(() => exp.toHTML([msg()], { ...META, generatedAt: NaN }));
});

test('CSV neutralises a formula hidden behind a leading tab', () => {
  // Spreadsheets trim leading whitespace before deciding a cell is a formula,
  // so this evaluates where a bare "=" check would have passed it through.
  // A tab needs no RFC 4180 quoting, so the guard shows up as the bare prefix.
  const csv = exp.toCSV([msg({ content: '\t=1+1' })]);
  assert.match(csv, /,'\t=1\+1,/);
});

test('attachment sizes read as sizes rather than raw byte counts', () => {
  const html = exp.toHTML(
    [msg({ attachments: [{ id: '1', filename: 'big.png', size: 2097152, url: '' }] })],
    META
  );
  assert.match(html, /big\.png \(2\.0 MB\)/);
  assert.doesNotMatch(html, /2097152/);
});

test('CSV opens as UTF-8 in a spreadsheet rather than as mojibake', () => {
  // Excel on Windows reads a .csv with the system ANSI codepage unless the file
  // opens with a byte order mark, and Discord messages are full of accents and
  // emoji. Without it, "cafe" with an accent and every emoji in an export come
  // out as garbage in the one place people take these files to read them.
  const csv = exp.toCSV([msg({ content: 'café ❤' })]);
  assert.equal(csv.charCodeAt(0), 0xfeff, 'the file has to start with a byte order mark');
  // Exactly one, and only at the very start: a mark anywhere else is data.
  assert.equal(csv.indexOf('﻿', 1), -1);
  assert.match(csv, /café ❤/);
});

test('the byte order mark does not become part of the first column', () => {
  const rows = csvRows(exp.toCSV([msg()]));
  assert.equal(rows[0].replace('﻿', ''), CSV_HEADER);
  assert.equal(rows.length, 2);
});

test('the run report becomes a file that outlives the tab', () => {
  const report = {
    headline: 'Finished. 5 messages handled.',
    error: null,
    lines: ['12 messages were never attempted. Search again to pick them up.'],
    sections: [
      {
        title: '2 left alone',
        entries: [
          {
            when: '2024-03-01 12:30',
            where: '#general',
            text: 'joined the server',
            reason: 'Discord does not allow deleting this kind of message',
            id: '1234567890123456789',
          },
          {
            when: '2024-03-01 12:31',
            where: '#general',
            text: '',
            reason: 'No permission in that channel',
            id: '1234567890123456790',
          },
        ],
      },
    ],
  };
  const html = exp.reportToHTML(report, META);

  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<\/html>$/);
  assert.ok(html.includes(report.headline));
  assert.ok(html.includes(report.lines[0]));
  assert.ok(html.includes('2 left alone'));
  assert.ok(html.includes('Discord does not allow deleting this kind of message'));
  assert.ok(html.includes('No permission in that channel'));
  // The header names the account and where the run was, so the file still means
  // something a month later in a downloads folder.
  assert.ok(html.includes(META.account));
  assert.ok(html.includes(META.scope));
  assert.ok(html.includes(ctx.CL.i18n.t('reportTitle')));
});

test('the report file carries every entry, not the fifty the screen shows', () => {
  const entries = Array.from({ length: 120 }, (_, i) => ({
    when: '2024-03-01 12:00',
    where: '#general',
    text: 'row ' + i,
    reason: 'nope',
    id: String(i),
  }));
  const html = exp.reportToHTML({ headline: 'x', sections: [{ title: '120 failed', entries }] }, META);
  assert.ok(html.includes('row 0'));
  assert.ok(html.includes('row 119'), 'the list on screen stops at fifty; the file must not');
});

test('a report escapes message text rather than letting it become markup', () => {
  const html = exp.reportToHTML(
    {
      headline: 'done',
      sections: [
        {
          title: '1 failed',
          entries: [{ when: 'w', where: '#c', text: '<img src=x onerror=alert(1)>', reason: 'r', id: '1' }],
        },
      ],
    },
    META
  );
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test('a report with nothing to list is still a valid document', () => {
  const html = exp.reportToHTML({ headline: 'Finished. 0 messages handled.' }, META);
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<\/html>$/);
  assert.doesNotThrow(() => exp.reportToHTML({}, {}));
  assert.doesNotThrow(() => exp.reportToHTML(null, null));
});

test('a report filename does not collide with an export of the same scope', () => {
  const report = exp.filenameFor(META, 'html', 'report');
  const plain = exp.filenameFor(META, 'html');
  assert.notEqual(report, plain);
  assert.match(report, /^clearline-report-/);
  assert.match(plain, /^clearline-my-server/);
});

test('every character a spreadsheet treats as a formula is neutralised', () => {
  // Only "=" and a leading tab were ever driven, so the other four in the guard
  // were free to be wrong and nothing would have said so. Excel evaluates all
  // of them, and the payload here is the standard one: a cell that runs a
  // program when the file is opened.
  for (const lead of ['=', '+', '-', '@', '\t', '\r']) {
    const content = `${lead}cmd|' /C calc'!A0`;
    const csv = exp.toCSV([msg({ content })]);
    const body = csv.split('\r\n')[1];
    assert.ok(
      body.includes(`'${lead}`) || body.includes(`"'${lead}`),
      `a cell beginning ${JSON.stringify(lead)} was left evaluable: ${JSON.stringify(body)}`
    );
    assert.ok(!/^[=+@\t\r-]/.test(body.replace(/^"/, '')), 'the field still starts with the lead');
  }
});

test('a harmless message is not mangled by the formula guard', () => {
  // The other direction. Quoting everything that merely contains one of those
  // characters would corrupt ordinary text, which is most of what this exports.
  const csv = exp.toCSV([msg({ content: 'maths: 2+2=4, see you @ 5' })]);
  assert.ok(csv.includes('maths: 2+2=4, see you @ 5'), csv);
  assert.ok(!csv.includes("'maths"), 'a leading letter is not a formula');
});

test('the saved copy says when it is only part of the picture', () => {
  // A stopped search puts a notice above the results, and the copy taken from
  // that screen looked like the whole thing. It is the only record that will
  // exist of messages that no longer do, so it has to carry the caveat too.
  const partial = exp.toHTML([msg({})], { ...META, truncated: true });
  assert.ok(partial.includes(ctx.CL.i18n.t('exportPartial')), 'the HTML copy is silent about it');
  assert.equal(JSON.parse(exp.toJSON([msg({})], { ...META, truncated: true })).clearline.partial, true);

  const whole = exp.toHTML([msg({})], META);
  assert.ok(!whole.includes(ctx.CL.i18n.t('exportPartial')), 'a complete search must not claim otherwise');
  assert.equal(JSON.parse(exp.toJSON([msg({})], META)).clearline.partial, false);
});

test('the saved copy timestamps a message the way the screen did', () => {
  // The review table and the run report print local time, and this document
  // printed the raw instant, so the backup taken moments before a delete
  // disagreed with the table it was made from and with the date range the user
  // typed. Same moment, different label, which is the hardest kind to notice.
  const html = exp.toHTML([msg({ timestamp: '2024-03-05T23:30:00.000000+00:00' })], META);
  assert.ok(!html.includes('2024-03-05T23:30:00.000000+00:00'), 'the raw instant is still in there');
  assert.ok(html.includes(exp.localStamp('2024-03-05T23:30:00.000000+00:00')));
});

test('CSV and JSON keep the exact instant, because other software reads them', () => {
  const stamp = '2024-03-05T23:30:00.000000+00:00';
  assert.ok(exp.toCSV([msg({ timestamp: stamp })]).includes(stamp));
  assert.ok(exp.toJSON([msg({ timestamp: stamp })], META).includes(stamp));
});
