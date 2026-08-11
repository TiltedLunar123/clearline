import test from 'node:test';
import assert from 'node:assert/strict';
import { loadLib, STUB_CHROME } from './helper.mjs';

// filter.js rides along because the channel scoping the app applies is split
// across the two files: search decides which channel a message belongs to, and
// filter decides whether that channel was picked. Testing either alone is what
// let thread messages fall down the gap between them.
const ctx = await loadLib(['lib/browser.js', 'lib/snowflake.js', 'lib/filter.js', 'lib/search.js'], {
  chrome: STUB_CHROME,
});
const search = ctx.CL.search;
const filter = ctx.CL.filter;
const snowflake = ctx.CL.snowflake;

const ME = '111111111111111111';
const CHANNEL = '999999999999999999';

/** Raw message in the shape Discord actually returns. */
function raw(minute, overrides = {}) {
  return {
    id: snowflake.fromMillis(Date.UTC(2024, 2, 1) + minute * 60000),
    channel_id: CHANNEL,
    author: { id: ME, username: 'me' },
    timestamp: new Date(Date.UTC(2024, 2, 1) + minute * 60000).toISOString(),
    content: `message ${minute}`,
    attachments: [],
    embeds: [],
    pinned: false,
    type: 0,
    ...overrides,
  };
}

/** Newest first, which is the order search returns and history walks. */
function corpus(count) {
  return Array.from({ length: count }, (_, i) => raw(count - i));
}

/**
 * A search endpoint that honours max_id, min_id and offset the way Discord
 * does, so the paging logic is exercised rather than a simplified stand-in.
 */
function searchServer(all, options = {}) {
  const state = { requests: [] };
  state.handler = (params) => {
    state.requests.push(params);
    if (options.before && options.before(state.requests.length)) {
      return options.before(state.requests.length);
    }
    let pool = all;
    if (params.max_id) pool = pool.filter((m) => BigInt(m.id) <= BigInt(params.max_id));
    if (params.min_id) pool = pool.filter((m) => BigInt(m.id) >= BigInt(params.min_id));
    const offset = Number(params.offset || 0);
    const page = pool.slice(offset, offset + search.SEARCH_PAGE);
    return {
      status: 200,
      body: { total_results: pool.length, messages: page.map((m) => [m]) },
    };
  };
  return state;
}

function clientWith(parts) {
  return {
    searchGuild: async (id, params) => parts.search(params),
    searchChannel: async (id, params) => parts.search(params),
    channelMessages: async (id, params) => parts.history(params),
    ...parts.extra,
  };
}

const noSleep = { sleep: async () => {} };

const OTHER = { id: '222222222222222222', username: 'someone-else' };

test('the flagged message is the hit, not its context', () => {
  const group = [raw(1), { ...raw(2), hit: true }, raw(3)];
  assert.equal(search.hitOf(group, ME).content, 'message 2');
});

test('only the account\'s own messages are candidates for the hit', () => {
  // Search returns hits wrapped in other people's messages as context. Picking
  // out of that block without checking who wrote it is how a tool like this
  // ends up queueing somebody else's message for deletion.
  const group = [
    { ...raw(1), author: OTHER },
    { ...raw(2), hit: true },
    { ...raw(3), author: OTHER },
  ];
  assert.equal(search.hitOf(group, ME).content, 'message 2');
});

test('a context block with none of the account\'s messages yields nothing', () => {
  const group = [
    { ...raw(1), author: OTHER },
    { ...raw(2), author: OTHER, hit: true },
  ];
  assert.equal(search.hitOf(group, ME), null, 'a guess here is a deleted message');
});

test('the last message in a channel is not mistaken for the one after it', () => {
  // Context is only symmetric away from the ends of a channel. For the oldest
  // message the block is [hit, after], so a "take the middle one" fallback
  // picks the message after it, which somebody else wrote.
  const group = [raw(1), { ...raw(2), author: OTHER }];
  assert.equal(search.hitOf(group, ME).content, 'message 1');
});

