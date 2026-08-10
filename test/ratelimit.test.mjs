import test from 'node:test';
import assert from 'node:assert/strict';
import { loadLib, STUB_CHROME, fakeClock, fakeResponse } from './helper.mjs';

const ctx = await loadLib(['lib/browser.js', 'lib/ratelimit.js'], { chrome: STUB_CHROME });
const rl = ctx.CL.ratelimit;

/** Headers a healthy Discord response carries. */
const okHeaders = (remaining = 4, resetAfter = 5, bucket = 'abc') => ({
  'x-ratelimit-bucket': bucket,
  'x-ratelimit-remaining': remaining,
  'x-ratelimit-reset-after': resetAfter,
});

test('paces consecutive writes to the same bucket by at least the floor', async () => {
  const clock = fakeClock();
  const limiter = rl.createLimiter({ now: clock.now, sleep: clock.sleep });
  const send = async () => fakeResponse(200, okHeaders());

  await limiter.run('DELETE /channels/1/messages', send, { write: true });
  await limiter.run('DELETE /channels/1/messages', send, { write: true });
  await limiter.run('DELETE /channels/1/messages', send, { write: true });

  // First request goes immediately, the next two each wait a full floor.
  assert.equal(clock.waits.length, 2);
  for (const w of clock.waits) assert.ok(w >= rl.MIN_WRITE_DELAY_MS, `wait ${w} below floor`);
});

test('refuses to go faster than the floor even when asked to', async () => {
  const clock = fakeClock();
  const limiter = rl.createLimiter({ now: clock.now, sleep: clock.sleep, minWriteDelayMs: 0 });
  const send = async () => fakeResponse(200, okHeaders());

  await limiter.run('DELETE /channels/1/messages', send, { write: true });
  await limiter.run('DELETE /channels/1/messages', send, { write: true });

  // A caller passing 0 is the exact footgun the floor exists to block.
  assert.ok(clock.waits[0] >= rl.MIN_WRITE_DELAY_MS);
});

test('paces requests to DIFFERENT routes, not just the same one', async () => {
  // Regression. The floor used to be per bucket, and a bucket id is only known
  // from a response, so the first request to each new route went out instantly.
  // Listing channels for fifty servers is fifty distinct routes, which left as
  // one burst. The end to end suite caught it; this pins it.
  const clock = fakeClock();
  const limiter = rl.createLimiter({ now: clock.now, sleep: clock.sleep });

  for (let i = 0; i < 5; i++) {
    await limiter.run(
      `GET /guilds/${i}/channels`,
      async () => fakeResponse(200, okHeaders(4, 5, `bucket-${i}`))
    );
  }

  assert.equal(clock.waits.length, 4, 'every request after the first should have waited');
  for (const w of clock.waits) {
    assert.ok(w >= rl.MIN_READ_DELAY_MS, `wait of ${w}ms is under the read floor`);
  }
});

test('a 429 does not let the next request skip its floor', async () => {
  // absorbHeaders is not reached on a 429, so recording the dispatch there used
  // to leave the following request thinking nothing had been sent.
  const clock = fakeClock();
  const limiter = rl.createLimiter({ now: clock.now, sleep: clock.sleep });

  let calls = 0;
  await limiter.run('GET /a', async () => {
    calls++;
    if (calls === 1) return fakeResponse(429, {}, { retry_after: 0.1 });
    return fakeResponse(200, okHeaders());
  });

  const at = clock.now();
  await limiter.run('GET /b', async () => fakeResponse(200, okHeaders(4, 5, 'other')));
  assert.ok(clock.now() - at >= rl.MIN_READ_DELAY_MS, 'request after a 429 skipped the floor');
});

test('waits out the window when a bucket reports no requests left', async () => {
  const clock = fakeClock();
  const limiter = rl.createLimiter({ now: clock.now, sleep: clock.sleep });

  await limiter.run('GET /channels/1/messages', async () => fakeResponse(200, okHeaders(0, 7)));
  await limiter.run('GET /channels/1/messages', async () => fakeResponse(200, okHeaders(4, 5)));

  // 7s window beats the read floor, so that is what it should have waited.
  assert.ok(clock.waits.at(-1) >= 7000, `expected a 7s wait, got ${clock.waits.at(-1)}`);
});

test('honours retry_after from the body on a 429, then succeeds', async () => {
  const clock = fakeClock();
  const limiter = rl.createLimiter({ now: clock.now, sleep: clock.sleep });

  let calls = 0;
  const res = await limiter.run('DELETE /channels/1/messages', async () => {
    calls++;
    if (calls === 1) return fakeResponse(429, {}, { retry_after: 3.5, global: false });
    return fakeResponse(200, okHeaders());
  }, { write: true });

  assert.equal(res.status, 200);
  assert.equal(calls, 2);
  assert.ok(clock.waits.includes(3500), `expected a 3500ms backoff, got ${clock.waits}`);
});

test('falls back to the Retry-After header when the 429 body is not JSON', async () => {
  // Cloudflare's 429 is an HTML page, so .json() throws. Getting this wrong
  // means defaulting to a 1s retry against the layer that IP bans you.
  const clock = fakeClock();
  const limiter = rl.createLimiter({ now: clock.now, sleep: clock.sleep });

  let calls = 0;
  await limiter.run('GET /channels/1/messages', async () => {
    calls++;
    if (calls === 1) {
      const r = fakeResponse(429, { 'retry-after': '12' });
      r.json = async () => {
        throw new Error('not json');
      };
      r.clone = () => r;
      return r;
    }
    return fakeResponse(200, okHeaders());
  });

  assert.ok(clock.waits.includes(12000), `expected a 12s backoff, got ${clock.waits}`);
});

