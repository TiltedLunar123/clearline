# Clearline

A browser extension for managing your own Discord messages: search across servers
and DMs, export to HTML, JSON or CSV with attachments, and bulk delete or edit
what you wrote.

Chrome and Firefox, MV3, no build dependencies.

> Not affiliated with, endorsed by, or connected to Discord Inc.

## Status

Early. The spine works end to end (connect, authenticate, list servers and DMs)
and the pacing layer that everything else depends on is written and tested.
Browsing, filtering, export and the destructive operations are not built yet.

## Running it

```bash
npm run build
```

Then load `dist/chrome` as an unpacked extension, or `dist/firefox` via
`about:debugging`. Open Discord in a tab, sign in, then click the Clearline
toolbar icon.

```bash
npm test          # unit tests
npm run check     # release gate, fails until icons exist
npm run zip       # store-ready zips into release/
```

## How it handles your token

Discord has no OAuth scope for reading or deleting your own message history, so
anything in this category works from the session token your browser already
holds. That is a real trade and worth being plain about:

- The token is read from an open discord.com tab, on demand, only when you click
  Connect.
- It lives in the app tab's memory. It is never written to storage, never logged,
  and is gone when you close the tab.
- The only host the extension can reach is `discord.com`. `tools/build.mjs`
  fails the build if a network call appears outside `src/lib/api.js`, or if any
  URL in the source points somewhere else.
- No analytics, no telemetry, no server. There is nothing on the other end
  because there is no other end.

Automating a user account is against Discord's terms of service. Deleting your
own messages in bulk is the specific thing this exists to do, and Discord does
not offer it. Read the risk section before using it on an account you care about.

## Rate limiting

`src/lib/ratelimit.js` is the most conservative part of the codebase on purpose.
Every request is serialised through one queue. Writes are spaced by a floor the
user cannot lower, per-bucket windows and global limits are both honoured from
response headers, and four consecutive 429s halt the job rather than continuing
to generate the 429s that get an IP blocked for an hour.

Bursting is the behaviour most likely to get an account actioned, so the client
has no code path that can burst even if a caller asks it to.

## Risk

Bulk deletion through the API is not a supported use of a Discord account.
People do get actioned for it. This tool paces itself far more carefully than
the alternatives, which lowers the odds but does not remove them. If losing the
account would be a serious problem, export first and think about whether the
deletion is worth it.

## Licence

MIT.
