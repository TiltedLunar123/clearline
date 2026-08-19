import test from 'node:test';
import assert from 'node:assert/strict';
import { loadLib, STUB_CHROME } from './helper.mjs';

const ctx = await loadLib(
  ['lib/browser.js', 'lib/i18n.js', 'lib/snowflake.js', 'lib/ratelimit.js', 'lib/filter.js', 'lib/job.js'],
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

test('an overwrite of a message that is already gone is not reported as an overwrite', async () => {
  /*
   * "Gone counts as done" is right for the two actions that set out to be rid of
   * the message, and wrong for the one that sets out to leave it standing with
   * different words in it. The text was never replaced and the message went
   * somewhere the user did not send it, and the run said it had overwritten it,
   * in the document that exists to be the record of what a run did.
   */
  const client = fakeClient((id) => (id === idAt(2) ? fail('NOT_FOUND') : null));
  const result = await job
    .createJob({ client, action: 'edit', editContent: 'x', messages: [msg(1), msg(2), msg(3)] })
    .start();

  assert.equal(result.done, 2, 'only the two that were actually rewritten');
  assert.equal(result.skipped, 1);
  assert.equal(result.failed, 0, 'and it is not an error either, since nothing went wrong');
  assert.match(result.skips[0].reason, /gone|no longer/i);
});

test('deleting a message that is already gone is still a success', async () => {
  // The other half of the same rule. Being rid of it is the outcome asked for,
  // however it came about, and edit-then-delete ends in the same place.
  for (const action of ['delete', 'edit-then-delete']) {
    const client = fakeClient((id) => (id === idAt(2) ? fail('NOT_FOUND') : null));
    const result = await job
      .createJob({ client, action, editContent: 'x', messages: [msg(1), msg(2), msg(3)] })
      .start();
    assert.equal(result.done, 3, `${action} treated a gone message as unfinished business`);
    assert.equal(result.skipped, 0, action);
  }
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

test('a run halted by failures does not offer to redo the one it failed on', async () => {
  /*
   * The message the tenth failure lands on is counted as a failure and was also
   * left sitting under the index the remaining queue is sliced from, so it came
   * back in both piles: the report said thirty were never reached and the button
   * beside it offered to carry on with thirty-one, the extra one being the
   * message named in the failure list directly above. Retry the failures and
   * carry on with the rest, and it went round twice.
   *
   * Checked as the same invariant the cancel path is checked against, since the
   * two halts want the same arithmetic and only one of them had it.
   */
  const messages = Array.from({ length: 40 }, (_, i) => msg(i + 1));
  const client = fakeClient(() => fail('HTTP_ERROR', 'server error'));
  const result = await job.createJob({ client, messages }).start();

  assert.equal(result.status, 'halted');
  assert.equal(result.remaining, result.remainingMessages.length, 'the count and the list agree');
  assert.equal(
    result.done + result.failed + result.skipped + result.remainingMessages.length,
    messages.length,
    'every message is in exactly one pile'
  );
  const failedIds = new Set(result.failures.map((f) => f.message.id));
  const carried = result.remainingMessages.filter((m) => failedIds.has(m.id));
  assert.deepEqual(carried, [], 'nothing is offered for retry and for carrying on at once');
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
  // Asserted on the message, not just on "it threw". An unknown action is
  // treated as an edit further down, so with no editContent this used to throw
  // CONTENT_EMPTY and pass for the wrong reason: deleting the allow-list check
  // entirely left the suite green while "burn" quietly became edit-then-delete.
  assert.throws(
    () => job.createJob({ client: fakeClient(), messages: [], action: 'burn', editContent: 'x' }),
    (err) => /unknown action/i.test(err.message)
  );
});

test('every action the allow-list names is actually accepted', () => {
  for (const action of job.ACTIONS) {
    assert.doesNotThrow(
      () => job.createJob({ client: fakeClient(), messages: [], action, editContent: 'x' }),
      `${action} should be a usable action`
    );
  }
});

test('a message type Discord refuses is skipped without being attempted', async () => {
  // A call notice cannot be removed by anyone, so attempting it only spends a
  // paced write to be told so.
  const client = fakeClient();
  const result = await job
    .createJob({ client, messages: [msg(1), msg(2, { type: 3 }), msg(3)] })
    .start();

  assert.equal(result.done, 2);
  assert.equal(result.skipped, 1);
  assert.equal(client.calls.length, 2, 'the system message never reached the API');
  assert.match(result.skips[0].reason, /does not allow/i);
});

test('a delete run removes a join notice, which is the account’s own trace', async () => {
  // The whole product is "clear what you left behind", and a join notice is as
  // much a part of that as anything typed. Discord deletes it for its author.
  // It used to be refused here and reported as something Discord would not
  // allow, which was untrue and left it in place permanently.
  const client = fakeClient();
  const result = await job
    .createJob({ client, messages: [msg(1), msg(2, { type: 7 }), msg(3, { type: 18 })] })
    .start();

  assert.equal(result.done, 3);
  assert.equal(result.skipped, 0);
  assert.equal(client.calls.length, 3, 'all three reached the API');
});

test('an overwrite run still refuses the same join notice', async () => {
  // The other half of the split. There is no content behind a system notice to
  // replace, and the PATCH comes back a plain 400, which lands in the failure
  // pile and counts toward the limit that halts the whole run.
  const client = fakeClient();
  const result = await job
    .createJob({
      client,
      messages: [msg(1), msg(2, { type: 7 })],
      action: 'edit',
      editContent: 'gone',
    })
    .start();

  assert.equal(result.done, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.failed, 0, 'refused here rather than at Discord');
  assert.equal(client.calls.length, 1, 'no write was spent on it');
  assert.match(result.skips[0].reason, /chang|edit/i);
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

test('time spent paused does not count against the estimate', async () => {
  // The estimate switches to the measured rate once a few writes are in, and
  // it measured wall clock. A run left paused over a coffee came back saying
  // it had hours to go, because every minute of standing still was folded in
  // as though it had been spent working.
  let clock = 1000;
  let runner;
  const reported = [];
  const client = fakeClient((id, op, callCount) => {
    clock += 900;
    if (callCount === 3) runner.pause();
    return null;
  });

  runner = job.createJob({
    client,
    now: () => clock,
    messages: [msg(1), msg(2), msg(3), msg(4), msg(5), msg(6), msg(7), msg(8)],
    onProgress: (p) => reported.push(p.etaMs),
  });

  const running = runner.start();
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(runner.status, 'paused');

  const beforeResume = reported.length;
  clock += 30 * 60 * 1000; // half an hour of doing nothing
  runner.resume();
  await running;

  const after = reported.slice(beforeResume).filter((ms) => ms > 0);
  assert.ok(after.length > 0, 'the run reported an estimate after resuming');
  const worst = Math.max(...after);
  assert.ok(
    worst < 60 * 1000,
    `a handful of messages at about a second each is a minute at most, got ${worst}`
  );
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

test('a message written by somebody else is refused, not deleted', async () => {
  // The last of three checks on authorship, and the only one that sits directly
  // in front of an irreversible call. On an account with Manage Messages the
  // delete would otherwise succeed against someone else's message.
  const client = fakeClient();
  const result = await job
    .createJob({
      client,
      authorId: '111111111111111111',
      messages: [
        { ...msg(1), authorId: '111111111111111111' },
        { ...msg(2), authorId: '222222222222222222' },
        { ...msg(3), authorId: '111111111111111111' },
      ],
    })
    .start();

  assert.equal(result.done, 2);
  assert.equal(result.skipped, 1);
  assert.equal(client.calls.length, 2, 'the other account\'s message never reached the API');
  assert.match(result.skips[0].reason, /written by this account/i);
});

test('a message with no author on it is refused rather than assumed to be mine', async () => {
  // The guard used to require the message to carry an author before it would
  // compare, so a blank one skipped the check entirely and went through. That
  // is the wrong way round for the last check in front of an irreversible
  // call: not knowing whose a message is has to fail closed, or the one case
  // the check exists for is the one case it does not cover.
  const client = fakeClient();
  const result = await job
    .createJob({
      client,
      authorId: '111111111111111111',
      messages: [
        { ...msg(1), authorId: '111111111111111111' },
        { ...msg(2), authorId: '' },
        { ...msg(3) },
      ],
    })
    .start();

  assert.equal(client.calls.length, 1, 'only the message known to be mine was touched');
  assert.equal(result.done, 1);
  assert.equal(result.skipped, 2);
});

test('the author check does not get in the way when it is not configured', async () => {
  const client = fakeClient();
  const result = await job.createJob({ client, messages: [msg(1), msg(2)] }).start();
  assert.equal(result.done, 2);
});

test('failures carry the message so they can be retried', async () => {
  const client = fakeClient((id) => (id === idAt(2) ? fail('HTTP_ERROR', 'gateway blew up') : null));
  const result = await job.createJob({ client, messages: [msg(1), msg(2)] }).start();

  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].message.id, idAt(2));
  assert.equal(result.failures[0].reason, 'gateway blew up');
});

test('an edit run leaves alone the message types Discord will not let it change', async () => {
  // The type guard was applied to delete and edit-then-delete and skipped for
  // edit, so an edit-only run spent a paced write on a join notice Discord
  // always refuses. That refusal comes back as a plain 400, which lands in the
  // failure pile rather than the skip pile, blames the wrong thing, and counts
  // toward the consecutive-failure limit that halts the whole run.
  const client = fakeClient();
  const result = await job
    .createJob({
      client,
      messages: [msg(1), msg(2, { type: 7 }), msg(3)],
      action: 'edit',
      editContent: 'gone',
    })
    .start();

  assert.equal(result.done, 2);
  assert.equal(result.skipped, 1);
  assert.equal(result.failed, 0);
  assert.equal(client.calls.length, 2, 'the join notice must never reach the API');
  assert.equal(
    client.calls.some((c) => c.messageId === idAt(2)),
    false
  );
});

test('an edit run says a message could not be changed, not that it could not be deleted', async () => {
  const result = await job
    .createJob({
      client: fakeClient(),
      messages: [msg(1, { type: 7 })],
      action: 'edit',
      editContent: 'gone',
    })
    .start();

  assert.equal(result.skips.length, 1);
  assert.equal(result.skips[0].reason, ctx.CL.i18n.t('reasonUneditable'));
  assert.notEqual(result.skips[0].reason, ctx.CL.i18n.t('reasonUndeletable'));
});

test('overwrite then delete still reports the refusal as a delete refusal', async () => {
  // This one does try to delete, so the existing wording is the accurate one.
  const result = await job
    .createJob({
      client: fakeClient(),
      messages: [msg(1, { type: 7 })],
      action: 'edit-then-delete',
      editContent: 'gone',
    })
    .start();

  assert.equal(result.skips[0].reason, ctx.CL.i18n.t('reasonUndeletable'));
});

test('a stopped run hands back the messages it never reached', async () => {
  // A run that halts or is cancelled used to be a dead end: the count of what
  // was never attempted was reported and the queue behind it stayed private, so
  // the only way on was to search the whole server again and redo every
  // exclusion by hand. On a set that took twenty minutes to page, that is a
  // reason not to stop a run that should be stopped.
  let runner;
  const client = fakeClient((id, op, callCount) => {
    if (callCount === 2) runner.cancel();
    return null;
  });
  const queue = [msg(1), msg(2), msg(3), msg(4), msg(5)];
  runner = job.createJob({ client, messages: queue });
  const result = await runner.start();

  assert.equal(result.status, 'cancelled');
  assert.equal(result.remaining, result.remainingMessages.length, 'the count and the list agree');
  assert.ok(result.remainingMessages.length > 0);
  // Ordered oldest first, like the queue, so carrying on resumes rather than
  // starting somewhere arbitrary.
  const ids = result.remainingMessages.map((m) => m.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => snowflake.compare(a, b)));
  // And nothing already handled comes back round for a second attempt.
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(result.done + result.failed + result.skipped + ids.length, queue.length);
});

test('carrying on from a stopped run finishes exactly what was left', async () => {
  const mine = (minute) => msg(minute, { authorId: 'me' });
  let first;
  const client = fakeClient((id, op, callCount) => {
    if (callCount === 2) first.cancel();
    return null;
  });
  first = job.createJob({
    client,
    authorId: 'me',
    messages: [mine(1), mine(2), mine(3), mine(4), mine(5)],
  });
  const stopped = await first.start();

  const second = job.createJob({
    client: fakeClient(),
    messages: stopped.remainingMessages,
    authorId: 'me',
  });
  const finished = await second.start();

  assert.equal(finished.status, 'done');
  assert.equal(finished.done, stopped.remaining);
  assert.equal(finished.remainingMessages.length, 0);
});

test('the resumed queue is checked again rather than waved through as vetted', async () => {
  // The tail goes back through createJob like any other queue, which is the
  // whole reason it is safe to hand it back. Anything that cannot be confirmed
  // as this account's is refused on the second pass exactly as on the first.
  let first;
  const client = fakeClient((id, op, callCount) => {
    if (callCount === 1) first.cancel();
    return null;
  });
  first = job.createJob({ client, messages: [msg(1), msg(2), msg(3)] });
  const stopped = await first.start();
  assert.ok(stopped.remainingMessages.length > 0);

  const resumed = await job
    .createJob({ client: fakeClient(), messages: stopped.remainingMessages, authorId: 'me' })
    .start();

  assert.equal(resumed.done, 0, 'none of them carry an author, so none are attempted');
  assert.equal(resumed.skipped, stopped.remainingMessages.length);
  assert.match(resumed.skips[0].reason, /written by this account/i);
});

test('a finished run has nothing left to carry on with', async () => {
  const result = await job.createJob({ client: fakeClient(), messages: [msg(1), msg(2)] }).start();
  assert.equal(result.status, 'done');
  assert.deepEqual(result.remainingMessages, []);
});

test('time spent paused is not counted as time the run took', async () => {
  // The report prints this as how long it took. A run left paused over lunch is
  // not a four hour run, and the same number drives the estimate that tells
  // somebody whether to wait.
  let clock = 1000;
  const now = () => clock;
  let runner;
  const client = fakeClient((id, op, callCount) => {
    if (callCount === 1) {
      runner.pause();
      clock += 60 * 60 * 1000;
      runner.resume();
    }
    clock += 10;
    return null;
  });
  runner = job.createJob({ client, messages: [msg(1), msg(2)], now });
  const result = await runner.start();

  assert.equal(result.status, 'done');
  assert.ok(
    result.elapsedMs < 60 * 60 * 1000,
    `an hour of standing still was billed as work: ${result.elapsedMs}ms`
  );
});
