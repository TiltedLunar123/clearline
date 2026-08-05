/**
 * The destructive run.
 *
 * One message at a time, in order, through the limiter, with the user able to
 * stop it at any point. Nothing here is clever on purpose: this is the code that
 * cannot be undone, so it is written to be read rather than to be fast.
 *
 * Ordering is oldest first. Discord applies a stricter bucket to deleting old
 * messages, and going oldest first means that cost is paid at a steady rate from
 * the start instead of appearing halfway through a run that had until then been
 * moving quickly. A run whose pace is predictable is one a person is willing to
 * leave alone, and a person who leaves it alone is not reloading the tab and
 * starting a second copy of the same job.
 *
 * Errors are sorted into three piles rather than one. A message that is already
 * gone is a success with nothing to do. A message in a channel that has since
 * gone read only is a skip and will never succeed. Anything else is a failure
 * worth showing and worth offering to retry. Collapsing those into a single
 * count is what makes the alternatives to this tool feel like they are lying.
 */
CL.job = (function () {
  'use strict';

  /** Discord's own ceiling on message content. */
  const MAX_CONTENT = 2000;

  /**
   * Consecutive unexpected failures before the run gives up.
   *
   * Not about any single message. Ten in a row means the session died, the
   * network went, or Discord changed something, and continuing would turn one
   * problem into a thousand identical log lines.
   */
  const MAX_CONSECUTIVE_FAILURES = 10;

  const ACTIONS = ['delete', 'edit', 'edit-then-delete'];

  /**
   * How long the run should take, in milliseconds.
   *
   * Honest because the pacing is deterministic: the write floor is known, the
   * queue is serial, and the number of writes per message is known from the
   * action. Once a few messages are done the measured rate takes over, since it
   * folds in whatever Discord is actually granting.
   */
  function estimateMs(remaining, writesPerMessage, measuredPerWrite) {
    const perWrite = measuredPerWrite || CL.ratelimit.MIN_WRITE_DELAY_MS;
    return Math.round(remaining * writesPerMessage * perWrite);
  }

  function createJob(config) {
    const cfg = config || {};
    const client = cfg.client;
    const action = cfg.action || 'delete';
    const now = cfg.now || (() => Date.now());
    const onProgress = cfg.onProgress || (() => {});
    const onLog = cfg.onLog || (() => {});

    if (ACTIONS.indexOf(action) === -1) throw new Error(`Unknown action "${action}".`);

    const edits = action !== 'delete';
    const editContent = cfg.editContent === undefined ? '' : String(cfg.editContent);
    if (edits && editContent.length > MAX_CONTENT) {
      throw Object.assign(new Error(`Replacement text is over Discord's ${MAX_CONTENT} character limit.`), {
        code: 'CONTENT_TOO_LONG',
      });
    }
    // An empty edit is rejected by Discord with a 400 that reads like a bug, so
    // it is caught here where the message can say what to do about it.
    if (edits && editContent.trim() === '') {
      throw Object.assign(new Error('Replacement text cannot be empty.'), { code: 'CONTENT_EMPTY' });
    }

    const writesPerMessage = action === 'edit-then-delete' ? 2 : 1;

    // Sorted here rather than trusting the caller, because the ordering is a
    // rate limit decision and not a display preference.
    const queue = (cfg.messages || []).slice().sort((a, b) => CL.snowflake.compare(a.id, b.id));

    const state = {
      status: 'idle',
      total: queue.length,
      done: 0,
      failed: 0,
      skipped: 0,
      index: 0,
      current: null,
      startedAt: 0,
      writes: 0,
      etaMs: estimateMs(queue.length, writesPerMessage, null),
      error: null,
    };

    const failures = [];
    const skips = [];

    let cancelled = false;
    let paused = false;
    let resumeGate = null;

    function emit() {
      onProgress({
        status: state.status,
        total: state.total,
        done: state.done,
        failed: state.failed,
        skipped: state.skipped,
        processed: state.done + state.failed + state.skipped,
        current: state.current,
        etaMs: state.etaMs,
        error: state.error,
      });
    }

    function measuredPerWrite() {
      if (state.writes < 3) return null;
      return (now() - state.startedAt) / state.writes;
    }

    function recomputeEta() {
      const remaining = state.total - (state.done + state.failed + state.skipped);
      state.etaMs = estimateMs(remaining, writesPerMessage, measuredPerWrite());
    }

    /** Cooperative, and checked between messages so a stop never lands mid-write. */
    async function gate() {
      while (paused && !cancelled) {
        if (!resumeGate) resumeGate = { promise: null, resolve: null };
        if (!resumeGate.promise) {
          resumeGate.promise = new Promise((resolve) => {
            resumeGate.resolve = resolve;
          });
        }
        await resumeGate.promise;
      }
    }

    /**
     * Sort one thrown error into what the user should be told.
     *
     * `gone` is deliberately counted as done. The message the user asked to be
     * rid of is not there, which is the outcome they wanted, and reporting it as
     * a failure would make every second run of the same filter look broken.
     */
    function classify(err) {
      const code = err && err.code;
      if (code === 'NOT_FOUND') return { kind: 'gone' };
      if (code === 'FORBIDDEN') return { kind: 'skip', reason: 'No permission in that channel' };
      if (code === 'BAD_ID') return { kind: 'skip', reason: 'Malformed id' };
      if (code === 'RATE_LIMIT_HALT') return { kind: 'halt', reason: err.message };
      if (code === 'UNAUTHORIZED') return { kind: 'halt', reason: err.message };
      return { kind: 'fail', reason: (err && err.message) || 'Unknown error' };
    }

    async function actOn(message) {
      if (edits) {
        await client.editMessage(message.channelId, message.id, editContent);
        state.writes++;
      }
      if (action !== 'edit') {
        await client.deleteMessage(message.channelId, message.id);
        state.writes++;
      }
    }

    async function start() {
      if (state.status === 'running') return summary();
      state.status = 'running';
      state.startedAt = now();
      cancelled = false;
      paused = false;
      emit();

      let consecutiveFailures = 0;

      while (state.index < queue.length) {
        await gate();
        if (cancelled) break;

        const message = queue[state.index];
        state.current = message;

        // Checked here rather than filtered out earlier so the reason survives
        // into the report. A user who selected 400 messages and saw 380 deleted
        // is owed an answer for the other 20.
        if (action !== 'edit' && !CL.filter.isDeletable(message)) {
          state.skipped++;
          skips.push({ message, reason: 'Discord does not allow deleting this kind of message' });
          state.index++;
          recomputeEta();
          emit();
          continue;
        }

        try {
          await actOn(message);
          state.done++;
          consecutiveFailures = 0;
        } catch (err) {
          const verdict = classify(err);

          if (verdict.kind === 'gone') {
            state.done++;
            consecutiveFailures = 0;
          } else if (verdict.kind === 'skip') {
            state.skipped++;
            skips.push({ message, reason: verdict.reason });
            consecutiveFailures = 0;
          } else if (verdict.kind === 'halt') {
            state.status = 'halted';
            state.error = verdict.reason;
            state.current = null;
            onLog({ level: 'halt', message: verdict.reason });
            emit();
            return summary();
          } else {
            state.failed++;
            failures.push({ message, reason: verdict.reason });
            onLog({ level: 'error', message: `${message.id}: ${verdict.reason}` });
            consecutiveFailures++;
            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
              state.status = 'halted';
              state.error =
                `Stopped after ${MAX_CONSECUTIVE_FAILURES} failures in a row. ` +
                'Something changed on Discord\'s side, so the rest of the run was not attempted.';
              state.current = null;
              emit();
              return summary();
            }
          }
        }

        state.index++;
        recomputeEta();
        emit();
      }

      state.current = null;
      state.status = cancelled ? 'cancelled' : 'done';
      state.etaMs = 0;
      emit();
      return summary();
    }

    function pause() {
      if (state.status !== 'running') return;
      paused = true;
      state.status = 'paused';
      emit();
    }

    function resume() {
      if (!paused) return;
      paused = false;
      state.status = 'running';
      if (resumeGate && resumeGate.resolve) resumeGate.resolve();
      resumeGate = null;
      emit();
    }

    function cancel() {
      cancelled = true;
      // Release the gate too, or a paused job would sit there forever waiting
      // for a resume that is never coming.
      if (resumeGate && resumeGate.resolve) resumeGate.resolve();
      resumeGate = null;
      paused = false;
    }

    function summary() {
      return {
        status: state.status,
        total: state.total,
        done: state.done,
        failed: state.failed,
        skipped: state.skipped,
        remaining: state.total - (state.done + state.failed + state.skipped),
        error: state.error,
        failures: failures.slice(),
        skips: skips.slice(),
        elapsedMs: state.startedAt ? now() - state.startedAt : 0,
      };
    }

    return {
      start,
      pause,
      resume,
      cancel,
      summary,
      estimateMs: () => state.etaMs,
      get status() {
        return state.status;
      },
    };
  }

  return { createJob, estimateMs, MAX_CONTENT, MAX_CONSECUTIVE_FAILURES, ACTIONS };
})();
