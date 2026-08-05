import test from 'node:test';
import assert from 'node:assert/strict';
import { loadLib, STUB_CHROME } from './helper.mjs';

const ctx = await loadLib(
  ['lib/browser.js', 'lib/snowflake.js', 'lib/ratelimit.js', 'lib/filter.js', 'lib/job.js'],
  { chrome: STUB_CHROME }
);
const job = ctx.CL.job;
const snowflake = ctx.CL.snowflake;

/** Ids that sort the same way as real snowflakes, one per minute. */
function idAt(minute) {
  return snowflake.fromMillis(Date.UTC(2024, 2, 1) + minute * 60000);
}

function msg(minute, overrides = {}) {
  return { id: idAt(minute), channelId: '999999999999999999', type: 0, ...overrides };
}

function fail(code, message = 'nope') {
  return Object.assign(new Error(message), { code });
}

/**
 * `behaviour` is called with (messageId, op) before each call and may return an
 * error to throw instead of succeeding.
 */
function fakeClient(behaviour) {
  const calls = [];
  return {
    calls,
    async deleteMessage(channelId, messageId) {
      const err = behaviour && behaviour(messageId, 'delete', calls.length);
      calls.push({ op: 'delete', channelId, messageId });
      if (err) throw err;
      return null;
    },
    async editMessage(channelId, messageId, content) {
      const err = behaviour && behaviour(messageId, 'edit', calls.length);
      calls.push({ op: 'edit', channelId, messageId, content });
      if (err) throw err;
      return {};
    },
  };
}

test('every message is deleted and the run reports itself done', async () => {
  const client = fakeClient();
  const result = await job.createJob({ client, messages: [msg(1), msg(2), msg(3)] }).start();

  assert.equal(result.status, 'done');
  assert.equal(result.done, 3);
  assert.equal(result.failed, 0);
  assert.equal(result.remaining, 0);
  assert.equal(client.calls.length, 3);
});

test('messages are deleted oldest first regardless of the order handed in', async () => {
  // Discord applies a stricter bucket to old messages. Going oldest first pays
  // that cost at a steady rate instead of hitting it halfway through a run that
  // had until then looked fast.
  const client = fakeClient();
  await job.createJob({ client, messages: [msg(9), msg(1), msg(5)] }).start();

  const order = client.calls.map((c) => c.messageId);
  assert.deepEqual(order, [idAt(1), idAt(5), idAt(9)]);
});

test('a message that is already gone counts as done, not as a failure', async () => {
  // Otherwise running the same filter twice reports a wall of errors for work
  // that succeeded the first time.
  const client = fakeClient((id) => (id === idAt(2) ? fail('NOT_FOUND') : null));
  const result = await job.createJob({ client, messages: [msg(1), msg(2), msg(3)] }).start();

  assert.equal(result.done, 3);
  assert.equal(result.failed, 0);
  assert.equal(result.status, 'done');
});

test('a channel the account cannot write to is a skip with a stated reason', async () => {
  const client = fakeClient((id) => (id === idAt(2) ? fail('FORBIDDEN') : null));
  const result = await job.createJob({ client, messages: [msg(1), msg(2), msg(3)] }).start();

  assert.equal(result.done, 2);
  assert.equal(result.skipped, 1);
  assert.equal(result.skips.length, 1);
  assert.match(result.skips[0].reason, /permission/i);
});

test('a rate limit halt stops the run instead of pushing through it', async () => {
  // The limiter halts after four consecutive 429s because continuing is what
  // gets an IP blocked. The job must respect that rather than retrying.
  const client = fakeClient((id) => (id === idAt(2) ? fail('RATE_LIMIT_HALT', 'slow down') : null));
  const result = await job.createJob({ client, messages: [msg(1), msg(2), msg(3)] }).start();

  assert.equal(result.status, 'halted');
  assert.equal(result.error, 'slow down');
  assert.equal(result.done, 1);
  assert.equal(result.remaining, 2, 'the untouched messages are still accounted for');
  assert.equal(client.calls.length, 2, 'nothing was attempted after the halt');
});

test('a dead session stops the run rather than failing every message in turn', async () => {
  const client = fakeClient(() => fail('UNAUTHORIZED', 'reconnect and try again'));
  const result = await job.createJob({ client, messages: [msg(1), msg(2), msg(3)] }).start();

  assert.equal(result.status, 'halted');
  assert.equal(client.calls.length, 1);
});

test('ten unexplained failures in a row stop the run', async () => {
  const messages = Array.from({ length: 40 }, (_, i) => msg(i + 1));
  const client = fakeClient(() => fail('HTTP_ERROR', 'server error'));
  const result = await job.createJob({ client, messages }).start();

  assert.equal(result.status, 'halted');
  assert.equal(result.failed, job.MAX_CONSECUTIVE_FAILURES);
  assert.match(result.error, /failures in a row/i);
});

test('an occasional failure does not stop the run', async () => {
  const messages = Array.from({ length: 20 }, (_, i) => msg(i + 1));
  const client = fakeClient((id) => (id === idAt(5) || id === idAt(12) ? fail('HTTP_ERROR') : null));
  const result = await job.createJob({ client, messages }).start();

  assert.equal(result.status, 'done');
  assert.equal(result.failed, 2);
  assert.equal(result.done, 18);
  assert.equal(result.failures.length, 2);
});

