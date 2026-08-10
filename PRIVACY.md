# Privacy policy

Last updated 5 August 2026. Applies to the Clearline browser extension, version 1.1.0.

## The short version

Clearline collects nothing, sends nothing anywhere, and has no server. Everything it
does happens inside your browser, between you and Discord.

## What the extension handles

**Your Discord session token.** Clearline reads it from an open discord.com tab when
you click Connect, and uses it to authenticate the requests you ask it to make.

- It is held in the memory of the Clearline tab and nowhere else.
- It is never written to extension storage, browser storage, a cookie, a file, or a
  log.
- It is never sent anywhere except to discord.com, in the Authorization header of
  the requests Clearline makes on your behalf.
- Closing the tab forgets it. Reconnecting reads it again.

**Your messages.** The messages Clearline finds are held in the memory of the tab so
they can be shown to you, exported if you ask, and acted on if you choose.

- They are not transmitted anywhere.
- They are not stored between sessions.
- If you export them, the file is written by your browser to wherever you save it.
  Clearline does not keep a copy and does not see where it went.

**Your Discord account name and id.** To find the messages you wrote, Clearline has to
know which account you are, so it asks Discord who you are signed in as.

- Discord's answer includes fields Clearline has no use for, including the email
  address on the account. Clearline keeps three of them, the account id, the username
  and the discriminator, and discards the rest rather than holding on to data it never
  reads.
- The id is used to ask Discord for only your own messages. The name is shown at the
  top of the window and written into the header of an export you asked for.
- They live in the tab's memory, are never written to storage, and go when you close
  the tab.

**One number in extension storage.** Clearline stores the tab id of the open
Clearline tab, using `storage.session`, so a second tab knows another one is already
running. It is a small integer, it identifies nothing about you, and the browser
discards it when you close the browser.

## What the extension does not do

- No analytics, telemetry, crash reporting, or usage measurement.
- No accounts, no sign-up, no licence check, no phoning home.
- No advertising and no advertising identifiers.
- No selling or sharing of data, because no data is collected to sell or share.
- No remote code. The extension ships everything it runs, and its build fails if any
  network call appears outside the single API module, or if any address in its
  source points anywhere other than discord.com.

## Permissions and why they exist

- **`storage`.** Holds the single tab id described above.
- **Access to discord.com.** Required to read your session from a Discord tab and to
  make the requests you ask for. This is the only site the extension can reach.

That is the whole list. Clearline cannot read any other website.

## The support link

The bottom of the Clearline page has a link to a Buy Me a Coffee page. It is an
ordinary link and nothing happens unless you click it.

- It is not loaded, contacted, or pinged in the background. Nothing is requested from
  that site unless you choose to go there.
- It opens in a new tab and carries `rel="noopener noreferrer"`, so the page you land
  on is not told which page sent you and cannot reach back into the Clearline tab.
- Nothing about you, your account, or your messages is attached to it. It is the same
  static address for everyone.

If you do follow it, Buy Me a Coffee handles that visit under its own privacy policy.
The extension's build refuses to let that address be used for anything other than a
link, and refuses to let it appear at all in the one file permitted to open a network
connection.

## Data Discord receives

Using Clearline causes your browser to make requests to Discord's API as your
account. Discord receives those requests and handles them under its own privacy
policy, which is not something this extension controls or has any visibility into.

## Children

Clearline is not directed at children and collects no information from anyone.

## Changes

If this policy changes, the version and date at the top will change with it, and the
change will be listed in the project changelog.

## Contact

Questions about this policy can be raised as an issue on the project's public
repository.