test('a message is flattened into one shape whatever endpoint it came from', () => {
  const flat = search.normalise(
    raw(5, {
      edited_timestamp: '2024-03-01T10:05:00.000Z',
      pinned: true,
      attachments: [{ id: '1', filename: 'a.png', size: 12, url: 'https://cdn.discordapp.com/x' }],
      embeds: [{}, {}],
    }),
    { guildId: '888', guildName: 'Server', channelName: 'general' }
  );

  assert.equal(flat.channelId, CHANNEL);
  assert.equal(flat.guildName, 'Server');
  assert.equal(flat.channelName, 'general');
  assert.equal(flat.embedCount, 2);
  assert.equal(flat.pinned, true);
  assert.equal(flat.attachments[0].filename, 'a.png');
  assert.equal(flat.editedTimestamp, '2024-03-01T10:05:00.000Z');
  assert.equal(typeof flat.id, 'string');
});

test('a search pages through offsets until the results run out', async () => {
  const server = searchServer(corpus(60));
  const finder = search.createFinder(clientWith({ search: server.handler }), noSleep);
  const result = await finder.find({ scope: { guildId: '888' }, authorId: ME });

  assert.equal(result.messages.length, 60);
  assert.equal(result.strategy, 'search');
  assert.equal(result.total, 60);
  assert.deepEqual(
    server.requests.map((r) => r.offset || 0),
    [0, 25, 50]
  );
});

test('the search window is pinned so messages arriving mid run cannot shift the paging', async () => {
  // Without a pinned max_id every new message shifts the next offset by one and
  // the paging silently skips a message per arrival. That matters a great deal
  // when the next thing the user does is delete the result set.
  const server = searchServer(corpus(30));
  const finder = search.createFinder(clientWith({ search: server.handler }), noSleep);
  await finder.find({ scope: { guildId: '888' }, authorId: ME });

  assert.ok(server.requests[0].max_id, 'the first request already bounds the top of the range');
  const pinned = server.requests[0].max_id;
  assert.ok(server.requests.every((r) => r.max_id === pinned));
});

test('the same message returned twice is only counted once', async () => {
  const all = corpus(30);
  let calls = 0;
  const handler = (params) => {
    calls++;
    // Serve the same first page twice, which is what a shifting index looks like.
    const offset = calls <= 2 ? 0 : Number(params.offset || 0);
    const page = all.slice(offset, offset + search.SEARCH_PAGE);
    return { status: 200, body: { total_results: all.length, messages: page.map((m) => [m]) } };
  };
  const finder = search.createFinder(clientWith({ search: handler }), noSleep);
  const result = await finder.find({ scope: { guildId: '888' }, authorId: ME });

  const ids = result.messages.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length, 'no duplicates survived');
});

test('a result set deeper than Discord will page is reached by moving the window', async () => {
  // Discord refuses an offset past 5000. Anything deeper has to be reached by
  // dropping max_id to the oldest hit so far and counting again.
  const all = corpus(5100);
  const server = searchServer(all);
  const finder = search.createFinder(clientWith({ search: server.handler }), noSleep);
  const result = await finder.find({ scope: { guildId: '888' }, authorId: ME });

  assert.equal(result.messages.length, 5100);
  assert.ok(
    server.requests.every((r) => Number(r.offset || 0) <= search.MAX_OFFSET),
    'no request ever asked for an offset Discord would refuse'
  );
  const windows = new Set(server.requests.map((r) => r.max_id));
  assert.ok(windows.size > 1, 'the window moved at least once');
});

test('an unbuilt index is waited out rather than reported as no results', async () => {
  const all = corpus(10);
  let calls = 0;
  const handler = (params) => {
    calls++;
    if (calls <= 2) {
      return { status: 202, body: { code: 110000, retry_after: 1, documents_indexed: 0 } };
    }
    const page = all.slice(Number(params.offset || 0), Number(params.offset || 0) + 25);
    return { status: 200, body: { total_results: all.length, messages: page.map((m) => [m]) } };
  };

  const waited = [];
  const finder = search.createFinder(clientWith({ search: handler }), {
    sleep: async (ms) => waited.push(ms),
  });
  const phases = [];
  const result = await finder.find({
    scope: { guildId: '888' },
    authorId: ME,
    onProgress: (p) => phases.push(p.phase),
  });

  assert.equal(result.messages.length, 10);
  assert.deepEqual(waited, [1000, 1000]);
  assert.ok(phases.includes('indexing'), 'the user is told why nothing is happening');
});

