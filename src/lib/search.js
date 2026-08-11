/**
 * Finding the messages.
 *
 * Two ways to get a user's messages out of Discord, and this file uses both
 * because neither is sufficient alone.
 *
 *   Search    /guilds/:id/messages/search and /channels/:id/messages/search
 *             accept author_id, so Discord does the filtering and a server with
 *             a million messages costs the same as one with a thousand. This is
 *             the only workable option for a whole server. It has two sharp
 *             edges, both handled below: the index is built lazily and answers
 *             202 until it is ready, and `offset` is refused past 5000.
 *
 *   History   /channels/:id/messages walks a single channel backwards 100 at a
 *             time and filters client side. Slower per message and useless
 *             across a server, but it reads the channel directly rather than an
 *             index, so it finds things search has not indexed and it cannot go
 *             stale. It is the fallback when search fails and the better choice
 *             for a small DM.
 *
 * Everything is paced by the limiter underneath, so neither path can burst no
 * matter how many pages it wants.
 */
CL.search = (function () {
  'use strict';

  /** Discord's search page size. Not configurable, asking for more is ignored. */
  const SEARCH_PAGE = 25;

  /**
   * Highest `offset` Discord will serve. Past this the endpoint 400s, so a
   * result set deeper than this has to be reached by moving the window instead.
   */
  const MAX_OFFSET = 5000;

  /** History page size. 100 is the documented maximum. */
  const HISTORY_PAGE = 100;

  /** Stop rather than spin if the index never becomes ready. */
  const MAX_INDEX_WAITS = 8;

  function defaultSleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Pull the user's own message out of a search result group.
   *
   * Discord returns hits wrapped in context: each entry is a small array of
   * neighbouring messages, other people's included, with the match flagged
   * `hit`. Two things follow, and getting either wrong is how a tool like this
   * deletes something that was never the user's to delete.
   *
   * The flag is not load bearing. It is normally present, but the fallback
   * cannot be "take the middle one": context is only symmetric away from the
   * ends of a channel, so for the oldest message in a channel the group is
   * [hit, after] and the middle is the message after it, written by somebody
   * else. Author is the check that actually holds.
   *
   * So candidates are narrowed to the account's own messages first, and the
   * flag only chooses between them. If none of the group belongs to the
   * account, the answer is nothing rather than a guess.
   */
  function hitOf(group, authorId) {
    const list = Array.isArray(group) ? group : group ? [group] : [];
    const mine = authorId
      ? list.filter((m) => m && String((m.author || {}).id) === String(authorId))
      : list.filter(Boolean);
    return mine.find((m) => m.hit) || mine[0] || null;
  }

  /**
   * Flatten Discord's message into the shape the rest of the app uses.
   *
   * Done once, here, so nothing downstream has to know which of the several
   * message shapes Discord returns it is looking at. Search results, history
   * results and the object returned by a PATCH all differ slightly.
   */
  /**
   * Where a message counts as living, for naming and for scoping.
   *
   * A message posted in a thread carries the thread's id, not the channel the
   * user picked, and threads are never in the picker. So a search narrowed to
   * #general dropped everything written in #general's threads, and a forum
   * channel, which holds no messages directly and was offered in the picker,
   * could only ever report "Nothing matched". Neither said anything was missing.
   *
   * Discord answers a search with a `threads` array carrying each thread's
   * `parent_id`, so the mapping is in the response already and does not cost a
   * request. The thread id is still what gets deleted; this is only the channel
   * the message belongs to.
   */
  function parentsFrom(body) {
    const map = new Map();
    for (const t of (body && body.threads) || []) {
      if (t && t.id && t.parent_id) map.set(String(t.id), String(t.parent_id));
    }
    return map;
  }

  function normalise(raw, context, parents) {
    const ctx = context || {};
    const author = raw.author || {};
    const channelId = String(raw.channel_id || ctx.channelId || '');
    const parentId = parents && parents.get(channelId) ? parents.get(channelId) : null;
    // Named after the parent when there is one, because "#general" is what the
    // user picked and what they expect to read in the table.
    const nameOf = ctx.channelNameFor ? ctx.channelNameFor(parentId || channelId) : ctx.channelName || '';
    return {
      id: String(raw.id),
      channelId,
      parentId,
      channelName: nameOf,
      guildId: raw.guild_id ? String(raw.guild_id) : ctx.guildId || null,
      guildName: ctx.guildName || null,
      timestamp: raw.timestamp || null,
      editedTimestamp: raw.edited_timestamp || null,
      authorId: String(author.id || ''),
      authorName: author.global_name || author.username || '',
      content: typeof raw.content === 'string' ? raw.content : '',
      attachments: (raw.attachments || []).map((a) => ({
        id: String(a.id || ''),
        filename: a.filename || '',
        size: Number(a.size) || 0,
        url: a.url || '',
      })),
      embedCount: (raw.embeds || []).length,
      pinned: !!raw.pinned,
      type: Number(raw.type) || 0,
    };
  }

  /**
   * A 202 carries a retry hint instead of results.
   *
   * Distinguished by status rather than by shape, which is why the client hands
   * the status back for search alone. Guessing from the body would be fragile:
   * a genuinely empty result set and an unbuilt index both lack messages.
   */
  function indexWaitMs(status, body) {
    if (status !== 202) return 0;
    const seconds = body && typeof body.retry_after === 'number' ? body.retry_after : 1;
    return Math.min(Math.max(seconds * 1000, 250), 30000);
  }

  function createFinder(client, options) {
    const opts = options || {};
    const sleep = opts.sleep || defaultSleep;

    /**
     * Walk one search scope to exhaustion.
     *
     * The window is pinned before the first request. Without that, a message
     * arriving mid-run shifts every subsequent offset by one and the paging
     * quietly skips a message for each new arrival. Pinning `max_id` to the
     * moment the run started makes the result set immutable for the duration,
     * which matters a great deal when the next thing the user does is delete it.
     */
    async function runSearch(request) {
      const { scope, authorId, onProgress, shouldStop } = request;
      const searchOne = scope.guildId
        ? (params) => client.searchGuild(scope.guildId, params)
        : (params) => client.searchChannel(scope.channelId, params);

      const seen = new Set();
      const out = [];
      let offset = 0;
      let maxId = request.maxId || CL.snowflake.fromMillis(Date.now());
      let total = null;
      let indexWaits = 0;
      let truncated = false;

      for (;;) {
        if (shouldStop && shouldStop()) {
          truncated = true;
          break;
        }

        const params = {
          author_id: authorId,
          offset: offset || null,
          max_id: maxId,
          min_id: request.minId || null,
          include_nsfw: 'true',
        };
        if (scope.guildId && scope.channelIds && scope.channelIds.length) {
          params.channel_id = scope.channelIds;
        }

        const reply = await searchOne(params);
        const body = reply.body || {};

        const wait = indexWaitMs(reply.status, body);
        if (wait) {
          indexWaits++;
          if (indexWaits > MAX_INDEX_WAITS) {
            throw Object.assign(
              new Error(
                'Discord is still building the search index for this server. Try again in a minute.'
              ),
              { code: 'INDEX_NOT_READY' }
            );
          }
          if (onProgress) onProgress({ phase: 'indexing', found: out.length, waitMs: wait });
          await sleep(wait);
          continue;
        }
        indexWaits = 0;

        if (total === null && typeof body.total_results === 'number') total = body.total_results;

        const groups = Array.isArray(body.messages) ? body.messages : [];
        const page = groups.map((group) => hitOf(group, authorId)).filter(Boolean);
        if (page.length === 0) break;

        const parents = parentsFrom(body);
        for (const raw of page) {
          const id = String(raw.id);
          if (seen.has(id)) continue;
          // Checked again rather than trusted from author_id in the request.
          // The result of this loop becomes a delete queue, and the cost of the
          // check is nothing next to the cost of being wrong once.
          if (String((raw.author || {}).id) !== String(authorId)) continue;
          seen.add(id);
          out.push(normalise(raw, scope, parents));
        }

        if (onProgress) {
          onProgress({ phase: 'searching', found: out.length, total, strategy: 'search' });
        }

        if (request.limit && out.length >= request.limit) {
          truncated = true;
          break;
        }

        // A page shorter than the page size is the end of this window. Asking
        // for the next offset anyway would spend a request, and the read floor
        // that comes with it, to be told the same thing.
        if (page.length < SEARCH_PAGE) break;

        offset += SEARCH_PAGE;
        if (offset > MAX_OFFSET - SEARCH_PAGE) {
          // Past the offset ceiling. Drop the window down to the oldest hit so
          // far and start counting again, which is the only way to reach the
          // rest of a result set deeper than Discord will page.
          const oldest = out.length ? out[out.length - 1].id : null;
          if (!oldest || oldest === maxId) break;
          maxId = oldest;
          offset = 0;
          seen.clear();
          // `seen` is cleared with the window because ids are only revisited at
          // the seam, and keeping every id of a 100k message account in a Set
          // for the whole run is the kind of thing that makes a tab die.
          for (const m of out.slice(-SEARCH_PAGE * 2)) seen.add(m.id);
        }
      }

      return { messages: out, total, truncated, strategy: 'search' };
    }

    /**
     * Walk one channel's history backwards, keeping only this account's messages.
     *
     * Reads the channel rather than an index, so it sees everything, including
     * whatever search has not caught up with. The cost is that it pages through
     * other people's messages too, which is fine for a DM and painful for a busy
     * server channel.
     */
    async function runHistory(request) {
      const { scope, authorId, onProgress, shouldStop } = request;
      const channelId = scope.channelId;
      const minId = request.minId ? BigInt(request.minId) : null;

      const out = [];
      let before = request.maxId || null;
      let scanned = 0;
      let truncated = false;

      for (;;) {
        if (shouldStop && shouldStop()) {
          truncated = true;
          break;
        }

        const page = await client.channelMessages(channelId, {
          limit: HISTORY_PAGE,
          before: before || null,
        });
        if (!Array.isArray(page) || page.length === 0) break;

        scanned += page.length;
        let reachedFloor = false;

        for (const raw of page) {
          if (minId !== null && BigInt(raw.id) < minId) {
            reachedFloor = true;
            continue;
          }
          if (String((raw.author || {}).id) !== String(authorId)) continue;
          out.push(normalise(raw, scope));
        }

        if (onProgress) {
          onProgress({ phase: 'searching', found: out.length, scanned, strategy: 'history' });
        }

        if (request.limit && out.length >= request.limit) {
          truncated = true;
          break;
        }

        before = String(page[page.length - 1].id);
        if (reachedFloor || page.length < HISTORY_PAGE) break;
      }

      return { messages: out, total: out.length, truncated, scanned, strategy: 'history' };
    }

    /**
     * Pick a strategy and run it.
     *
     * A server can only be searched. A single channel can be done either way,
     * and search is tried first because it is far cheaper, falling back to
     * history when search errors. The fallback is what makes a DM that Discord
     * has not indexed still work, which is a case people hit often enough that
     * failing there would look like the tool is broken.
     */
    async function find(request) {
      const req = request || {};
      const scope = req.scope || {};
      const strategy = req.strategy || 'auto';

      if (scope.guildId) return runSearch(req);
      if (!scope.channelId) throw new Error('Nothing selected to search.');

      if (strategy === 'history') return runHistory(req);
      if (strategy === 'search') return runSearch(req);

      try {
        const result = await runSearch(req);
        if (result.messages.length > 0 || result.truncated) return result;
        // An empty search on a channel that plainly has history is the shape of
        // an unindexed channel, so it is worth the second, slower look rather
        // than telling the user they have no messages when they do.
        return await runHistory(req);
      } catch (err) {
        if (err && (err.code === 'RATE_LIMIT_HALT' || err.code === 'UNAUTHORIZED')) throw err;
        return runHistory(req);
      }
    }

    return { find, runSearch, runHistory };
  }

  return {
    createFinder,
    normalise,
    parentsFrom,
    hitOf,
    indexWaitMs,
    SEARCH_PAGE,
    MAX_OFFSET,
    HISTORY_PAGE,
  };
})();
