# Changelog

## 1.2.0

### Added

- Clearline speaks Spanish, Brazilian Portuguese, French, German, Italian, Polish,
  Turkish, Russian, Japanese and Korean. Your browser's language decides, and English
  stays the default for anything else, so nothing changes if your language is not on
  that list. Counted things are written the way each language writes them rather than
  with an English plural rule bolted on, numbers use your locale's separators, and the
  box that asks you to type a count back accepts the number exactly as the sentence
  above it prints it.
- The report says how many messages were never attempted, names each failure by
  time, channel and text rather than by raw id, and says how many more there are
  when the list is longer than fifty. There is a Search again button.
- The review table goes past its first 300 rows, shift-click picks a range, and
  each row links to the message in Discord so you can see its context before
  deciding to keep it.
- Closing the tab during a run asks first, and a run expected to take more than a
  few minutes says the tab has to stay open.
- The tab title shows how far a run has got, so it can be left in the background.
- Enter runs the search, focus follows the step you are on, and the run announces
  its progress to a screen reader.
- The search shows elapsed time, and says how much it has read on the slower path
  that walks a channel directly, which previously sat on an unchanging line for
  minutes.

### Fixed

- A tab that another tab stopped now says so where you can read it, and keeps the
  button that takes the queue back. Both of those lived inside the connect panel,
  which disappears for good once you are connected, so a stopped tab looked
  perfectly healthy while its Search and Start buttons were greyed out, with no
  explanation on screen and no way back short of reloading and searching again.
- Being rate limited no longer kills the tab for good. Four rate limit responses in
  a row stop the run, which is deliberate, but the message says to wait a few
  minutes and start again and nothing was capable of starting again: every later
  search, run, reconnect and channel list failed instantly with that same message
  until the tab was reloaded. Clicking Connect, Search or Start is what clears it
  now. The first request afterwards still waits the full delay.
- If your Discord session expires partway through, there is a Reconnect button
  instead of a dead end. The session is dropped on any 401 and the only Connect
  button is long gone by then, so a run that lost its session had no way forward
  and the retry button failed on every message.
- Messages you wrote in a channel's threads are counted. A thread message carries
  the thread's own id and threads are not in the channel list, so narrowing to a
  channel quietly left out every reply written in its threads, and a forum channel
  could only ever report that nothing matched.
- Times in the review table are shown in your timezone. They were Discord's UTC
  times with the marker cut off, so a row could show a date outside the range named
  in the summary directly above it.
- If the channel list fails to load, Clearline says so and asks you to pick the
  server again, rather than carrying on with the last server's channels and
  labelling every result with the wrong channel or none at all.
- The first thing a new user sees is the right advice. An already-open Discord tab
  cannot be reached until it is reloaded, which is normal and expected after any
  install or update, and the message said to sign in instead.
- A takeover landing during a search no longer walks the stopped tab forward to the
  review screen with a partial set of results.
- Double clicking Connect starts one connection, and two quick clicks on the
  toolbar icon open one tab.

### Changed

- The confirmation box accepts the number exactly as it is printed above it. It
  said "1,234" and would only take "1234".
- `npm run zip` runs the release gate before it writes the packages. The two
  archives actually uploaded to the stores were the one output nothing checked.
- The release gate closes five holes it was only claiming to cover: shipped CSS was
  never scanned for outside hosts, `eval` was only looked for in the background
  script, a network call written inside a template substitution was invisible to
  it, four manifest keys could widen the extension's reach without being noticed,
  and the version check compared a value with itself and could never fail.
- The packages carry only the icons the extension actually loads.

## 1.1.0

### Fixed

- A second tab taking over now stops the first one even if it was in the middle of
  connecting. Connecting was the one path to Discord that did not check whether the
  tab had been replaced, so its remaining requests went out anyway and it then
  cleared the notice explaining that it had stopped.
- Taking the queue back brings a stopped tab fully back to life. The tab that wins a
  takeover is the owner, but the stopped flag was never cleared, so a tab that
  reclaimed the queue would reconnect, show the account and then sit on
  "Loading channels..." for ever.
- A tab that has stopped now says so when it refuses a search or a channel list,
  instead of quietly doing nothing.
- The last check on who wrote a message now refuses a message with no author on it
  rather than letting it through. Nothing reaches that check without an author
  today, which is the argument for the check being cheap rather than for it being
  right.
- A rate limit response carrying no retry hint waits a second rather than no time at
  all, and a response carrying a reset with no remaining count no longer looks like
  an exhausted lane and stalls the next request for the whole window.
- Time remaining ignores time spent paused. A run paused for half an hour used to
  come back claiming it had eighteen minutes left for five messages.
- Clicking the toolbar icon raises the window the Clearline tab is in. With that tab
  in a background or minimised window it used to look as though nothing happened.

### Changed

- The release gate caught two things it was only claiming to catch. It read a regular
  expression containing a quote as the start of a string, which hid everything after
  it on that line, and it checked shipped scripts for control characters while saying
  it checked that they parse. Both are fixed, and a network call planted in the app
  page now fails the build the way it always should have.
- `npm run zip` writes the source archive Firefox asks for alongside the two
  packages, rather than leaving it as a command in a note.

## 1.0.0

First release.

### Added

- Search your own messages across a whole server, particular channels of a server,
  or a direct message.
- Filter by text or a pattern, a date range, whether a message has an attachment, a
  link or an embed, and whether to leave pinned messages alone.
- Review every match before acting, with a tick beside each one so you can spare
  individual messages.
- Export to HTML, JSON or CSV.
- Delete messages, overwrite their text, or overwrite and then delete.
- Live progress with pause, resume and stop, an honest time estimate, and a report
  afterwards that separates what failed from what was skipped, with a retry.
- An HTML copy is saved before the first destructive call when you leave the backup
  box ticked, which it is by default.
- Runs over a hundred messages ask you to type the count back before starting.

### Notes on how it behaves

- Requests are serialised through one queue with a write-delay floor you cannot
  lower. Four consecutive rate limit responses stop the run rather than continuing
  to generate the responses that get an IP blocked.
- Only one Clearline tab works at a time, because the queue that paces requests
  lives in the page. A second tab offers to take over, and taking over stops the
  first.
- Your session token is held in the tab's memory and never written to storage. The
  only host the extension can reach is discord.com, and the build fails if that
  stops being true.
- The count shown before a run only includes messages Discord will actually let you
  delete. System notices such as join messages are named separately and left alone.