test('an index that never becomes ready gives up with a message people can act on', async () => {
  const handler = () => ({ status: 202, body: { retry_after: 1 } });
  const finder = search.createFinder(clientWith({ search: handler }), noSleep);

  await assert.rejects(
    finder.find({ scope: { guildId: '888' }, authorId: ME }),
    (err) => err.code === 'INDEX_NOT_READY' && /try again/i.test(err.message)
  );
});

test('a retry hint is clamped so a bogus one cannot stall for an hour', () => {
  assert.equal(search.indexWaitMs(200, { retry_after: 5 }), 0, 'only a 202 is a wait');
  assert.equal(search.indexWaitMs(202, { retry_after: 2 }), 2000);
  assert.equal(search.indexWaitMs(202, { retry_after: 99999 }), 30000);
  assert.equal(search.indexWaitMs(202, {}), 1000, 'a missing hint still waits');
});

test('a limit stops the search early and says the result was cut short', async () => {
  const server = searchServer(corpus(200));
  const finder = search.createFinder(clientWith({ search: server.handler }), noSleep);
  const result = await finder.find({ scope: { guildId: '888' }, authorId: ME, limit: 40 });

  assert.ok(result.messages.length >= 40);
  assert.equal(result.truncated, true);
});

test('a search can be stopped from outside while it is running', async () => {
  const server = searchServer(corpus(500));
  const finder = search.createFinder(clientWith({ search: server.handler }), noSleep);
  let seen = 0;
  const result = await finder.find({
    scope: { guildId: '888' },
    authorId: ME,
    onProgress: () => {
      seen++;
    },
    shouldStop: () => seen >= 3,
  });

  assert.equal(result.truncated, true);
  assert.ok(result.messages.length < 500);
});

test('history walks a channel backwards and keeps only this account', async () => {
  const mine = corpus(30);
  const theirs = corpus(30).map((m) => ({
    ...m,
    id: String(BigInt(m.id) + 1n),
    author: { id: '222222222222222222', username: 'someone' },
  }));
  const all = [...mine, ...theirs].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? 1 : -1));

  const seenParams = [];
  const history = (params) => {
    seenParams.push(params);
    let pool = all;
    if (params.before) pool = pool.filter((m) => BigInt(m.id) < BigInt(params.before));
    return pool.slice(0, params.limit);
  };

  const finder = search.createFinder(clientWith({ search: () => {}, history }), noSleep);
  const result = await finder.find({
    scope: { channelId: CHANNEL },
    authorId: ME,
    strategy: 'history',
  });

  assert.equal(result.messages.length, 30);
  assert.equal(result.strategy, 'history');
  assert.ok(result.messages.every((m) => m.authorId === ME));
  assert.equal(seenParams[0].limit, search.HISTORY_PAGE);
});

test('history stops once it walks past the start of the date range', async () => {
  const all = corpus(400);
  const history = (params) => {
    let pool = all;
    if (params.before) pool = pool.filter((m) => BigInt(m.id) < BigInt(params.before));
    return pool.slice(0, params.limit);
  };
  const finder = search.createFinder(clientWith({ search: () => {}, history }), noSleep);

  const floor = snowflake.fromMillis(Date.UTC(2024, 2, 1) + 300 * 60000);
  const result = await finder.find({
    scope: { channelId: CHANNEL },
    authorId: ME,
    strategy: 'history',
    minId: floor,
  });

  assert.ok(result.messages.every((m) => BigInt(m.id) >= BigInt(floor)));
  assert.ok(result.messages.length > 0);
  assert.ok(result.scanned < 400, 'it stopped rather than reading the whole channel');
});

