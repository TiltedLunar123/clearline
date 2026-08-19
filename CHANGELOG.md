# Changelog

## 1.6.0

A bug sweep, and one thing the review screen could not do.

### Added

- The review step says which channels your results came from, and one tick keeps
  a whole channel out of the run. The table draws three hundred rows at a time,
  and the sets it is drawing them out of are routinely in the thousands, so
  until now there were only two choices that could reach the rest: all of them,
  or none of them. Keeping #introductions out of a server-wide sweep meant
  hunting down every one of its rows by hand, and most of those rows were behind
  a Show more that had to be pressed a dozen times before they existed to be
  pressed at all. This one works on the whole result set (a thread counts as the
  channel it hangs off), and it undoes the same way the header checkbox does.
- The search panel stays on screen when you leave the step you started it from.
  Going back to the picker while a search pages is allowed and always has been,
  and it used to take the counter, the elapsed time, the reason for a wait and
  the only Stop button away with it, so the search carried on with no way to
  abandon it short of closing the tab.

### Fixed

- A search could stop early and report the part it had as the whole of it.
  Discord returns each hit wrapped in its neighbours, and a hit deleted since it
  was indexed comes back as those neighbours alone. Clearline counted the ones
  it could use rather than the blocks it was served, so one such block in a page
  of twenty-five read as the end of the results. So the search stopped there and
  said it had finished. The run that followed then touched a fraction of what
  was asked for, and one such block in the first page of a sixty-message account
  was enough to lose thirty-five of them.
- Another tab can no longer take the queue from a tab that is in the middle of a
  run without asking. There is a connection the app page opens to say it exists,
  and the browser closes it when the page goes. It also closes it after a few
  idle minutes, which during a run that takes hours is most of the time. The
  page never opened it again, so the background came to believe no app tab was
  alive at all: a second tab then claimed the queue in silence and the run
  stopped. The prompt that makes a takeover deliberate could not appear, because
  by then nothing knew there was anything to take over.
- The toolbar button opens the app again after its tab has been navigated away
  from. The same connection was being read as "no answer yet" when it meant "the
  only app tab has gone", so clicking the toolbar focused whatever that tab was
  showing and opened nothing, for the rest of the browser session.
- The action cannot be changed underneath a run. Every control on that screen
  was read once, when Start was pressed, and then left live, so clicking a
  different action mid-run rebuilt the whole sentence above the button: the
  screen described an overwrite while the job went on deleting, and Start lit up
  again. Worse is what came after. Stopping a run and then carrying on with what
  it never reached sent the rest out under whichever action was checked by
  then, so a run agreed to as an overwrite could finish as a delete.
- A new search takes the last run's report down with it. Reaching the filters by
  the Back buttons and searching from there left the report standing, so the Act
  step opened on "Finished. 2,980 messages handled." above a set that was all
  still there. Its buttons were live too: carrying on would have thrown away the
  search that had just finished, and keeping the report wrote the old run's
  numbers into a file headed with the new selection.
- The step rail can reach a finished report. Leaving the Act step put it behind
  a step the rail would not reopen, so one misclick left the only account of an
  irreversible run in the page with nothing able to show it, while the prompt
  about losing it went on asking.
- Closing the tab during a search now asks first, the way closing it during a
  run and closing it over an unsaved report already did. Paging a whole server
  takes minutes, and there is nowhere those results exist except that page.
- Spared rows are legible. They were faded to four tenths, which puts the
  message at 2.6:1 and the date and channel beside it at 1.8:1, on the rows
  somebody is reading closely to decide whether to put one back. The strike and
  the recessed fill say the same thing without hiding the text.
- Every secondary button has an outline you can see. Back, Reconnect, Stop, Show
  more, Undo, the three download buttons and everything on a run report were
  outlined at 1.66:1 (the standard asks for 3:1), and that outline is the whole
  of what says they are controls rather than captions.
- The line saying Clearline is not Discord's is no longer faded to below the
  contrast that ordinary text is owed. It is quiet because it is small, which is
  quiet enough.
