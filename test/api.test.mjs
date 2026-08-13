import test from 'node:test';
import assert from 'node:assert/strict';
import { loadLib, STUB_CHROME, fakeClock, fakeResponse } from './helper.mjs';

const ctx = await loadLib(['lib/browser.js', 'lib/i18n.js', 'lib/ratelimit.js', 'lib/api.js'], {
  chrome: STUB_CHROME,
  fetch: async () => fakeResponse(200, {}, {}),
});
const client = ctx.CL.api_client;

// Snowflake-shaped, because that is what the function actually receives and the
// rule it is being tested against only applies at fifteen digits and up. With
// three-digit fixtures the two keys below differed in the template itself, so
// the major-parameter suffix that does the real work was never exercised:
// deleting it left every channel sharing one lane and the whole suite green.
const CHANNEL_A = '111111111111111111';
const CHANNEL_B = '222222222222222222';

test('groups messages in one channel into a single bucket', () => {
  const a = client.routeKeyFor('DELETE', `/channels/${CHANNEL_A}/messages/999999999999999999`);
  const b = client.routeKeyFor('DELETE', `/channels/${CHANNEL_A}/messages/888888888888888888`);
  assert.equal(a, b);
});

test('keeps different channels in different buckets', () => {
  const a = client.routeKeyFor('DELETE', `/channels/${CHANNEL_A}/messages/999999999999999999`);
  const b = client.routeKeyFor('DELETE', `/channels/${CHANNEL_B}/messages/999999999999999999`);
  assert.notEqual(a, b);
  // Named so the failure says which half broke: both collapse to the same
  // template, so the channel is the only thing keeping them apart.
  assert.match(a, /\[channels:111111111111111111\]$/);
  assert.match(b, /\[channels:222222222222222222\]$/);
});

test('ignores the query string when bucketing', () => {
  const a = client.routeKeyFor('GET', '/channels/111/messages?limit=100');
  const b = client.routeKeyFor('GET', '/channels/111/messages?limit=100&before=123456789012345678');
  assert.equal(a, b);
});

function makeClient(handler, extra = {}) {
  const clock = fakeClock();
  return {
    clock,
    api: client.createClient({
      now: clock.now,
      sleep: clock.sleep,
      fetch: handler,
      ...extra,
    }),
  };
}

test('refuses to call anything before a token is set', async () => {
  const { api } = makeClient(async () => fakeResponse(200, {}, {}));
  await assert.rejects(api.me(), (err) => err.code === 'NO_TOKEN');
});

test('sends the token raw, with no Bearer prefix and no cookies', async () => {
  let seen = null;
  const { api } = makeClient(async (url, init) => {
    seen = { url, init };
    return fakeResponse(200, {}, { id: '1', username: 'jude' });
  });
  api.setToken('tok_abc');

  const me = await api.me();
  assert.equal(me.username, 'jude');
  assert.equal(seen.url, 'https://discord.com/api/v9/users/@me');
  assert.equal(seen.init.headers.Authorization, 'tok_abc');
  assert.equal(seen.init.credentials, 'omit');
});

test('drops the token on a 401 so a stale session cannot keep retrying', async () => {
  const { api } = makeClient(async () => fakeResponse(401, {}, {}));
  api.setToken('tok_stale');

  await assert.rejects(api.me(), (err) => err.code === 'UNAUTHORIZED');
  assert.equal(api.hasToken(), false);
});

test('treats a 204 as success with no body', async () => {
  const { api } = makeClient(async () => fakeResponse(204, {}, null));
  api.setToken('tok');
  assert.equal(await api.request('DELETE', '/channels/1/messages/2'), null);
});

test('paces deletes through the limiter rather than firing them back to back', async () => {
  const { api, clock } = makeClient(async () => fakeResponse(204, {}, null));
  api.setToken('tok');

  await api.request('DELETE', '/channels/1/messages/111111111111111111');
  await api.request('DELETE', '/channels/1/messages/222222222222222222');

  assert.ok(
    clock.total >= ctx.CL.ratelimit.MIN_WRITE_DELAY_MS,
    `two deletes should be spaced, waited ${clock.total}ms`
  );
});