test('a server can only be searched, never walked channel by channel', async () => {
  const server = searchServer(corpus(10));
  let historyCalls = 0;
  const finder = search.createFinder(
    clientWith({
      search: server.handler,
      history: () => {
        historyCalls++;
        return [];
      },
    }),
    noSleep
  );
  await finder.find({ scope: { guildId: '888' }, authorId: ME, strategy: 'auto' });
  assert.equal(historyCalls, 0);
});

test('a channel search that fails falls back to reading the channel directly', async () => {
  // A DM Discord has not indexed returns nothing useful from search. Reporting
  // no messages there would look like the tool is broken.
  const all = corpus(10);
  const finder = search.createFinder(
    clientWith({
      search: () => {
        throw Object.assign(new Error('nope'), { code: 'HTTP_ERROR', status: 500 });
      },
      history: (params) => (params.before ? [] : all.slice(0, params.limit)),
    }),
    noSleep
  );

  const result = await finder.find({ scope: { channelId: CHANNEL }, authorId: ME });
  assert.equal(result.strategy, 'history');
  assert.equal(result.messages.length, 10);
});

test('an empty channel search is double checked against the channel itself', async () => {
  const all = corpus(6);
  const finder = search.createFinder(
    clientWith({
      search: () => ({ status: 200, body: { total_results: 0, messages: [] } }),
      history: (params) => (params.before ? [] : all.slice(0, params.limit)),
    }),
    noSleep
  );

  const result = await finder.find({ scope: { channelId: CHANNEL }, authorId: ME });
  assert.equal(result.strategy, 'history');
  assert.equal(result.messages.length, 6);
});

test('a dead session is not retried as a fallback', async () => {
  // Falling back here would fire a second doomed request and report a confusing
  // "no messages" instead of "reconnect".
  let historyCalls = 0;
  const finder = search.createFinder(
    clientWith({
      search: () => {
        throw Object.assign(new Error('reconnect'), { code: 'UNAUTHORIZED' });
      },
      history: () => {
        historyCalls++;
        return [];
      },
    }),
    noSleep
  );

  await assert.rejects(finder.find({ scope: { channelId: CHANNEL }, authorId: ME }));
  assert.equal(historyCalls, 0);
});

test('a rate limit halt is not retried as a fallback either', async () => {
  let historyCalls = 0;
  const finder = search.createFinder(
    clientWith({
      search: () => {
        throw Object.assign(new Error('slow down'), { code: 'RATE_LIMIT_HALT' });
      },
      history: () => {
        historyCalls++;
        return [];
      },
    }),
    noSleep
  );

  await assert.rejects(finder.find({ scope: { channelId: CHANNEL }, authorId: ME }));
  assert.equal(historyCalls, 0);
});

test('searching nothing at all is refused rather than guessed at', async () => {
  const finder = search.createFinder(clientWith({ search: () => {} }), noSleep);
  await assert.rejects(finder.find({ scope: {}, authorId: ME }));
});

test('a channel restriction is passed to the server rather than filtered afterwards', async () => {
  const server = searchServer(corpus(10));
  const finder = search.createFinder(clientWith({ search: server.handler }), noSleep);
  await finder.find({
    scope: { guildId: '888', channelIds: ['1', '2'] },
    authorId: ME,
  });
  assert.deepEqual(server.requests[0].channel_id, ['1', '2']);
});

test('the author filter is always sent, so Discord never returns other people', async () => {
  const server = searchServer(corpus(10));
  const finder = search.createFinder(clientWith({ search: server.handler }), noSleep);
  await finder.find({ scope: { guildId: '888' }, authorId: ME });
  assert.ok(server.requests.every((r) => r.author_id === ME));
});