- A saved file is named for the day the person saving it was having. The stamp
  was UTC while every timestamp inside the file was local, so an evening export
  west of Greenwich was filed under tomorrow and disagreed with its own first
  line.
- A run stopped by repeated failures no longer offers to redo the message it
  stopped on. It was counted as a failure and left in the queue behind, so the
  report said thirty were never reached and the button beside it offered
  thirty-one.
- Overwriting a message that has already been deleted is reported as what it is,
  rather than as an overwrite that happened. Being rid of it is still a success
  when being rid of it is what was asked for.
- A spreadsheet formula hidden behind a leading space is neutralised in exported
  CSV. Tab and carriage return were handled on the reasoning that spreadsheets
  strip leading whitespace, and the ordinary space was left out of the same set.
- A direct message is no longer labelled with a #. That belongs to a channel in a
  server, and a conversation is not one.
- Stopping a search says so and stays said. The reply already in flight used to
  land a moment later and overwrite the message with a fresh count, so the
  button read as ignored, and a wait note from one search could be left standing
  over the next one.

### Internal

- The end to end suite builds what it is about to test. It copied whatever the
  last build had left behind, so running it on its own tested the previous
  version of everything changed since, and a defect planted to prove a check
  could fail came back green.
- The stylesheet is audited by the test suite. Every animation has to be
  switched off by a selector identical to the one that starts it under reduced
  motion, and every colour pair the app draws has to meet the contrast it owes
  in both schemes. Nothing readable may be made quiet by fading it either. All
  three of those have been wrong in a shipped release, and all three are the
  kind of thing you cannot find by looking.

## 1.5.0

A pass over the whole interface. What Clearline does has not changed, and no
screen has moved. This is about the screens being easier to read, and harder to
misread on the one that matters.

### Added

- The step rail goes back. It has always looked like a row of tabs and has
  never been clickable, which is the worst of both, because it invites the
  click and then ignores it. Finished steps are buttons now. Every move they
  make is one a Back button already made, so the order the app walks you
  through is unchanged. Nothing ahead of where you are is ever reachable, and
  the rail closes altogether while a search is paging or a run is going,
  because leaving those screens would take their own Stop button with them.
- The steps are numbered, and the ones behind you are ticked.
- A search that cannot know how long it will take now says so with a moving
  bar rather than an empty one. Discord withholds a total more often than it
  gives one. A bar pinned at zero for four minutes looks like a tab that has
  died; that is exactly when somebody reloads and loses the search.
- Connect shows that it is working. There are four requests behind that click
  before anything appears, and the only sign of them was the button greying
  out, which is also what a button that has finished looks like.

### Changed

- Red is spent once, on the screen that earns it. Continue was wearing the
  colour that means "this cannot be taken back", and it leads to a screen where
  the choice is still open (including the choice to only overwrite the text).
- The three things Clearline can do to a message are three cards you choose
  between now, and the two that destroy something say so in their own colour.
  They were laid out exactly like the "Has a link" tick boxes two screens back.
- The sentence above the button reads as what it is when the action cannot be
  undone. The box asking you to type the count back looks like the last gate
  rather than like the date fields.
- Tick boxes and radios are drawn by Clearline rather than by the platform, at
  a size worth aiming at, and the header box shows properly when only some of
  the rows are picked. High contrast mode still gets the system's own controls.
- Buttons answer the pointer: nothing on the page reacted to hover or to being
  pressed. On a control that deletes several thousand messages, that reads as a
  control which is not listening.
- A lost session, an expired token, or another tab holding the queue arrives as
  an alert now. All three used to be a small grey line in the gap between two
  cards, and all three need you to do something.
- Rows highlight under the pointer, which the review table very much wanted at
  three hundred of them.
- The window can be narrow. Half a screen beside Discord is how this actually
  gets used, and the two date fields were squashing into each other.
- The interface moves now, in the places where moving says something. A step and
  the controls inside it settle in rather than appearing between frames. The
  rail fills along its connector as each stage closes behind you. Tick boxes
  land instead of blinking on. A running bar carries moving hatching, because
  the width creeps too slowly on a set of several thousand to tell a working run
  from a stalled one, and the hatching stops the moment you pause. The
  pre-flight box rings once when the action you have picked turns into one that
  cannot be undone, and only once: a box that pulses forever is wallpaper.
  Nothing here loops for decoration, and all of it is off entirely if you have
  asked your system for less motion.

