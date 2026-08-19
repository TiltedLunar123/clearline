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
   * Message types Discord will let the account that wrote them delete.
   *
   * Taken from Discord's own message type table, the Deletable column. Most of
   * these are system notices rather than anything typed: "X joined the server",
   * "X started a thread", "X pinned a message". They carry the acting user as
   * the author, so a search filtered by author returns them, and they are as
   * much a trace of somebody having been there as an ordinary message is.
   *
   * The list used to be the four ordinary types alone, which meant a run over a
   * server left every join notice, every boost, every "started a thread" behind
   * and told the user Discord would not allow their removal. It would have.
   * Nothing in the product could ever have cleared them.
   *
   * Left out on purpose: 1-5 and 21, which Discord marks not deletable at all,
   * and 24, which is only deletable with Manage Messages and so is somebody
   * else's to remove.
   */
  const DELETABLE_TYPES = [
    0, 6, 7, 8, 9, 10, 11, 12, 14, 15, 16, 17, 18, 19, 20, 22, 23, 25, 26,
    27, 28, 29, 31, 32, 36, 37, 38, 39, 44, 46,
  ];

  /**
   * Message types that can be overwritten, which is a much shorter list.
   *
   * A join notice is Discord narrating rather than something the account wrote:
   * there is text on screen but no content field behind it to replace, and the
   * API answers a PATCH with a plain 400. That lands in the failure pile rather
   * than the skip pile, blames the wrong thing, and counts toward the limit
   * that halts a whole run, so an overwrite has to be refused here instead.
   *
   * This is why the two lists exist separately. One predicate answering both
   * questions had to be as narrow as the stricter of them, and being narrow on
   * the delete side is what left those messages in place.
   */
  const EDITABLE_TYPES = [0, 19, 20, 23];

  /** Not anchored, so it finds a link anywhere in a message. */
  const LINK = /\bhttps?:\/\/[^\s<>]+/i;

  function isDeletable(message) {
    return DELETABLE_TYPES.indexOf(Number(message.type) || 0) !== -1;
  }

  function isEditable(message) {
    return EDITABLE_TYPES.indexOf(Number(message.type) || 0) !== -1;
  }

  /**
   * The predicate for what a given action can actually touch.
   *
   * One place, so the count on the pre-flight screen, the number the user is
   * asked to type back, and the guard in front of the call cannot disagree
   * about which messages a run is going to reach.
   */
  function canAct(action) {
    return action === 'edit' || action === 'edit-then-delete' ? isEditable : isDeletable;
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
          throw Object.assign(new Error(CL.i18n.t('errBadPattern', [err.message])), {
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
   * The result set split into the channels a person would say it came from.
   *
   * Grouped on the parent where there is one, for the same reason the channel
   * predicate above accepts it: a message written in a thread carries the
   * thread's id, and nobody thinks of a thread as somewhere separate from the
   * channel it hangs off. Grouping on the raw channel id would scatter one
   * evening in #general across a dozen one-message threads, which is worse than
   * no grouping at all.
   *
   * Ordered by size, because the question this answers is "where are they", and
   * the channel holding two thousand of them is the answer far more often than
   * the one holding three. Ties fall back to the name so the order is stable
   * between two renders of the same set.
   */
  function groupByChannel(messages) {
    const groups = new Map();
    for (const m of messages || []) {
      if (!m) continue;
      const key = String(m.parentId || m.channelId || '');
      let group = groups.get(key);
      if (!group) {
        group = { key, name: m.channelName || '', ids: [] };
        groups.set(key, group);
      }
      // Taken from whichever message in the group has one. A channel removed
      // between loading the list and reading the results has no name to give,
      // and one nameless message should not cost the group its label.
      if (!group.name && m.channelName) group.name = m.channelName;
      group.ids.push(String(m.id));
    }
    return Array.from(groups.values()).sort(
      (a, b) => b.ids.length - a.ids.length || a.name.localeCompare(b.name)
    );
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
    const t = CL.i18n.t;
    const parts = [];

    if (f.contains) {
      parts.push(t(f.useRegex ? 'filterMatching' : 'filterContaining', [f.contains]));
    }
    if (f.hasAttachment) parts.push(t('filterHasAttachment'));
    if (f.hasLink) parts.push(t('filterHasLink'));
    if (f.hasEmbed) parts.push(t('filterHasEmbed'));
    if (f.after && f.before) parts.push(t('filterBetween', [dayOf(f.after), dayOf(f.before)]));
    else if (f.after) parts.push(t('filterAfter', [dayOf(f.after)]));
    else if (f.before) parts.push(t('filterBefore', [dayOf(f.before)]));
    if (f.excludePinned) parts.push(t('filterNotPinned'));

    if (parts.length === 0) return t('filterEverything');
    // Joined by Intl rather than by gluing "and" on: this sentence is read
    // immediately before something irreversible, in whatever language the
    // reader has their browser set to.
    return CL.i18n.list(parts);
  }

  return {
    compile,
    apply,
    groupByChannel,
    describe,
    isEmpty,
    toWindow,
    startOfDay,
    endOfDay,
    isDeletable,
    isEditable,
    canAct,
    hasLink,
    DELETABLE_TYPES,
    EDITABLE_TYPES,
  };
})();
