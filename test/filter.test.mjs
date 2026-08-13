import test from 'node:test';
import assert from 'node:assert/strict';
import { loadLib, STUB_CHROME } from './helper.mjs';

const ctx = await loadLib(['lib/browser.js', 'lib/i18n.js', 'lib/snowflake.js', 'lib/filter.js'], {
  chrome: STUB_CHROME,
});
const filter = ctx.CL.filter;
const snowflake = ctx.CL.snowflake;

function msg(overrides = {}) {
  return {
    id: snowflake.fromMillis(Date.UTC(2024, 2, 1)),
    channelId: '999',
    content: 'hello world',
    attachments: [],
    embedCount: 0,
    pinned: false,
    type: 0,
    ...overrides,
  };
}

test('a plain search ignores case', () => {
  const matches = filter.compile({ contains: 'HELLO' });
  assert.equal(matches(msg({ content: 'hello there' })), true);
  assert.equal(matches(msg({ content: 'goodbye' })), false);
});

test('case sensitivity can be asked for', () => {
  const matches = filter.compile({ contains: 'Hello', caseSensitive: true });
  assert.equal(matches(msg({ content: 'Hello' })), true);
  assert.equal(matches(msg({ content: 'hello' })), false);
});

test('a regex search matches on the pattern rather than the literal text', () => {
  const matches = filter.compile({ contains: '^sorry\\b', useRegex: true });
  assert.equal(matches(msg({ content: 'sorry about that' })), true);
  assert.equal(matches(msg({ content: 'i am sorry' })), false);
});

test('a broken pattern is rejected up front rather than mid run', () => {
  assert.throws(
    () => filter.compile({ contains: '([unclosed', useRegex: true }),
    (err) => err.code === 'BAD_PATTERN'
  );
});

test('a regex is not accidentally applied when regex mode is off', () => {
  // Someone typing a bracket into the plain box means the bracket, and treating
  // it as a pattern would silently match a different set than they expect.
  const matches = filter.compile({ contains: '[test]' });
  assert.equal(matches(msg({ content: 'this is [test] here' })), true);
  assert.equal(matches(msg({ content: 'this is t here' })), false);
});

test('attachment, link and embed filters each look at their own field', () => {
  const hasFile = filter.compile({ hasAttachment: true });
  const hasLink = filter.compile({ hasLink: true });
  const hasEmbed = filter.compile({ hasEmbed: true });

  assert.equal(hasFile(msg({ attachments: [{ filename: 'a.png' }] })), true);
  assert.equal(hasFile(msg()), false);

  assert.equal(hasLink(msg({ content: 'see https://discord.com/x for more' })), true);
  assert.equal(hasLink(msg({ content: 'no link here' })), false);

  assert.equal(hasEmbed(msg({ embedCount: 2 })), true);
  assert.equal(hasEmbed(msg()), false);
});

test('pinned messages can be spared', () => {
  const matches = filter.compile({ excludePinned: true });
  assert.equal(matches(msg({ pinned: true })), false);
  assert.equal(matches(msg({ pinned: false })), true);
});

test('only deletable message types survive the deletable filter', () => {
  const matches = filter.compile({ onlyDeletable: true });
  assert.equal(matches(msg({ type: 0 })), true, 'a normal message');
  assert.equal(matches(msg({ type: 19 })), true, 'a reply');
  // These are the account's own trace in a server just as much as anything it
  // typed, and Discord's own message type table marks every one of them
  // deletable by their author. Treating them as untouchable left them in place
  // for good and told the user Discord had forbidden it.
  assert.equal(matches(msg({ type: 7 })), true, 'a join notice');
  assert.equal(matches(msg({ type: 6 })), true, 'a pin notice');
  assert.equal(matches(msg({ type: 18 })), true, 'started a thread');
  assert.equal(matches(msg({ type: 8 })), true, 'a boost');
  // And these Discord genuinely refuses from anyone.
  assert.equal(matches(msg({ type: 3 })), false, 'a call');
  assert.equal(matches(msg({ type: 4 })), false, 'a channel rename');
  assert.equal(matches(msg({ type: 21 })), false, 'a thread starter pointer');
});