test('a global 429 blocks a different route too', async () => {
  const clock = fakeClock();
  const limiter = rl.createLimiter({ now: clock.now, sleep: clock.sleep });

  await limiter.run('GET /a', async () => fakeResponse(200, okHeaders(4, 1, 'bucket-a')));

  let calls = 0;
  await limiter.run('GET /b', async () => {
    calls++;
    if (calls === 1) return fakeResponse(429, { 'x-ratelimit-global': 'true' }, { retry_after: 9 });
    return fakeResponse(200, okHeaders(4, 1, 'bucket-b'));
  });

  const before = clock.now();
  await limiter.run('GET /c', async () => fakeResponse(200, okHeaders(4, 1, 'bucket-c')));
  // /c shares nothing with /b, so only the global lock can hold it back. The
  // global wait was consumed by /b's own retry, so /c should be free by now.
  assert.ok(clock.now() - before < 9000);
  assert.ok(clock.waits.includes(9000));
});

test('halts the job rather than feeding Cloudflare more 429s', async () => {
  const clock = fakeClock();
  const limiter = rl.createLimiter({ now: clock.now, sleep: clock.sleep });

  await assert.rejects(
    limiter.run('DELETE /channels/1/messages', async () =>
      fakeResponse(429, {}, { retry_after: 1 })
    , { write: true }),
    (err) => err.code === 'RATE_LIMIT_HALT'
  );

  assert.equal(limiter.status().halted, true);
});

test('a halted limiter refuses later work until reset', async () => {
  const clock = fakeClock();
  const limiter = rl.createLimiter({ now: clock.now, sleep: clock.sleep });

  await assert.rejects(
    limiter.run('DELETE /x', async () => fakeResponse(429, {}, { retry_after: 1 }), { write: true })
  );
  await assert.rejects(limiter.run('GET /y', async () => fakeResponse(200, okHeaders())));

  limiter.reset();
  const res = await limiter.run('GET /y', async () => fakeResponse(200, okHeaders()));
  assert.equal(res.status, 200);
});

test('one failing request does not wedge the queue behind it', async () => {
  const clock = fakeClock();
  const limiter = rl.createLimiter({ now: clock.now, sleep: clock.sleep });

  const boom = limiter.run('GET /a', async () => {
    throw new Error('network down');
  });
  await assert.rejects(boom, /network down/);

  const res = await limiter.run('GET /b', async () => fakeResponse(200, okHeaders()));
  assert.equal(res.status, 200);
});

test('runs strictly one at a time', async () => {
  const clock = fakeClock();
  const limiter = rl.createLimiter({ now: clock.now, sleep: clock.sleep });

  let inFlight = 0;
  let peak = 0;
  const send = async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await Promise.resolve();
    inFlight--;
    return fakeResponse(200, okHeaders());
  };

  await Promise.all([
    limiter.run('GET /a', send),
    limiter.run('GET /b', send),
    limiter.run('GET /c', send),
  ]);

  assert.equal(peak, 1, 'parallel bursts from a user account are what gets flagged');
});

test('remaps a provisional lane onto the real bucket without granting a free request', async () => {
  const clock = fakeClock();
  const limiter = rl.createLimiter({ now: clock.now, sleep: clock.sleep });

  // Two different routes that Discord reports as sharing one bucket.
  await limiter.run('GET /route-one', async () => fakeResponse(200, okHeaders(0, 6, 'shared')));
  const before = clock.now();
  await limiter.run('GET /route-one', async () => fakeResponse(200, okHeaders(4, 6, 'shared')));

  assert.ok(clock.now() - before >= 6000, 'exhausted shared bucket should still be closed');
});

test('caps a single wait so a bogus header cannot hang a job for a day', () => {
  const headers = { get: (k) => (k === 'retry-after' ? '999999' : null) };
  assert.ok(rl.retryAfterMs(headers, null) <= 5 * 60 * 1000);
});

test('a 429 carrying no retry hint at all still backs off', () => {
  // The shape this fallback exists for. A 429 from Cloudflare rather than the
  // API is HTML, so there is no body to read, and it does not always carry a
  // Retry-After either. Number(null) is 0 and 0 is finite, so "use the header
  // if it parses" quietly accepted a header that was not there and waited no
  // time at all, on the one path in this file that must never hurry.
  const headers = { get: () => null };
  assert.equal(rl.retryAfterMs(headers, null), 1000);
});

test('a garbage retry header still backs off rather than reading as zero', () => {
  const headers = { get: (k) => (k === 'retry-after' ? 'soon' : null) };
  assert.equal(rl.retryAfterMs(headers, null), 1000);
});

test('a reset with no remaining count does not close a lane that was never full', async () => {
  // Same trap, other end. A missing x-ratelimit-remaining read as 0, which is
  // "this lane is spent", so a response carrying only a reset stalled the next
  // request for the whole window instead of the read floor.
  const clock = fakeClock();
  const limiter = rl.createLimiter({ now: clock.now, sleep: clock.sleep });

  const partial = { 'x-ratelimit-bucket': 'b', 'x-ratelimit-reset-after': 60 };
  await limiter.run('GET /a', async () => fakeResponse(200, partial));
  const before = clock.now();
  await limiter.run('GET /a', async () => fakeResponse(200, partial));

  const waited = clock.now() - before;
  assert.ok(waited >= rl.MIN_READ_DELAY_MS, `should still owe the read floor, waited ${waited}`);
  assert.ok(waited < 1000, `should not have stalled for the window, waited ${waited}`);
});