test('a message by somebody else never reaches the result set', async () => {
  // The request already asks Discord to filter by author. The answer is checked
  // anyway, because this list becomes a delete queue and an account with Manage
  // Messages would find the wrong delete succeeding rather than erroring.
  const mine = corpus(4);
  const theirs = corpus(4).map((m) => ({
    ...m,
    id: String(BigInt(m.id) + 1n),
    author: OTHER,
  }));
  const handler = () => ({
    status: 200,
    body: {
      total_results: 8,
      messages: [...mine, ...theirs].map((m) => [{ ...m, hit: true }]),
    },
  });

  const finder = search.createFinder(clientWith({ search: handler }), noSleep);
  const result = await finder.find({ scope: { guildId: '888' }, authorId: ME });

  assert.equal(result.messages.length, 4);
  assert.ok(result.messages.every((m) => m.authorId === ME));
});

/* ------------------------------------------------------------------ */
/* Threads                                                             */
/* ------------------------------------------------------------------ */

const THREAD = '777777777777777777';

test('a message posted in a thread is attributed to the channel the thread hangs off', () => {
  // Discord hands back the thread's own id on the message and the parent only
  // in a `threads` array beside it. Without reading that array, a thread message
  // belongs to an id the user was never offered and cannot have picked.
  const parents = search.parentsFrom({ threads: [{ id: THREAD, parent_id: CHANNEL }] });
  const message = search.normalise(raw(1, { channel_id: THREAD }), {
    guildId: '888',
    channelNameFor: (id) => (id === CHANNEL ? 'general' : ''),
  }, parents);

  assert.equal(message.channelId, THREAD, 'the delete still has to go to the thread');
  assert.equal(message.parentId, CHANNEL);
  assert.equal(message.channelName, 'general', 'named after the channel the user picked');
});

test('a message outside any thread carries no parent', () => {
  const message = search.normalise(raw(1), {}, search.parentsFrom({}));
  assert.equal(message.parentId, null);
});

test('narrowing to a channel keeps what was written in its threads', async () => {
  // The count on the review screen is the number this whole product is built
  // around, and it silently omitted every thread reply in the chosen channel.
  const inChannel = raw(1);
  const inThread = raw(2, { channel_id: THREAD });
  const handler = () => ({
    status: 200,
    body: {
      total_results: 2,
      threads: [{ id: THREAD, parent_id: CHANNEL }],
      messages: [[{ ...inChannel, hit: true }], [{ ...inThread, hit: true }]],
    },
  });

  const finder = search.createFinder(clientWith({ search: handler }), noSleep);
  const result = await finder.find({
    scope: { guildId: '888', channelIds: [CHANNEL] },
    authorId: ME,
  });

  assert.equal(result.messages.length, 2, 'both came back from the search');
  const kept = filter.apply(result.messages, { channelIds: [CHANNEL] });
  assert.equal(kept.length, 2, 'the thread reply is part of the job, not silently dropped');
  assert.ok(kept.some((m) => m.channelId === THREAD));
});

test('history paging walks backwards from the oldest of each page', async () => {
  // Pinned deliberately. `before` taking page[0] (the newest) re-requests the
  // same window for ever, and every pass appends the same messages again, so a
  // 40 message channel becomes a delete queue of hundreds of duplicates. The
  // whole suite stayed green through exactly that mutation.
  const all = corpus(250);
  const cursors = [];
  const history = (params) => {
    cursors.push(params.before || null);
    let pool = all;
    if (params.before) pool = pool.filter((m) => BigInt(m.id) < BigInt(params.before));
    return pool.slice(0, params.limit);
  };

  const finder = search.createFinder(clientWith({ search: () => {}, history }), noSleep);
  const result = await finder.find({ scope: { channelId: CHANNEL }, authorId: ME, strategy: 'history' });

  const ids = result.messages.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length, 'no message is collected twice');
  assert.equal(ids.length, all.length, 'and the whole channel is reached');
  // Strictly descending cursors are what proves the window actually moved.
  const walked = cursors.filter(Boolean).map(BigInt);
  for (let i = 1; i < walked.length; i++) {
    assert.ok(walked[i] < walked[i - 1], `cursor ${i} did not move backwards`);
  }
});