test('edit then delete writes twice per message, in that order', async () => {
  const client = fakeClient();
  const result = await job
    .createJob({
      client,
      messages: [msg(1), msg(2)],
      action: 'edit-then-delete',
      editContent: 'removed',
    })
    .start();

  assert.equal(result.done, 2);
  assert.deepEqual(
    client.calls.map((c) => c.op),
    ['edit', 'delete', 'edit', 'delete']
  );
  assert.equal(client.calls[0].content, 'removed');
});

test('the edit only action never deletes anything', async () => {
  const client = fakeClient();
  await job
    .createJob({ client, messages: [msg(1), msg(2)], action: 'edit', editContent: '.' })
    .start();

  assert.equal(client.calls.filter((c) => c.op === 'delete').length, 0);
  assert.equal(client.calls.filter((c) => c.op === 'edit').length, 2);
});

test('an empty replacement is refused before anything is written', () => {
  // Discord answers an empty edit with a 400 that reads like a bug in the tool,
  // so it is caught where the message can say what to do about it.
  assert.throws(
    () => job.createJob({ client: fakeClient(), messages: [msg(1)], action: 'edit', editContent: '   ' }),
    (err) => err.code === 'CONTENT_EMPTY'
  );
});

test('a replacement longer than Discord allows is refused up front', () => {
  assert.throws(
    () =>
      job.createJob({
        client: fakeClient(),
        messages: [msg(1)],
        action: 'edit',
        editContent: 'x'.repeat(job.MAX_CONTENT + 1),
      }),
    (err) => err.code === 'CONTENT_TOO_LONG'
  );
});

test('an unknown action is refused', () => {
  assert.throws(() => job.createJob({ client: fakeClient(), messages: [], action: 'burn' }));
});

test('a system message is skipped without being attempted', async () => {
  // Join notices and pin notices come back in search results attributed to the
  // user but cannot be deleted, so attempting them only produces noise.
  const client = fakeClient();
  const result = await job
    .createJob({ client, messages: [msg(1), msg(2, { type: 7 }), msg(3)] })
    .start();

  assert.equal(result.done, 2);
  assert.equal(result.skipped, 1);
  assert.equal(client.calls.length, 2, 'the system message never reached the API');
  assert.match(result.skips[0].reason, /does not allow/i);
});

test('cancelling stops the run where it stands', async () => {
  let runner;
  const client = fakeClient((id, op, callCount) => {
    if (callCount === 2) runner.cancel();
    return null;
  });
  runner = job.createJob({ client, messages: [msg(1), msg(2), msg(3), msg(4), msg(5)] });
  const result = await runner.start();

  assert.equal(result.status, 'cancelled');
  assert.equal(result.done, 3);
  assert.ok(result.remaining > 0);
  assert.equal(client.calls.length, 3);
});

test('a paused run holds until it is resumed', async () => {
  let runner;
  const client = fakeClient((id, op, callCount) => {
    if (callCount === 2) runner.pause();
    return null;
  });
  runner = job.createJob({ client, messages: [msg(1), msg(2), msg(3), msg(4)] });

  const running = runner.start();
  await new Promise((r) => setTimeout(r, 25));

  assert.equal(runner.status, 'paused');
  assert.equal(client.calls.length, 3, 'the message in flight finished, nothing new started');

  runner.resume();
  const result = await running;
  assert.equal(result.status, 'done');
  assert.equal(result.done, 4);
});

test('cancelling a paused run releases it rather than leaving it stuck', async () => {
  let runner;
  const client = fakeClient((id, op, callCount) => {
    if (callCount === 1) runner.pause();
    return null;
  });
  runner = job.createJob({ client, messages: [msg(1), msg(2), msg(3)] });

  const running = runner.start();
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(runner.status, 'paused');

  runner.cancel();
  const result = await running;
  assert.equal(result.status, 'cancelled');
});

test('progress is reported as the run moves', async () => {
  const seen = [];
  const client = fakeClient();
  await job
    .createJob({
      client,
      messages: [msg(1), msg(2), msg(3)],
      onProgress: (p) => seen.push(p.processed),
    })
    .start();

  assert.ok(seen.includes(1) && seen.includes(2) && seen.includes(3));
  assert.equal(seen[seen.length - 1], 3);
});

test('the estimate is built from the write floor, so it is honest before the run starts', async () => {
  const floor = ctx.CL.ratelimit.MIN_WRITE_DELAY_MS;
  const plain = job.createJob({ client: fakeClient(), messages: [msg(1), msg(2), msg(3)] });
  assert.equal(plain.estimateMs(), 3 * floor);

  const both = job.createJob({
    client: fakeClient(),
    messages: [msg(1), msg(2), msg(3)],
    action: 'edit-then-delete',
    editContent: '.',
  });
  assert.equal(both.estimateMs(), 3 * 2 * floor, 'two writes per message takes twice as long');
});

test('the estimate reaches zero once the run is finished', async () => {
  const runner = job.createJob({ client: fakeClient(), messages: [msg(1), msg(2)] });
  await runner.start();
  assert.equal(runner.estimateMs(), 0);
});

test('an empty queue finishes immediately rather than hanging', async () => {
  const result = await job.createJob({ client: fakeClient(), messages: [] }).start();
  assert.equal(result.status, 'done');
  assert.equal(result.total, 0);
});

test('failures carry the message so they can be retried', async () => {
  const client = fakeClient((id) => (id === idAt(2) ? fail('HTTP_ERROR', 'gateway blew up') : null));
  const result = await job.createJob({ client, messages: [msg(1), msg(2)] }).start();

  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].message.id, idAt(2));
  assert.equal(result.failures[0].reason, 'gateway blew up');
});