test('what can be overwritten is a shorter list than what can be deleted', () => {
  // Deliberately two lists rather than one. A join notice can be removed but
  // has no text behind it to replace, and Discord answers that PATCH with a
  // plain 400: the failure pile rather than the skip pile, blaming the wrong
  // thing and counting toward the limit that halts a whole run. One predicate
  // answering both questions had to be as narrow as the stricter of them.
  for (const type of [0, 19]) {
    assert.equal(filter.isEditable(msg({ type })), true, `type ${type} is text the user wrote`);
    assert.equal(filter.isDeletable(msg({ type })), true, `type ${type} is deletable too`);
  }
  for (const type of [6, 7, 8, 18]) {
    assert.equal(filter.isDeletable(msg({ type })), true, `type ${type} can be removed`);
    assert.equal(filter.isEditable(msg({ type })), false, `type ${type} has nothing to overwrite`);
  }
});

test('canAct hands each action the list that action is held to', () => {
  const notice = msg({ type: 7 });
  assert.equal(filter.canAct('delete')(notice), true, 'a delete run removes a join notice');
  assert.equal(filter.canAct('edit')(notice), false, 'an overwrite run cannot');
  assert.equal(
    filter.canAct('edit-then-delete')(notice),
    false,
    'and neither can one that overwrites first, since the overwrite still has to land'
  );
});

test('every type either list names is one Discord agrees about', () => {
  // Editable is a subset of deletable, and it has to stay one: edit-then-delete
  // does both to the same message, so anything the edit half accepts the delete
  // half must accept too.
  for (const type of filter.EDITABLE_TYPES) {
    assert.ok(
      filter.DELETABLE_TYPES.includes(type),
      `type ${type} can be overwritten but not deleted, which edit-then-delete cannot honour`
    );
  }
  // 24 needs Manage Messages, so it is somebody else's to remove, and 21 is a
  // pointer at a thread rather than a message. Both stay out.
  for (const type of [1, 2, 3, 4, 5, 21, 24]) {
    assert.ok(!filter.DELETABLE_TYPES.includes(type), `type ${type} is not ours to delete`);
  }
});

test('a date range is turned into exact instants, not reinterpreted as days', () => {
  // The library takes instants. Widening a calendar day is the caller's job,
  // because a day only means anything in a timezone and doing it here in UTC
  // shifts the range under everyone who is not on it.
  const from = Date.UTC(2024, 2, 5, 6, 30);
  const to = Date.UTC(2024, 2, 9, 18, 45);
  const window = filter.toWindow({ after: from, before: to });

  assert.equal(snowflake.toMillis(window.minId), from);
  assert.equal(snowflake.toMillis(window.maxId), to);
});

test('a day is widened in local time, so it means the day the user picked', () => {
  // Someone picking "before 5 March" means the 5th counts, in their own
  // calendar. Doing this in UTC hands a user in Tokyo the morning of the 6th.
  const picked = new Date(2024, 2, 5);
  const start = filter.startOfDay(picked);
  const end = filter.endOfDay(picked);

  assert.equal(new Date(start).getDate(), 5);
  assert.equal(new Date(start).getHours(), 0);
  assert.equal(new Date(end).getDate(), 5);
  assert.equal(new Date(end).getHours(), 23);
  assert.equal(end - start, 86400000 - 1);
});

test('the description names the local day, matching the box it came from', () => {
  const local = new Date(2024, 2, 5).getTime();
  assert.equal(filter.describe({ after: local }), 'sent on or after 2024-03-05');
});

test('a date range is enforced locally as well as in the request', () => {
  // History paging ignores max_id, so without the local check the last page
  // hands back messages from outside the range the user chose.
  const matches = filter.compile({
    after: Date.UTC(2024, 1, 1),
    before: Date.UTC(2024, 1, 29, 23, 59, 59, 999),
  });
  assert.equal(matches(msg({ id: snowflake.fromMillis(Date.UTC(2024, 1, 15)) })), true);
  assert.equal(matches(msg({ id: snowflake.fromMillis(Date.UTC(2023, 1, 15)) })), false);
  assert.equal(matches(msg({ id: snowflake.fromMillis(Date.UTC(2024, 5, 15)) })), false);
});

test('channel restriction keeps only the chosen channels', () => {
  const matches = filter.compile({ channelIds: ['111', '222'] });
  assert.equal(matches(msg({ channelId: '111' })), true);
  assert.equal(matches(msg({ channelId: '333' })), false);
});

test('filters stack, so a message has to satisfy all of them', () => {
  const matches = filter.compile({ contains: 'sorry', hasAttachment: true, excludePinned: true });
  assert.equal(matches(msg({ content: 'sorry', attachments: [{}], pinned: false })), true);
  assert.equal(matches(msg({ content: 'sorry', attachments: [], pinned: false })), false);
  assert.equal(matches(msg({ content: 'sorry', attachments: [{}], pinned: true })), false);
});