### Fixed

- The primary button was white text on pale indigo in dark mode, which is not
  readable. Every filled button now carries a colour that is guaranteed to be
  legible on it, and the palette is checked against the contrast the standard
  asks for rather than by eye.
- A search that matched nothing left an empty table on screen, which reads as a
  table still loading. Under it there were three download buttons that would
  each have written an empty file. The sentence explaining the miss takes their
  place.

## 1.4.0

### Added

- A run that stops can be carried on rather than started over. Cancel one, or
  have one halted by a rate limit or an expired session, and the report now
  offers to pick up exactly the messages it never reached. Before this the count
  of what was left was reported and the messages behind it were thrown away, so
  the only way forward was to search the whole server again and redo every
  spared row by hand, which on a large search is a reason not to stop a run that
  should be stopped.
- The header checkbox can be undone. It replaces the whole selection in one
  click, including when it is caught on the way to something else, and unticking
  two hundred rows out of five thousand one at a time is an afternoon's work. It
  undoes that one action only, and stops offering as soon as you tick anything
  yourself, so it can never take newer work away with it.
- The review table marks the messages nothing can touch, instead of only
  counting them under the Start button. Finding out which rows a number referred
  to used to mean comparing two figures.
- The report says what the run actually did: how many were queued, handled, left
  alone and failed, and how long it worked for. It counted all of that from the
  beginning and showed one of them.
- Clearline now says why it is standing still. A closed rate limit bucket and a
  429 being backed away from both looked exactly like a tab that had crashed,
  which is the worst possible moment to be unreadable: the run is behaving
  correctly and the obvious next move is to reload, which is the one thing that
  loses it.
- A saved copy says when it is only part of the picture, so a file taken from a
  search you stopped early cannot be mistaken later for the whole of it.

### Fixed

- The box that asks you to type a count back accepts the count exactly as it is
  printed. It is read through the same code that wrote it now, rather than being
  stripped of the three separators English happens to use. Where those
  disagreed, the app asked for a number, you typed that number, and were asked
  for it again, with nothing on screen admitting the box wanted something else.
- Clearline knows which language it is actually speaking. It asked the browser
  for its interface language, which is a different question: with the browser
  set to a language Clearline does not ship, every word came from English while
  the page, the saved copy and the run report were all labelled as that other
  language. A screen reader took that label seriously and read English aloud
  with the wrong pronunciation, and the same wrong label went into the file that
  outlives the messages.
- Join notices, boosts, pins and "started a thread" are removed like anything
  else you left behind. Discord deletes all of them for the account they belong
  to; Clearline refused them and said Discord would not allow it, so a run over
  a server left them in place with your name on them and no way to ever clear
  them. Overwriting still leaves them alone, because there is no text behind
  them to replace, and the two are now counted separately instead of both being
  held to the stricter answer.
- The toolbar button keeps working after its tab is used for something else.
  Clearline remembered the tab by id and a tab that had been navigated away
  still answered to that id, so the button went on bringing up whatever was
  there and never opened the app again. That is the only way in, so it meant the
  whole extension was unreachable until the browser was restarted, and a genuine
  app tab was told it was "already open in another tab", naming a tab showing
  Discord.
- Taking the queue back leaves you where you were. "Use this tab instead" ran a
  full reconnect, which ends by returning to the first step, and nothing leads
  from there back to a result set except a fresh search: a search that had paged
  for twenty minutes and every row spared by hand were still in memory and no
  longer reachable from anything on screen.
- Reconnect works again after a takeover lands in the middle of one. The button
  disabled itself and nothing ever turned it back on, so the one way to recover
  from an expired session sat there visible and dead for the rest of the tab's
  life.
- A session installed by taking the queue back is checked against the account
  this tab connected as, which reconnecting already did. Everything keeping
  Clearline to your own messages hangs off the account it started with.
