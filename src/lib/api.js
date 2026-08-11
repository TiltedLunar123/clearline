/**
 * Discord API client.
 *
 * The only file in the project allowed to open a network connection, and the
 * build fails if that stops being true. Every request goes through the limiter
 * in ratelimit.js, so there is no code path that can burst.
 *
 * The token is held in a closure for the life of the page and never written to
 * storage. Closing the tab forgets it.
 */
CL.api_client = (function () {
  'use strict';

  const BASE = 'https://discord.com/api/v9';

  /**
   * Route key for the limiter.
   *
   * Discord buckets by route template plus the major parameter, so
   * /channels/111/messages/A and /channels/111/messages/B share a bucket while
   * /channels/222/... does not. Collapsing every id except the major one is
   * what makes that grouping fall out correctly. Getting this wrong means the
   * limiter tracks hundreds of one-request lanes and paces none of them.
   */
  function routeKeyFor(method, path) {
    const major = path.match(/^\/(channels|guilds|webhooks)\/(\d+)/);
    const template = path
      .replace(/\/\d{15,}/g, '/:id')
      .replace(/\?.*$/, '');
    return `${method} ${template}${major ? ` [${major[1]}:${major[2]}]` : ''}`;
  }

  /**
   * Build a query string, dropping anything unset.
   *
   * Hand rolled rather than URLSearchParams so the same file runs unchanged in
   * the node:vm sandbox the unit tests use, which has no URL globals beyond the
   * ones helper.mjs hands it.
   */
  function query(params) {
    const parts = [];
    for (const [key, value] of Object.entries(params || {})) {
      if (value === null || value === undefined || value === '') continue;
      if (Array.isArray(value)) {
        for (const v of value) parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
      } else {
        parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
      }
    }
    return parts.length ? `?${parts.join('&')}` : '';
  }

  /**
   * Ids are interpolated straight into a path, so they are checked rather than
   * trusted. Everything upstream is Discord's own data, but a malformed id
   * silently becomes a request to a different endpoint, and on a DELETE that is
   * not a failure mode worth leaving open.
   */
  function requireId(id, what) {
    if (!CL.snowflake.isValid(String(id))) {
      throw Object.assign(new Error(CL.i18n.t('errBadId', [String(id), what])), { code: 'BAD_ID' });
    }
    return String(id);
  }

  function createClient(options) {
    const opts = options || {};
    const limiter = opts.limiter || CL.ratelimit.createLimiter(opts);
    const fetchImpl = opts.fetch || ((...a) => fetch(...a));
    let token = null;

    function setToken(value) {
      token = value || null;
    }

    function hasToken() {
      return !!token;
    }

    async function request(method, path, config) {
      if (!token) throw Object.assign(new Error(CL.i18n.t('errNotConnected')), { code: 'NO_TOKEN' });
      const cfg = config || {};

      const init = {
        method,
        headers: {
          // A user token goes in Authorization raw. Prefixing it with "Bearer"
          // is the classic mistake here and returns a bare 401 with no hint.
          Authorization: token,
          'Content-Type': 'application/json',
        },
        // The token is the credential, so the browser's discord.com cookies are
        // neither needed nor wanted on these calls.
        credentials: 'omit',
      };
      if (cfg.body !== undefined) init.body = JSON.stringify(cfg.body);

      const response = await limiter.run(
        routeKeyFor(method, path),
        () => fetchImpl(BASE + path, init),
        { write: method !== 'GET' }
      );

      if (response.status === 401) {
        token = null;
        throw Object.assign(new Error(CL.i18n.t('errUnauthorized')), {
          code: 'UNAUTHORIZED',
        });
      }
      if (response.status === 403) {
        throw Object.assign(new Error(CL.i18n.t('errForbidden')), { code: 'FORBIDDEN' });
      }
      if (response.status === 404) {
        throw Object.assign(new Error(CL.i18n.t('errNotFound')), { code: 'NOT_FOUND' });
      }
      if (!response.ok) {
        throw Object.assign(new Error(CL.i18n.t('errHttp', [String(response.status)])), {
          code: 'HTTP_ERROR',
          status: response.status,
        });
      }
      if (response.status === 204) return cfg.withStatus ? { status: 204, body: null } : null;
      const body = await response.json();
      // Search is the only caller that needs the status: a 202 there means the
      // index is still building and carries a retry hint instead of results,
      // which is a wait rather than the error an ordinary 2xx-that-is-not-200
      // would be. Everything else only ever wants the body.
      return cfg.withStatus ? { status: response.status, body } : body;
    }

    return {
      setToken,
      hasToken,
      request,
      status: () => limiter.status(),
      reset: () => limiter.reset(),

      me: () => request('GET', '/users/@me'),
      guilds: () => request('GET', '/users/@me/guilds'),
      directMessages: () => request('GET', '/users/@me/channels'),
      guildChannels: (guildId) =>
        request('GET', `/guilds/${requireId(guildId, 'server id')}/channels`),

      /**
       * Search returns 202 with a retry hint while Discord builds the index for
       * a server it has not searched recently, so these two hand the status back
       * rather than swallowing it.
       */
      searchGuild: (guildId, params) =>
        request('GET', `/guilds/${requireId(guildId, 'server id')}/messages/search${query(params)}`, {
          withStatus: true,
        }),
      searchChannel: (channelId, params) =>
        request('GET', `/channels/${requireId(channelId, 'channel id')}/messages/search${query(params)}`, {
          withStatus: true,
        }),

      channelMessages: (channelId, params) =>
        request('GET', `/channels/${requireId(channelId, 'channel id')}/messages${query(params)}`),

      deleteMessage: (channelId, messageId) =>
        request(
          'DELETE',
          `/channels/${requireId(channelId, 'channel id')}/messages/${requireId(messageId, 'message id')}`
        ),
      editMessage: (channelId, messageId, content) =>
        request(
          'PATCH',
          `/channels/${requireId(channelId, 'channel id')}/messages/${requireId(messageId, 'message id')}`,
          { body: { content } }
        ),
    };
  }

  return { createClient, routeKeyFor, BASE };
})();