test('no filters at all keeps everything', () => {
  assert.equal(filter.compile({})(msg()), true);
  assert.equal(filter.apply([msg(), msg(), msg()], {}).length, 3);
});

test('apply returns only the matching messages', () => {
  const messages = [msg({ content: 'keep me' }), msg({ content: 'drop me' })];
  const kept = filter.apply(messages, { contains: 'keep' });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].content, 'keep me');
});

test('an empty filter set describes itself in plain words', () => {
  assert.equal(filter.describe({}), 'everything you wrote');
});

test('an empty filter set is recognisable as empty', () => {
  // The sentence shown before a delete reads differently with and without a
  // filter, so the caller has to be able to tell them apart without matching
  // against whatever describe() happened to return.
  assert.equal(filter.isEmpty({}), true);
  assert.equal(filter.isEmpty({ contains: '' }), true, 'an untouched text box is not a filter');
  assert.equal(filter.isEmpty({ contains: 'sorry' }), false);
  assert.equal(filter.isEmpty({ excludePinned: true }), false);
  assert.equal(filter.isEmpty({ after: Date.now() }), false);
  assert.equal(filter.isEmpty({ hasAttachment: true }), false);
});

test('the description reads as a sentence rather than a list of labels', () => {
  // Joined by Intl.ListFormat, so the separator is whatever the reader's locale
  // uses rather than a hard-coded " and ". The stub reports en-US, which takes
  // the serial comma; en-GB would not, and Japanese uses neither.
  const text = filter.describe({
    contains: 'sorry',
    hasAttachment: true,
    excludePinned: true,
  });
  assert.equal(text, 'containing "sorry", with an attachment, and not pinned');
});

test('the description names both ends of a date range', () => {
  const text = filter.describe({
    after: new Date(2024, 0, 1).getTime(),
    before: new Date(2024, 11, 31).getTime(),
  });
  assert.equal(text, 'sent between 2024-01-01 and 2024-12-31');
});

test('a link inside a longer sentence still counts as a link', () => {
  assert.equal(filter.hasLink({ content: 'go to https://discord.com/channels/1 now' }), true);
  assert.equal(filter.hasLink({ content: 'discord.com is not a link without a scheme' }), false);
  assert.equal(filter.hasLink({ content: '' }), false);
});

test('a channel restriction covers that channel\'s threads', () => {
  // A thread message carries the thread's id, and threads are never in the
  // picker, so matching on channelId alone dropped every thread reply in a
  // channel the user had explicitly chosen. Nothing said anything was missing:
  // the count on the review screen was simply too low.
  const inChannel = { id: '1', channelId: 'C', parentId: null, type: 0, content: 'a', attachments: [] };
  const inThread = { id: '2', channelId: 'T', parentId: 'C', type: 0, content: 'b', attachments: [] };
  const elsewhere = { id: '3', channelId: 'X', parentId: null, type: 0, content: 'c', attachments: [] };
  const inOtherThread = { id: '4', channelId: 'T2', parentId: 'X', type: 0, content: 'd', attachments: [] };

  const kept = filter.apply([inChannel, inThread, elsewhere, inOtherThread], { channelIds: ['C'] });

  assert.deepEqual(kept.map((m) => m.id), ['1', '2']);
});

test('a channel restriction still excludes threads of channels that were not picked', () => {
  // The point of widening the check is to stop under-counting, not to let
  // anything in. A parent nobody picked is still out.
  const inOtherThread = { id: '4', channelId: 'T2', parentId: 'X', type: 0, content: 'd', attachments: [] };
  assert.equal(filter.apply([inOtherThread], { channelIds: ['C'] }).length, 0);
});

test('a broken pattern is explained in the reader language', () => {
  // Built from the message store like every other sentence the app shows, so it
  // translates. This one was an English literal, thrown straight into the status
  // line under the box, in an app that otherwise ships in eleven languages.
  const marker = '<<reason>>';
  const template = ctx.CL.i18n.t('errBadPattern', [marker]);
  const prefix = template.split(marker)[0];
  assert.ok(prefix && prefix !== 'errBadPattern', 'the store has to carry this sentence');

  let thrown = null;
  try {
    filter.compile({ contains: '(unclosed', useRegex: true });
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, 'a pattern that does not compile has to be refused');
  assert.equal(thrown.code, 'BAD_PATTERN');
  assert.ok(
    thrown.message.startsWith(prefix),
    `message was ${JSON.stringify(thrown.message)}, which did not come from the store`
  );
});
