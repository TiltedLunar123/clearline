/**
 * Request pacing for the Discord API.
 *
 * This is the file that decides whether a user still has an account tomorrow,
 * so it is deliberately the most conservative part of the extension.
 *
 * Three separate limits apply and they fail in different ways:
 *
 *   Per bucket    Discord groups routes into buckets and returns the bucket id
 *                 in X-RateLimit-Bucket. The id is not knowable before the
 *                 first response, so a route waits on a provisional lane keyed
 *                 by its own template and gets remapped once the real id
 *                 arrives. Two routes can share one bucket, which is why the
 *                 mapping is a lookup rather than a field on the route.
 *
 *   Global        Roughly 50 requests a second for the whole account. Blowing
 *                 it returns 429 with global:true, and the reset applies to
 *                 every route at once.
 *
 *   Cloudflare    Sits above the API and bans the IP for an hour after about
 *                 10,000 429s in ten minutes. This is the one that actually
 *                 hurts, and it is why a 429 here is treated as a mistake to
 *                 back away from rather than as ordinary flow control. Code
 *                 that "just retries on 429" walks straight into it.
 *
 * Everything is serialised through one queue. Concurrency would buy very little
 * on the workloads this extension runs, all of which are inherently sequential
 * (page through history, then act on one message at a time), and parallel bursts
 * from a user account are the pattern most likely to be flagged. Sequential is
 * both simpler to reason about and the safer shape.
 *
 * The clock and sleep are injected so the tests can run a thousand simulated
 * seconds instantly instead of actually waiting.
 */
