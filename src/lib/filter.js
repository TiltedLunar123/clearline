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
   * `before` is exclusive at the end of the chosen day rather than its start,
   * because a person picking "before 5 March" means the 5th is included. Getting
   * this off by a day silently spares or destroys a day of messages, and the
   * user has no way to tell which from the count.
   */
  function toWindow(filters) {
    const f = filters || {};
    const window = { minId: null, maxId: null };

    if (f.after) {
      const t = f.after instanceof Date ? f.after.getTime() : Number(f.after);
      if (Number.isFinite(t)) window.minId = CL.snowflake.fromMillis(t);
    }
    if (f.before) {
      const t = f.before instanceof Date ? f.before.getTime() : Number(f.before);
      if (Number.isFinite(t)) window.maxId = CL.snowflake.fromMillis(t + 86400000 - 1);
    }
    return window;
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
      tests.push((m) => allowed.has(String(m.channelId)));
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

  function dayOf(value) {
    const d = value instanceof Date ? value : new Date(Number(value));
    return d.toISOString().slice(0, 10);
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
    toWindow,
    isDeletable,
    hasLink,
    DELETABLE_TYPES,
  };
})();
