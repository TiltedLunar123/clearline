import test from 'node:test';
import assert from 'node:assert/strict';
import { loadLib, STUB_CHROME } from './helper.mjs';

const ctx = await loadLib(['lib/browser.js', 'lib/snowflake.js', 'lib/filter.js'], {
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
  assert.equal(matches(msg({ type: 7 })), false, 'a join notice');
  assert.equal(matches(msg({ type: 6 })), false, 'a pin notice');
});

test('a before date includes the whole of that day', () => {
  // Someone picking "before 5 March" means the 5th counts. Treating it as
  // midnight would quietly spare a day of messages with no way to notice.
  const window = filter.toWindow({ before: Date.UTC(2024, 2, 5) });
  const endOfDay = snowflake.toMillis(window.maxId);
  assert.equal(new Date(endOfDay).toISOString().slice(0, 10), '2024-03-05');
  assert.ok(endOfDay >= Date.UTC(2024, 2, 5, 23, 59, 59));
});

test('an after date becomes the lowest id that could exist on that day', () => {
  const window = filter.toWindow({ after: Date.UTC(2024, 2, 5) });
  assert.equal(snowflake.toMillis(window.minId), Date.UTC(2024, 2, 5));
});

test('a date range is enforced locally as well as in the request', () => {
  // History paging ignores max_id, so without the local check the last page
  // hands back messages from outside the range the user chose.
  const matches = filter.compile({
    after: Date.UTC(2024, 1, 1),
    before: Date.UTC(2024, 1, 29),
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

test('the description reads as a sentence rather than a list of labels', () => {
  const text = filter.describe({
    contains: 'sorry',
    hasAttachment: true,
    excludePinned: true,
  });
  assert.equal(text, 'containing "sorry", with an attachment and not pinned');
});

test('the description names both ends of a date range', () => {
  const text = filter.describe({ after: Date.UTC(2024, 0, 1), before: Date.UTC(2024, 11, 31) });
  assert.equal(text, 'sent between 2024-01-01 and 2024-12-31');
});

test('a link inside a longer sentence still counts as a link', () => {
  assert.equal(filter.hasLink({ content: 'go to https://discord.com/channels/1 now' }), true);
  assert.equal(filter.hasLink({ content: 'discord.com is not a link without a scheme' }), false);
  assert.equal(filter.hasLink({ content: '' }), false);
});
