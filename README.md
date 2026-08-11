# Clearline

A browser extension for managing your own Discord messages: search across a server
or a DM, export what you find to HTML, JSON or CSV, and bulk delete or overwrite
what you wrote.

Chrome and Firefox, MV3, no build dependencies and no third party code.

> Not affiliated with, endorsed by, or connected to Discord Inc.

## What it does

Five steps, in order, one screen at a time.

1. **Connect.** Reads your session from an open discord.com tab.
2. **Where.** Pick a server, optionally narrowing to particular channels, or pick a
   direct message.
3. **Narrow.** Filter by text or a pattern, a date range, whether a message has an
   attachment, a link or an embed, and whether to leave pinned messages alone.
4. **Review.** See the count and the actual messages before anything happens, and
   save a copy in HTML, JSON or CSV.
5. **Act.** Delete them, overwrite the text and then delete them, or only overwrite
   the text. Watch it run, pause it, or stop it.

## Running it

```bash
npm run build
```

Then load `dist/chrome` as an unpacked extension, or `dist/firefox` via
`about:debugging`. Open Discord in a tab, sign in, then click the Clearline toolbar
icon.

```bash
npm test          # 135 unit tests
npm run check     # build plus the release gate
npm run e2e       # 52 checks against a real browser and a mocked Discord
npm run all       # all three
npm run zip       # release gate, then store-ready zips into release/
npm run shots     # store screenshots into store/screenshots/
```

Screenshots are captured by driving the built extension through its five steps
against the same mocked Discord the tests use, so they are photographs of the
software rather than promises about it. Nothing in that path touches an account.

Store listing copy, permission justifications and the review answers both stores
ask for live in [store/LISTING.md](store/LISTING.md).

## How it handles your token

Discord has no OAuth scope for reading or deleting your own message history, so
anything in this category works from the session token your browser already holds.
That is a real trade and worth being plain about:

- The token is read from an open discord.com tab, on demand, only when you click
  Connect.
- It lives in the app tab's memory. It is never written to storage, never logged,
  and is gone when you close the tab.
- The only host the extension can reach is `discord.com`. `tools/build.mjs` fails
  the build if a network call appears outside `src/lib/api.js`, or if any URL in
  the source points somewhere else.
- The extension asks for one permission, `storage`, and one host. That is the whole
  list. Exports are written through a blob rather than the downloads API precisely
  so the list stays that short.
- No analytics, no telemetry, no server. There is nothing on the other end because
  there is no other end.
- There is one outbound link, to a Buy Me a Coffee page at the bottom of the app.
  It is a link and nothing more: nothing is requested from that host in the
  background, it opens in a new tab with `rel="noopener noreferrer"`, and the build
  gate keeps link hosts and connectable hosts as separate lists so it can never
  become a request.

## Rate limiting

`src/lib/ratelimit.js` is the most conservative part of the codebase on purpose.

Every request is serialised through one queue, so there is no code path that can
burst even if a caller asks it to. Writes are spaced by a floor you cannot lower.
Per-bucket windows and the global limit are both honoured from response headers.
Four consecutive 429s halt the job rather than continuing to generate the 429s that
get an IP blocked for an hour.

Bursting is the behaviour most likely to get an account actioned, and it is the
thing that goes wrong with tools in this category. The end to end suite measures the
real gap between real deletes in a real browser, so the pacing is a tested property
of the assembled extension rather than a claim about one module.

## Design notes

A few decisions that are deliberate rather than accidental:

- **Nothing destructive is reachable without a count and a sample.** The delete
  button lives on a screen you can only get to from the review screen.
- **The pre-flight is a sentence, not a number in a badge.** It names how many
  messages, where, matching what, roughly how long it will take, and that it cannot
  be undone.
- **Anything over a hundred asks you to type the number back.**
- **A copy is written and handed to the browser before the first destructive call**,
  not alongside it, and it is checked for a complete document first. If building the
  export is going to fail, it fails while the messages still exist. Where the browser
  puts the file after that is between you and the browser: Clearline does not take
  the downloads permission, so it cannot watch the save itself.
- **The count only includes what can actually be deleted.** Join notices and similar
  system messages are attributed to you and come back in search results, but Discord
  refuses to delete them. Counting them would promise more than the run can deliver,
  so they are named separately and left alone.
- **Failures are separated from skips.** A message that was already gone is a
  success. A channel you can no longer write to is a skip. Everything else is a
  failure you can retry from the report.
- **Estimates are honest** because the pacing is deterministic. The floor is known
  and the queue is serial, so the time given before you start is the time it takes.
- **Only one Clearline tab works at a time.** The queue that paces requests lives in
  the page, so a second tab would be a second queue and Discord would see twice the
  rate. A second tab says so and offers to take over, and taking over stops the tab
  it replaced. A tab that has been stopped says so somewhere it can be read and
  keeps the control that takes the queue back, because a stop you cannot see and
  cannot undo is indistinguishable from the tool being broken.
- **Stopping is not giving up.** Four rate limit responses in a row halt the run
  rather than continuing to generate them, and clicking Connect, Search or Start
  afterwards is what clears that halt. The first request after one still owes the
  full write delay, so coming back cannot turn into a burst.
- **A channel includes its threads.** A message written in a thread carries the
  thread's id rather than the channel it hangs off, and threads are not in the
  picker, so matching on that id alone leaves thread replies out of the count shown
  before a run. The parent comes back in the same search response, so picking
  #general covers what you wrote in its threads.
- **Every message is checked as yours three times** before anything touches it: the
  search asks Discord to filter by author, the answer is checked rather than
  trusted, and the run checks again immediately before the call. Search results
  arrive wrapped in other people's messages as context, and on an account with
  Manage Messages a delete aimed at the wrong one would succeed rather than error.

## Exports

HTML is a self-contained document with no external references and every value
escaped. JSON carries a small header plus the raw messages. CSV is RFC 4180, and
every cell is neutralised against spreadsheet formula injection, including the
leading-tab variant, because message content is text other people wrote and a
spreadsheet will happily run it.

## Risk

Bulk deletion through the API is not a supported use of a Discord account. People do
get actioned for it. This tool paces itself far more carefully than the alternatives,
which lowers the odds but does not remove them. If losing the account would be a
serious problem, export first and think about whether the deletion is worth it.

## Licence

MIT.