- A search that falls back to reading a channel directly no longer restarts that
  read from the newest message when it hits an error part way through.
- Reading a run's progress no longer floods a screen reader. The counter changes
  once per message, which is faster than it can be spoken, so the queue grew
  without limit and the Pause and Stop buttons sat behind a backlog. The counter
  still moves every message; the announcement is now paced.
- The search step announces itself at all. A whole-server search can page for
  minutes and said nothing, including after Stop was pressed.
- Carrying on from the report moves focus somewhere real instead of dropping it
  when the report closes.
- The saved copy timestamps messages the way the screen does. It printed the raw
  instant while the table beside it printed local time, so the backup taken
  moments before a delete disagreed with the screen it was made from.
- Closing the tab on a report nobody has kept now asks first, on the same terms
  as closing it mid-run. It is the only account of what happened to messages
  that no longer exist.

### Internal

- The release gate can no longer be blinded by a regular expression. A pattern
  written after `if (...)` was read as a division, and the scanner then walked
  into it, met a quote and blanked the rest of the line: an `eval()` or a
  `fetch()` sharing that line disappeared from every check, and the build printed
  "no remote code" over it. Both are now caught, and anything the scanner cannot
  read to the end fails the build instead of being passed silently.
- The gate holds every translated message against the English one. A locale that
  dropped a placeholder, or filled it from the wrong argument, passed as
  perfectly self-consistent, and the sentence it damaged is the one directly
  above the Start button.
- Several checks that could not fail were rebuilt so they can: two rate limit
  lane tests, the route bucketing test, and the end-to-end check that counted app
  tabs, which was structurally always zero.

## 1.3.0

### Added

- The run report can be saved. What a run did lived only in the tab it ran in,
  and a run can take hours: which messages were left alone and why, which failed
  and with what, how many were never reached. Closing the tab lost all of it, and
  there was nothing to go back and check, because the messages it describes had
  been deleted. The saved file also lists every entry rather than stopping at the
  fifty shown on screen.
- The HTML export is written in your language. Its headings, its edited and
  pinned marks and the document language itself follow the browser, in all
  eleven languages Clearline speaks. The CSV header row stays in English on
  purpose, because it is a set of column names other software reads.

### Fixed

- A reconnect checks whose account the session belongs to. A session expiring
  and somebody signing in as a different account are very often the same event,
  and everything keeping Clearline to your own messages is pinned to the account
  it connected as: the author filter the search sends, the check on Discord's
  answer, and the last guard before a delete. With a different account's session
  behind that, all three agreed and the deletes went out as the other account.
  On a server where that account can moderate, Discord carries them out, while
  the account panel and every sentence on screen still name the first one.
- The review screen describes the search that produced it. Nothing stops you
  going Back while a search is still running, and a whole server can take
  minutes, so choosing a different server part way through left the results of
  the first search labelled with the second server: the sentence directly above
  the Start button named the wrong place while the queue held the right
  messages, and the channel column went blank at the same time, in the table and
  in the copy you are told is the only record you will have.
- Messages written in a voice channel's text chat, a stage channel, or a thread
  under a media channel now say which channel they came from. Those are not
  offered as places to search, which is correct, and the same shortened list was
  being used to name every result, so a scattering of rows arrived with no
  location at all and nothing to say anything was missing.
- The CSV export opens as UTF-8 in a spreadsheet. Excel on Windows reads a .csv
  with the system codepage unless the file says otherwise, so accents and emoji,
  which is to say most Discord messages, came out as mojibake.
- Overwriting counts only what it can actually change. Discord refuses the same
  message types for editing as for deleting, so "Overwrite the text only"
  promised a number it could not deliver, hid the line explaining the shortfall,
  and then spent a full paced request per refused message. Ten of those in a row
  would have halted the whole run.
- Starting a second search no longer shows the first one's figures. The counter
  kept whatever the last search left in it, so a fresh search opened claiming a
  count from the run before, or the words about stopping from a search you had
  cancelled.
- A search pattern that does not compile is explained in your language rather
  than in English.
- A reconnect landing after another tab has taken over no longer overwrites the
  notice saying this tab stopped.

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
