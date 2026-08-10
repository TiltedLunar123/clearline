# Changelog

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
