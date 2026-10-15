# Changelog

## 1.2.2 (2026-10-15)

- **Adding an add-on by link** takes links up to 64 KB: configured add-ons with keys in the link
  can be long, and the page refused anything over 8 KB.
- **Clearer messages when something fails:** the page now says what happened (too big, with the
  limit; the server took too long; signed out; page expired; a server problem; or no connection)
  instead of a guess like "check the connection" or "that file isn't an export". Too-big messages
  name what was too big and the limit (add-on links, photos, logos, imports).
- Oversized or malformed requests are logged as warnings, not errors.

## 1.2.1 (2026-10-14)

- **Less memory:** sharp's own image cache is off (the drawn posters are cached already), and the
  Docker image sets `MALLOC_ARENA_MAX=2`. A server drawing art for 300 profiles settled about
  40 MB lower. If you set a memory limit, 512 MB (the example compose file) leaves headroom for
  a shared server; a household needs far less.

## 1.2.0 (2026-10-13)

- **Profile passcodes:** a profile can have a 4-digit passcode (**Edit › Passcode**). Switching
  to it asks for the code on the web page; in Stremio its tile shows a padlock, and opening it
  offers **Unlock** (a page in the browser that switches, then goes back to Stremio) and
  **Refresh**. Changing or removing a code needs the current one, or a fresh sign-in with the
  Stremio password. 5 wrong codes in a row wait 15 minutes. Restoring or downloading a backup of
  a locked profile asks for its code too. "Download everything" keeps the lock. The database gains
  two columns (applied on start).

## 1.1.1 (2026-10-13)

- **Watching on another device during a switch:** a title goes back to the profile that was
  watching only when it clearly kept playing there; when in doubt, the profile in use keeps it, so
  its own viewing is never taken away or erased.
  A title started seconds before a switch, before Stremio heard of it, is found about 4 minutes
  later (the server looks over the whole library once per switch) and goes back the same way.
- **Backups page:** each group shows its newest 5, with the rest under "Show older".
- **Owner:** the server's owner is their Stremio account, not an account number. If the owner
  deletes their account, someone signing up later no longer becomes the owner; the owner signing
  in again is the owner again. A server whose owner already left upgrades with no owner: name
  yourself in `ADMINS` to get the Server tab back.
- **Unused accounts** (`ACCESS=open`): only days the server was running count, so an outage no
  longer removes everyone at the next start. At most 5 go a day, an account with an unfinished
  switch is kept, and visiting the pages counts even after that browser signed out.
- `REMOVE_UNUSED_DAYS` or `MAX_ACCOUNTS` set to something the Server tab can't take now stops
  the server at start with a message, instead of being ignored.
- Signing up again after an account was removed points the add-on Stremio still has at the new
  account (its old link stopped working). "Installed" now means installed with this account's link.
- A sign-in that says `Origin: null` from a browser without `Sec-Fetch-Site` is refused (our own
  pages send their real origin).
- An upload still arriving after two minutes is cut off, so it can't keep other uploads waiting.
  Profile photos and logos over 25 megapixels are refused.
- README: list `ADMINS` by Stremio user id rather than email, and what can still cross over
  between profiles when someone is watching during a switch (Known limitation).

## 1.1.0 (2026-10-12)

- **Watching on another device during a switch:** the title's progress goes to the profile that
  was watching, not the one switched to, and the title leaves the new profile's Continue Watching
  about 10 minutes after playback stops.
  That includes a title started moments before the switch, before the player saved any
  progress. The "Save now before switching" advice is gone: it isn't needed any more.
- The example compose file follows the `1` image, so `docker compose pull` brings every 1.x
  release, not only 1.0.x fixes.
- README: the Profiles screenshot without that advice.

## 1.0.1 (2026-10-12)

- **Phones:** each profile is one compact row (picture on its colour at the left, name and
  buttons beside it), so a whole household fits on one screen.
- README: a demo of switching on a phone, and the Switch profile row in Stremio.

## 1.0.0 (2026-10-12)

The first release. OpenProfiles gives a free Stremio account profiles: each one keeps its own
library, Continue Watching, add-ons and new-episode notifications.

- **Switching** from the web page or from a **Switch profile** row on Stremio's Home. Tapping a
  profile's stream refreshes Stremio afterwards (desktop, Android phones, Android TV).
- **New-profile wizard:** name, picture and colour; start empty or from a copy; pick and order
  add-ons; choose Cinemeta's catalogs.
- **Add-on manager per profile:** reorder, remove, add by link or from another profile, rename
  catalogs, check add-ons still answer, Undo for 24 hours. Add-on links never show on the
  pages.
- **Cinemeta and metadata:** hide Popular, New or Featured, turn search or details pages off,
  pick which add-on gives details pages. Calendar and new-episode notifications keep working.
- **Nothing gets lost:** a backup before every switch, restore and edit, plus daily ones, a
  bin for deleted profiles, download or bring back everything in one file, nightly database
  copies, and recovery for a switch that stopped partway.
- **Sign in with Stremio**, one or many accounts per server (`ACCESS=owner|list|open`), each
  seeing only its own data. Shared servers remove accounts unused for 90 days
  (`REMOVE_UNUSED_DAYS`).
- **Server tab** for whoever runs it: counts-only overview, who can sign in, look, texts, and
  how the add-on presents itself in Stremio.
- **Profile pictures:** a letter, hand-drawn characters, generated faces, or a photo of your own.
- Import from StremShare backups.
- Images for `amd64` and `arm64` at `ghcr.io/kgenovz/openprofiles` (`1.0.0`, `1.0`, `latest`).
