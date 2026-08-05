# Changelog

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
