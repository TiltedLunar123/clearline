/**
 * Narrowing a result set down.
 *
 * Two jobs. Dates become snowflake bounds so Discord does the coarse cut server
 * side and never sends the years you did not ask for, and everything else is a
 * predicate applied to what comes back.
 *
 * Split that way because the two are not interchangeable. A date bound saves
 * requests, which is the difference between a two minute search and a twenty
 * minute one. A content match cannot be pushed to the server without using
 * Discord's own text search, which tokenises and stems and would quietly return
 * a different set than the one the user was shown before they hit delete.
 * Filtering locally is slower and exact, and exact is the only acceptable answer
 * on the screen immediately before a destructive action.
 */
CL.filter = (function () {
  'use strict';

  /**
   * Message types the API will actually let an account delete.
   *
   * Everything else in a channel is a system notice: someone joined, a call
   * started, a message was pinned. They are attributed to the user and come back
   * in search results, so without this the count on screen promises more than
   * the job can deliver and every one of them fails at delete time.
   */
  const DELETABLE_TYPES = [0, 19, 20, 23];

  /** Not anchored, so it finds a link anywhere in a message. */
  const LINK = /\bhttps?:\/\/[^\s<>]+/i;

  function isDeletable(message) {
    return DELETABLE_TYPES.indexOf(Number(message.type) || 0) !== -1;
  }

  function hasLink(message) {
    return LINK.test(message.content || '');
  }

  /**
   * Turn a date range into the ids Discord wants.
   *
   * `after` and `before` are exact instants, not days. Widening a date to cover
   * its whole day is the caller's job, and deliberately so: a day only means
   * anything in a timezone, and this file has no business deciding which one.
   * Doing the arithmetic here in UTC, while the date box the user typed into
   * shows their local calendar, shifts the range by the offset and quietly
   * spares or destroys several hours of messages at each end. The user cannot
   * tell which from the count, which is what makes it worth being strict about.
   */
  function toWindow(filters) {
    const f = filters || {};
    const window = { minId: null, maxId: null };

    if (f.after !== null && f.after !== undefined && f.after !== '') {
      const t = f.after instanceof Date ? f.after.getTime() : Number(f.after);
      if (Number.isFinite(t)) window.minId = CL.snowflake.fromMillis(t);
    }
    if (f.before !== null && f.before !== undefined && f.before !== '') {
      const t = f.before instanceof Date ? f.before.getTime() : Number(f.before);
      if (Number.isFinite(t)) window.maxId = CL.snowflake.fromMillis(t);
    }
    return window;
  }

  /** Start and end of the local calendar day a date input names. */
  function startOfDay(value) {
    const d = value instanceof Date ? value : new Date(Number(value));
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime();
  }

  function endOfDay(value) {
    const d = value instanceof Date ? value : new Date(Number(value));
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime();
  }

  /**
   * Compile the predicate once rather than re-reading the options per message.
   *
   * A bad regex from the user is caught here, at the point they can still fix
   * it, instead of throwing partway through a run.
   */
  function compile(filters) {
    const f = filters || {};
    const tests = [];

    if (f.contains) {
      if (f.useRegex) {
        let re;
        try {
          re = new RegExp(f.contains, f.caseSensitive ? '' : 'i');
        } catch (err) {
          throw Object.assign(new Error(`That is not a valid pattern: ${err.message}`), {
            code: 'BAD_PATTERN',
          });
        }
        tests.push((m) => re.test(m.content || ''));
      } else if (f.caseSensitive) {
        const needle = f.contains;
        tests.push((m) => (m.content || '').indexOf(needle) !== -1);
      } else {
        const needle = f.contains.toLowerCase();
        tests.push((m) => (m.content || '').toLowerCase().indexOf(needle) !== -1);
      }
    }

    if (f.hasAttachment) tests.push((m) => (m.attachments || []).length > 0);
    if (f.hasLink) tests.push(hasLink);
    if (f.hasEmbed) tests.push((m) => (m.embedCount || 0) > 0);
    if (f.excludePinned) tests.push((m) => !m.pinned);
    if (f.onlyDeletable) tests.push(isDeletable);

    // Dates are re-checked locally even though the window already bounded the
    // request. History paging ignores max_id, and a search seam can hand back a
    // message a millisecond outside the range.
    const window = toWindow(f);
    if (window.minId) {
      const min = BigInt(window.minId);
      tests.push((m) => BigInt(m.id) >= min);
    }
    if (window.maxId) {
      const max = BigInt(window.maxId);
      tests.push((m) => BigInt(m.id) <= max);
    }

    if (f.channelIds && f.channelIds.length) {
      const allowed = new Set(f.channelIds.map(String));
      // A thread's messages carry the thread id, and threads are never in the
      // picker, so matching on channelId alone quietly dropped everything
      // written in a thread of a channel the user had picked. The count is the
      // one number this whole product is built around, so it silently
      // understated the job. Parent counts as the channel; the check still
      // requires the message to belong to something that was picked.
      tests.push((m) => allowed.has(String(m.channelId)) || allowed.has(String(m.parentId || '')));
    }

    return function matches(message) {
      for (const test of tests) {
        if (!test(message)) return false;
      }
      return true;
    };
  }

  function apply(messages, filters) {
    const matches = compile(filters);
    return (messages || []).filter(matches);
  }

  /**
   * The local calendar day, not the UTC one. This string is shown back to the
   * user beside a count they are about to act on, so it has to name the same
   * day they picked in the date box.
   */
  /**
   * True when nothing has been narrowed down.
   *
   * Exists so callers can build a sentence rather than gluing a clause on to
   * whatever describe() happened to return. "12 messages, everything you wrote"
   * and "12 messages, containing sorry" do not want the same connecting words.
   */
  function isEmpty(filters) {
    const f = filters || {};
    return !(
      f.contains ||
      f.hasAttachment ||
      f.hasLink ||
      f.hasEmbed ||
      f.excludePinned ||
      f.after ||
      f.before
    );
  }

  function dayOf(value) {
    const d = value instanceof Date ? value : new Date(Number(value));
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  /**
   * A sentence describing the filters, for the export header and the sentence
   * shown just before anything is deleted.
   *
   * Worth the effort: "everything" and "37 messages containing sorry in
   * #general" are the two states a person needs to be able to tell apart at a
   * glance, and a row of checkbox labels does not do that.
   */
  function describe(filters) {
    const f = filters || {};
    const parts = [];

    if (f.contains) {
      parts.push(`${f.useRegex ? 'matching' : 'containing'} "${f.contains}"`);
    }
    if (f.hasAttachment) parts.push('with an attachment');
    if (f.hasLink) parts.push('with a link');
    if (f.hasEmbed) parts.push('with an embed');
    if (f.after && f.before) parts.push(`sent between ${dayOf(f.after)} and ${dayOf(f.before)}`);
    else if (f.after) parts.push(`sent on or after ${dayOf(f.after)}`);
    else if (f.before) parts.push(`sent on or before ${dayOf(f.before)}`);
    if (f.excludePinned) parts.push('not pinned');

    if (parts.length === 0) return 'everything you wrote';
    if (parts.length === 1) return parts[0];
    return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  }

  return {
    compile,
    apply,
    describe,
    isEmpty,
    toWindow,
    startOfDay,
    endOfDay,
    isDeletable,
    hasLink,
    DELETABLE_TYPES,
  };
})();