CL.ratelimit = (function () {
  'use strict';

  /**
   * Floor on the gap between two writes to the same bucket.
   *
   * Discord will often allow faster than this. The floor exists anyway, because
   * the failure mode it prevents is not a slow export, it is a user dragging a
   * delay slider to zero, hammering delete for an hour and losing the account.
   * Users are not offered a way below this.
   */
  const MIN_WRITE_DELAY_MS = 900;

  /** Reads are cheap and non destructive, so they get a much lower floor. */
  const MIN_READ_DELAY_MS = 250;

  /**
   * Consecutive 429s that mean "stop, something is wrong".
   *
   * Backing off further would still be generating the 429s that Cloudflare
   * counts, so past this point the job halts and tells the user instead.
   */
  const MAX_CONSECUTIVE_429 = 4;

  /** Ceiling on any single wait, so a bogus header cannot hang a job for a day. */
  const MAX_WAIT_MS = 5 * 60 * 1000;

  function defaultSleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * A header that is absent is not a zero.
   *
   * `Number(headers.get(name))` is the trap, and it is worth naming because it
   * reads as correct: a missing header comes back null, `Number(null)` is 0,
   * and 0 is finite, so every "use it if it parses" check treats a header that
   * was never sent as a real value of zero. Both readings below were wrong in
   * the same way and in opposite directions, one hurrying and one stalling.
   */
  function headerNumber(headers, name) {
    const raw = headers.get(name);
    if (raw === null || raw === undefined || raw === '') return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  }

  /**
   * Discord sends seconds, sometimes fractional, in two places that disagree:
   * the JSON body's `retry_after` and the `Retry-After` header. The body is
   * more precise when present. Both are seconds despite the header's HTTP
   * convention being different, which has bitten enough clients to be worth
   * stating.
   *
   * The one second fallback is for the case with neither: a 429 from
   * Cloudflare rather than the API is HTML, so there is no body, and it does
   * not reliably carry a Retry-After either. That is the shape this whole file
   * is most careful about, and it was the shape that waited no time at all.
   */
  function retryAfterMs(headers, body) {
    const fromBody = body && typeof body.retry_after === 'number' ? body.retry_after : null;
    const fromHeader = headerNumber(headers, 'retry-after');
    const seconds = fromBody !== null ? fromBody : fromHeader !== null ? fromHeader : 1;
    return Math.min(Math.max(seconds * 1000, 0), MAX_WAIT_MS);
  }

  function createLimiter(options) {
    const opts = options || {};
    const now = opts.now || (() => Date.now());
    const sleep = opts.sleep || defaultSleep;
    const onEvent = opts.onEvent || (() => {});
    const minWriteDelay = Math.max(
      MIN_WRITE_DELAY_MS,
      Number(opts.minWriteDelayMs) || MIN_WRITE_DELAY_MS
    );

    // Provisional route key -> real bucket id, learned from responses.
    const bucketOf = new Map();
    // Lane id -> pacing state for that bucket.
    const lanes = new Map();

    let globalResetAt = 0;
    let consecutive429 = 0;
    let tail = Promise.resolve();
    let halted = null;

    /**
     * When the last request of any kind went out.
     *
     * The floor is deliberately global rather than per bucket. A per-bucket
     * floor looks equivalent and is not: a bucket id is only knowable from a
     * response, so the first request to every new route starts on its own
     * provisional lane with no history and goes out instantly. Listing the
     * channels of fifty servers is fifty distinct routes, so a per-bucket floor
     * would have let that leave as fifty requests inside a few milliseconds.
     * That burst is the exact pattern this file exists to prevent, and the end
     * to end suite caught it doing precisely that.
     *
     * Everything is serialised anyway, so one global floor is both stricter and
     * simpler to reason about than per-lane bookkeeping.
     */
    let lastDispatchAt = 0;

    function laneFor(routeKey) {
      const id = bucketOf.get(routeKey) || routeKey;
      let lane = lanes.get(id);
      if (!lane) {
        lane = { remaining: Infinity, resetAt: 0 };
        lanes.set(id, lane);
      }
      return lane;
    }

    /** How long this request has to wait before it is allowed to go out. */
    function waitFor(routeKey, isWrite) {
      const lane = laneFor(routeKey);
      const t = now();
      const floor = isWrite ? minWriteDelay : MIN_READ_DELAY_MS;

      const waits = [
        globalResetAt - t,
        // A lane with no requests left is closed until its window rolls over.
        lane.remaining <= 0 ? lane.resetAt - t : 0,
        lastDispatchAt === 0 ? 0 : lastDispatchAt + floor - t,
      ];

      return Math.min(Math.max(0, Math.max.apply(null, waits)), MAX_WAIT_MS);
    }

    function absorbHeaders(routeKey, headers) {
      const bucket = headers.get('x-ratelimit-bucket');
      if (bucket && bucketOf.get(routeKey) !== bucket) {
        // Carry the provisional lane's timing across so the remap does not
        // hand out a free request against a bucket that is already exhausted.
        const provisional = lanes.get(routeKey);
        bucketOf.set(routeKey, bucket);
        if (provisional && !lanes.has(bucket)) lanes.set(bucket, provisional);
      }

      const lane = laneFor(routeKey);
      const remaining = headerNumber(headers, 'x-ratelimit-remaining');
      const resetAfter = headerNumber(headers, 'x-ratelimit-reset-after');

      if (remaining !== null) lane.remaining = remaining;
      if (resetAfter !== null) lane.resetAt = now() + resetAfter * 1000;
    }

    /**
     * Run one request, paced.
     *
     * `send` is called with no arguments and must resolve to a fetch Response.
     * It may be called more than once, so it has to be safe to repeat: that is
     * fine for the idempotent verbs this extension uses (GET, DELETE, PATCH by
     * message id) and is the reason nothing here ever retries a POST.
     */
    function run(routeKey, send, config) {
      const cfg = config || {};
      const isWrite = !!cfg.write;

      const job = tail.then(async () => {
        if (halted) throw halted;

        for (let attempt = 0; ; attempt++) {
          const wait = waitFor(routeKey, isWrite);
          if (wait > 0) {
            onEvent({ type: 'wait', routeKey, ms: wait });
            await sleep(wait);
          }

          // Stamped before the call, not after it, and not in absorbHeaders:
          // a 429 never reaches absorbHeaders, so recording the dispatch there
          // would let the request after a rate limit skip its floor.
          lastDispatchAt = now();
          const response = await send();

          if (response.status !== 429) {
            absorbHeaders(routeKey, response.headers);
            consecutive429 = 0;
            return response;
          }

          // Past this point we are in 429 handling, which is a failure path.
          consecutive429++;
          let body = null;
          try {
            body = await response.clone().json();
          } catch {
            // A 429 from Cloudflare rather than the API is HTML, not JSON.
            // Falling back to the header is the whole point of the try.
          }

          const ms = retryAfterMs(response.headers, body);
          const isGlobal = !!(body && body.global) || headers429IsGlobal(response.headers);
          if (isGlobal) globalResetAt = now() + ms;
          else {
            const lane = laneFor(routeKey);
            lane.remaining = 0;
            lane.resetAt = now() + ms;
          }

          onEvent({ type: 'throttled', routeKey, ms, global: isGlobal, consecutive: consecutive429 });

          if (consecutive429 >= MAX_CONSECUTIVE_429) {
            halted = new Error(
              'Discord is rate limiting every request. Stopping so this does not turn into ' +
                'an IP block. Wait a few minutes and start again.'
            );
            halted.code = 'RATE_LIMIT_HALT';
            throw halted;
          }

          await sleep(ms);
        }
      });

      // The queue must survive a failed job, or one error wedges every request
      // behind it. Errors still reach the caller through `job`.
      tail = job.then(
        () => {},
        () => {}
      );
      return job;
    }

    function headers429IsGlobal(headers) {
      const flag = headers.get('x-ratelimit-global');
      return flag === 'true' || headers.get('x-ratelimit-scope') === 'global';
    }

    /** Lets the UI show why nothing is happening. */
    function status() {
      return {
        halted: !!halted,
        consecutive429,
        globalWaitMs: Math.max(0, globalResetAt - now()),
        lanes: lanes.size,
      };
    }

    function reset() {
      halted = null;
      consecutive429 = 0;
      globalResetAt = 0;
      lanes.clear();
      bucketOf.clear();
      // lastDispatchAt is deliberately kept. Reset exists to recover from a
      // halt, and the moment after a halt is when pacing matters most, so the
      // next request still owes the floor.
    }

    return { run, status, reset };
  }

  return {
    createLimiter,
    retryAfterMs,
    MIN_WRITE_DELAY_MS,
    MIN_READ_DELAY_MS,
    MAX_CONSECUTIVE_429,
  };
})();
