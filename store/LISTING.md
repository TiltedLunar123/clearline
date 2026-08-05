# Store listing copy

Everything both stores ask for, in one place, so a submission is copy and paste
rather than rewriting from memory.

Two things to keep in mind when editing any of this. Discord is a trademark that
belongs to Discord Inc, so it appears here only as a description of what the
extension works with, never as a claim of affiliation. And the description must not
turn into a list of search terms: keyword stuffing in the description is a
documented reason extensions in this category get pulled.

---

## Name

```
Clearline - Message Manager for Discord
```

38 characters, inside the 75 character limit on both stores.

## Short description / summary

Chrome allows 132 characters. This is 94.

```
Search, export and bulk delete your own Discord messages. Your token never leaves the browser.
```

## Category

- Chrome Web Store: Workflow & Planning
- Firefox Add-ons: Privacy & Security

## Firefox tags

```
discord, messages, export, privacy, cleanup
```

---

## Detailed description

```
Clearline finds the messages you wrote on Discord, shows them to you, and lets you
save or remove them.

Discord gives you no way to delete more than one message at a time. Clearline works
through them for you, carefully, and shows you exactly what it is about to touch
before it touches anything.

HOW IT WORKS

Open Discord in a tab and sign in, then click the Clearline icon. It goes in five
steps, one screen at a time.

1. Connect. Clearline reads your session from the Discord tab you already have open.
2. Where. Pick a server, some of its channels, or a direct message.
3. Narrow. Filter by text or a pattern, a date range, whether a message has an
   attachment, a link or an embed, and whether to leave pinned messages alone.
4. Review. See the count and the messages themselves. Untick anything you want to
   keep. Save a copy as HTML, JSON or CSV.
5. Act. Delete them, overwrite the text, or overwrite and then delete. Watch it run,
   pause it, or stop it.

CAREFUL BY DEFAULT

The delete button cannot be reached without first seeing a count and the messages
behind it. Before a run starts you get a plain sentence saying how many messages, in
which place, matching what, roughly how long it will take, and that it cannot be
undone. Runs over a hundred messages ask you to type the count back. A copy is saved
before the first deletion rather than alongside it, so if the export is going to fail
it fails while the messages still exist.

The count only includes messages Discord will actually let you delete. Join notices
and similar system messages are attributed to you and come back in search results,
but nobody can delete them, so Clearline names them separately and leaves them alone
instead of promising more than it can deliver.

Afterwards you get a report that separates what failed from what was skipped, and
offers to retry the failures.

PACED SO YOUR ACCOUNT SURVIVES

This is the part that matters most and the part that is easiest to get wrong.

Every request goes through one queue, one at a time, with a delay between writes that
you cannot lower. Rate limit responses are read and honoured. Four in a row stop the
run, because continuing to generate them is what gets an IP address blocked for an
hour.

Only one Clearline tab works at a time, since a second tab would be a second queue
and Discord would see twice the rate. A second tab tells you so and offers to take
over.

YOUR TOKEN

Discord has no way to authorise an app to read or delete your own message history, so
tools like this work from the session your browser already holds. Being plain about
that matters more than glossing over it.

Clearline reads your session from an open Discord tab, only when you click Connect.
It stays in that tab's memory, is never written to storage, and is gone when you
close the tab. The only site the extension can reach is discord.com. There is no
account, no server, no analytics and no telemetry.

The extension asks for one permission, storage, which it uses to remember a single
tab number.

BEFORE YOU USE IT

Automating a user account is against Discord's terms of service, and people do get
actioned for it. Clearline paces itself far more carefully than the alternatives,
which lowers the odds without removing them. If losing the account would be a serious
problem, export first and decide whether the deletion is worth it.

Clearline is free and open source under the MIT licence. It is not affiliated with,
endorsed by, or connected to Discord Inc.
```

---

## Chrome Web Store review answers

**Single purpose**

```
Clearline lets a person manage the messages they themselves wrote on Discord: find
them, export them, and delete or edit them in bulk. Every feature serves that one
purpose.
```

**Why does the extension need the `storage` permission?**

```
To remember the tab number of the open Clearline tab, using storage.session, so a
second tab can detect that another is already running and step aside. Running two
copies at once would double the rate of requests sent to Discord and defeat the rate
limiting the extension is built around. That single integer is the only thing the
extension ever stores.
```

**Why does the extension need host permission for discord.com?**

```
The extension's entire function is performed against discord.com. It reads the user's
existing session from a discord.com tab so it can act as that user, and it calls the
Discord API to search, export, edit and delete the user's own messages. discord.com
is the only host requested, and the build process fails if any network call appears
outside the single API module or if any address in the source points elsewhere.
```

**Do you use remote code?**

```
No. All code is included in the package. The extension does not evaluate strings as
code, does not load scripts from anywhere, and its build rejects eval, new Function
and importScripts.
```

**Data usage disclosures**

Tick nothing. Then certify all three statements, each of which is true:

- Not being sold to third parties, outside of the approved use cases
- Not being used or transferred for purposes that are unrelated to the item's single
  purpose
- Not being used or transferred to determine creditworthiness or for lending purposes

A note worth adding in the review notes field:

```
This extension reads the user's own Discord session token from a discord.com tab the
user is already signed in to. The token is held in memory in the extension's own tab,
is never written to storage, never logged, and is never sent to any host other than
discord.com. There is no server, no account and no analytics. src/content/handoff.js
is the only file that reads it and src/lib/api.js is the only file that can open a
network connection, which tools/build.mjs enforces at build time.
```

---

## Still needed before submitting

- A public URL for PRIVACY.md. Chrome will not accept a submission without one.
- Screenshots from `store/screenshots/`, at most five.
- A developer account on each store, and the one-off registration fee on Chrome.
