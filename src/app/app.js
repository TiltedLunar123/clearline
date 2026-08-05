/**
 * App tab.
 *
 * Currently proves the spine end to end: get a token from an open Discord tab,
 * call the API through the limiter, and show what came back. Browsing, filtering
 * and the destructive operations build on top of this client, which is why the
 * client is set up once here and handed around rather than recreated per view.
 *
 * The job loop will live in this tab too. A service worker would be killed
 * partway through a long delete, and this page is alive exactly as long as the
 * user is watching it.
 */
(function () {
  'use strict';

  const client = CL.api_client.createClient();

  const els = {
    connect: document.getElementById('connect'),
    status: document.getElementById('status'),
    connectCard: document.getElementById('connect-card'),
    accountCard: document.getElementById('account-card'),
    account: document.getElementById('account'),
    guildCount: document.getElementById('guild-count'),
    dmCount: document.getElementById('dm-count'),
  };

  function say(text, tone) {
    els.status.textContent = text;
    if (tone) els.status.dataset.tone = tone;
    else delete els.status.dataset.tone;
  }

  const TOKEN_PROBLEMS = {
    'no-tab': 'Open discord.com in another tab, sign in, then try again.',
    'not-logged-in': 'That Discord tab is not signed in yet. Sign in and try again.',
  };

  async function connect() {
    els.connect.disabled = true;
    say('Looking for a signed in Discord tab...');

    try {
      const reply = await CL.api.runtime.sendMessage({ type: 'clearline:get-token' });
      if (!reply || !reply.ok) {
        say(TOKEN_PROBLEMS[reply && reply.reason] || 'Could not read the Discord session.', 'error');
        return;
      }

      client.setToken(reply.token);
      say('Connected. Loading your account...');

      const me = await client.me();
      // Sequential on purpose. Firing these together would be the first burst
      // the account ever sees from this extension, which is the opposite of the
      // pacing everything else here is built around.
      const guilds = await client.guilds();
      const dms = await client.directMessages();

      els.account.textContent = me.username + (me.discriminator && me.discriminator !== '0' ? `#${me.discriminator}` : '');
      els.guildCount.textContent = String(guilds.length);
      els.dmCount.textContent = String(dms.length);

      els.connectCard.classList.add('hidden');
      els.accountCard.classList.remove('hidden');
    } catch (err) {
      say(err && err.message ? err.message : 'Something went wrong.', 'error');
    } finally {
      els.connect.disabled = false;
    }
  }

  els.connect.addEventListener('click', connect);
})();
