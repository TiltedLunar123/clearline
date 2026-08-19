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
      throw Object.assign(new Error(CL.i18n.t('errContentTooLong', [String(MAX_CONTENT)])), {
        code: 'CONTENT_TOO_LONG',
      });
    }
    // An empty edit is rejected by Discord with a 400 that reads like a bug, so
    // it is caught here where the message can say what to do about it.
    if (edits && editContent.trim() === '') {
      throw Object.assign(new Error(CL.i18n.t('errContentEmpty')), { code: 'CONTENT_EMPTY' });
    }

    const writesPerMessage = action === 'edit-then-delete' ? 2 : 1;

    /**
     * What this particular action is able to touch.
     *
     * Chosen once from the action rather than asked per message, and taken from
     * the same place the pre-flight count comes from, so the number promised on
     * screen and the number the loop can deliver are the same number.
     */
    const allowed = CL.filter.canAct(action);

    /**
     * The account this run is allowed to touch.
     *
     * Belt and braces. Search already asks Discord to filter by author and
     * checks the answer, so nothing should ever reach here that fails this. It
     * is checked a third time anyway because this is the last point before an
     * irreversible call, and because an account with Manage Messages would find
     * a delete of somebody else's message succeeding rather than erroring.
     */
    const authorId = cfg.authorId ? String(cfg.authorId) : null;

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

    /**
     * Time the run spent standing still, kept out of the measured rate.
     *
     * The estimate takes over from the floor once a few writes are in, and it
     * divides elapsed time by writes. Counting a pause as elapsed makes every
     * minute of not working look like a minute of very slow working, so a run
     * paused over a coffee comes back claiming hours are left.
     */
    let pausedAt = 0;
    let pausedMs = 0;

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

    /** Wall clock since the run began, less anything spent paused. */
    function workingMs() {
      const standingStill = pausedAt ? now() - pausedAt : 0;
      return Math.max(0, now() - state.startedAt - pausedMs - standingStill);
    }

    function measuredPerWrite() {
      if (state.writes < 3) return null;
      return workingMs() / state.writes;
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
     *
     * That reasoning runs out at the one action that leaves the message
     * standing. An overwrite is a request to change what a message says, not to
     * be rid of it, so a 404 there is not the outcome asked for: the text was
     * never replaced, and the message it belonged to has gone somewhere the user
     * did not send it. Counted as done it was reported as an overwrite that
     * happened, in the document that exists to be the record of what happened.
     * It is a skip with a reason instead, which is the pile for "this one was
     * not touched, and here is why".
     */
    function classify(err) {
      const code = err && err.code;
      if (code === 'NOT_FOUND') {
        return action === 'edit'
          ? { kind: 'skip', reason: CL.i18n.t('reasonAlreadyGone') }
          : { kind: 'gone' };
      }
      if (code === 'FORBIDDEN') return { kind: 'skip', reason: CL.i18n.t('reasonNoPermission') };
      if (code === 'BAD_ID') return { kind: 'skip', reason: CL.i18n.t('reasonMalformedId') };
      if (code === 'RATE_LIMIT_HALT') return { kind: 'halt', reason: err.message };
      if (code === 'UNAUTHORIZED') return { kind: 'halt', reason: err.message };
      return { kind: 'fail', reason: (err && err.message) || CL.i18n.t('reasonUnknown') };
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

        // Fails closed. Requiring the message to carry an author before
        // comparing turned "I cannot tell whose this is" into "go ahead",
        // which is the wrong way round for the last check in front of an
        // irreversible call: the case a backstop exists for is the one where
        // the data reaching it is already wrong.
        if (authorId && String(message.authorId || '') !== authorId) {
          state.skipped++;
          skips.push({ message, reason: CL.i18n.t('reasonNotYours') });
          onLog({ level: 'error', message: `${message.id}: refused, not confirmed as written by this account` });
          state.index++;
          recomputeEta();
          emit();
          continue;
        }

        // Checked here rather than filtered out earlier so the reason survives
        // into the report. A user who selected 400 messages and saw 380 deleted
        // is owed an answer for the other 20.
        //
        // The two actions ask different questions and get different answers. A
        // join notice is Discord narrating: it can be removed, because the
        // account is what it is narrating about, but there is no text behind it
        // to overwrite, and a PATCH comes back as a plain 400 that lands in the
        // failure pile, blames the wrong thing, and counts toward the limit
        // that halts the whole run. So an overwrite refuses it here and a
        // delete goes ahead with it.
        if (!allowed(message)) {
          state.skipped++;
          skips.push({
            message,
            reason: CL.i18n.t(action === 'edit' ? 'reasonUneditable' : 'reasonUndeletable'),
          });
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
              state.error = CL.i18n.t('errTooManyFailures', [String(MAX_CONSECUTIVE_FAILURES)]);
              state.current = null;
              // Past this message before stopping, because it was attempted and
              // has already been counted as a failure. Returning from where the
              // index still pointed at it put it in both piles at once: the
              // report said thirty were never reached and offered to carry on
              // with thirty-one, and the extra one was the message sitting in
              // the failure list directly above. Retrying the failures and
              // carrying on then both queued it. The other halt does not need
              // this: it counts nothing for the message it stops on, so leaving
              // the index there is what keeps its two numbers agreeing.
              state.index++;
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
      pausedAt = now();
      state.status = 'paused';
      emit();
    }

    function resume() {
      if (!paused) return;
      paused = false;
      if (pausedAt) {
        pausedMs += now() - pausedAt;
        pausedAt = 0;
      }
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
      if (pausedAt) {
        pausedMs += now() - pausedAt;
        pausedAt = 0;
      }
    }

    function summary() {
      return {
        status: state.status,
        total: state.total,
        done: state.done,
        failed: state.failed,
        skipped: state.skipped,
        remaining: state.total - (state.done + state.failed + state.skipped),
        /*
         * The messages the run never got to, not just how many there were.
         *
         * A run that stopped, for whatever reason, used to be a dead end: the
         * count was reported and the queue behind it stayed private to this
         * closure, so the only route on was to search the whole server again
         * and re-do every exclusion by hand. Handing the tail back lets the app
         * offer to carry on, and it goes back through createJob like any other
         * queue, so the ownership check and the type check run again on every
         * one of them rather than being skipped as already vetted.
         */
        remainingMessages: queue.slice(state.index),
        error: state.error,
        failures: failures.slice(),
        skips: skips.slice(),
        // Working time, not wall clock. A run paused over lunch is not a run
        // that took four hours, and this number is shown as how long it took.
        elapsedMs: state.startedAt ? workingMs() : 0,
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
