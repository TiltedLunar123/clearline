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
      if (!token) throw Object.assign(new Error('Not connected to Discord.'), { code: 'NO_TOKEN' });
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
        throw Object.assign(new Error('Discord rejected the session. Reconnect and try again.'), {
          code: 'UNAUTHORIZED',
        });
      }
      if (response.status === 403) {
        throw Object.assign(new Error('No permission for that channel.'), { code: 'FORBIDDEN' });
      }
      if (response.status === 404) {
        throw Object.assign(new Error('That channel or message is gone.'), { code: 'NOT_FOUND' });
      }
      if (!response.ok) {
        throw Object.assign(new Error(`Discord returned ${response.status}.`), {
          code: 'HTTP_ERROR',
          status: response.status,
        });
      }
      if (response.status === 204) return null;
      return response.json();
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
      guildChannels: (guildId) => request('GET', `/guilds/${guildId}/channels`),
    };
  }

  return { createClient, routeKeyFor, BASE };
})();
