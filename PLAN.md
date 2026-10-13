# OpenProfiles: design notes

Profiles for a free Stremio account, as a small server (one Docker container). Released as 1.x
(see CHANGELOG.md); a public shared server runs at openprofiles.kgenovz.com. This file says how
it works and why: the decisions, and the Stremio behaviour they rest on. README.md is the user
guide. StremShare's own swap-in profiles wind down by linking here (`SNAPSHOT_PROFILES_SPINOFF_URL`
in StremShare).

## What it is

Each profile is a saved library, add-on list and notification set for one Stremio account.
Switching saves the account as it is into the profile being left and writes the chosen one into
the account. You switch from a **Switch profile** row on Stremio's Home or from the web page.
Everything happens to the one account, so every device signed in to it switches together.

It began as StremShare's swap-in profiles, minus everything StremShare-specific, written fresh
and open source: something holding Stremio sign-in keys and debrid-keyed add-on links shouldn't
be closed source inside another app with its own account.

**Who it's for:** households on a free account. Stremio Supporter has native profiles, which
are better (several devices at once); the README and the sign-in page say so.

**Non-goals:** watch-history tracking, recommendations, anything else StremShare does.

## Shape

- Node 22, Express 5, better-sqlite3, one process. No stremio-addon-sdk: the add-on needs its
  own routes (PNG posters, an unlock page) and a stream GET that has side effects.
- `/data` holds the SQLite database and `secret.key` (32 bytes, generated on first boot, or
  `SECRET_KEY`). Image on GHCR (`latest` from main; `X.Y.Z`, `X.Y` and `X` from tags), amd64 and
  arm64, runs as `node`.
- **Sign in with Stremio:** email and password go to Stremio once for an authKey (never stored);
  that Stremio account *is* the OpenProfiles account. One server holds many accounts. `ACCESS`:
  `owner` (default; the first account owns the server), `list` (`ALLOWED_ACCOUNTS`), `open`
  (anyone, up to `MAX_ACCOUNTS`).
- **Encryption:** AES-256-GCM for the authKey and every snapshot, photo and carry-over blob,
  with the account id in the associated data, so a blob moved between accounts won't decrypt.
  A key fingerprint in `meta` makes a wrong `secret.key` refuse to start rather than write data
  the rest can't be read with.
- **The add-on URL carries an unguessable token** (`PUBLIC_URL/<token>/manifest.json`). A stream
  GET switches, so the link is a bearer secret; "Get a new link" rotates it and repoints the
  installed copy.
- Pages: session cookie (HttpOnly, SameSite=Strict), CSRF on every form, sign-in rate limits per
  address and per email, sign-ins only from the server's own page (`Sec-Fetch-Site`, else
  `Origin`; `null` refused), `Referrer-Policy: same-origin`, a CSP with no inline scripts.

## Data model (SQLite)

`accounts` (stremio_user_id, email, auth_key_enc, addon_token, active_profile_id,
addon_installed, notifs_foreign, created_at, last_login_at, last_addon_at, last_seen_at) ·
`profiles` (per account: name, avatar, colour, photo, passcode_hash, library/addons/notifs blobs
and counts, deleted_at for the bin) · `backups` (kind, label, blobs, content_hash, profile_id and
edit_kind for edits, held_profile_id, after_hash, undone_at) · `switch_journal` · `sessions` ·
`activity` (last 200 per account) · `carryovers` · `settings` (Server tab overrides) · `meta`
(key fingerprint, owner, daily-job summary, `sweep:<account>`, unused-account clock).

Migrations: 1 first schema · 2 avatar colours · 3 accounts · 4 backups safety, activity, meta ·
5 edits and undo · 6 after_hash, notifs_foreign · 7 settings, owner · 8 photos · 9 last_addon_at
· 10 carryovers · 11 owner by Stremio id, last_seen_at · 12 passcode_hash · 13 held_profile_id.

Backup retention: `original` forever, `auto` 14 (at most one a day, only when something
changed), `pre_switch` 5, `pre_restore` 3, `pre_change` 20, `manual` 10, `imported` 20. Limits:
20 profiles per account, 10,000 library items, 50 add-ons; the bin keeps a deleted profile 30
days (20 at most).

## Switch algorithm

One operation at a time per account (a mutex per account's service). Steps:

1. **Already active?** Return at once, no API calls: Stremio asks for the stream more than once,
   and opening a page prefetches it.
2. **Locked target?** It needs its passcode (see Passcodes), checked before any Stremio call.
3. **Budget and sign-in:** each Stremio-using operation counts against the account's budget (60
   in 10 minutes; recovery, the daily backup and the background check don't count). `getUser`
   validates the key; auth errors mean "sign in again", 429/5xx "Stremio is busy".
4. **Account anchor:** refuse a target saved from a different Stremio user id.
5. **Target guard:** decode the target BEFORE any write. Refuse a blob that won't decrypt or
   isn't an array, a `library_count > 0` that decodes empty, an empty add-on list (writing `[]`
   uninstalls Cinemeta). Enforce the caps; throw, never truncate.
6. **Read live state** in parallel: library (`datastoreGet all:true`), add-ons, notifications
   (`datastoreMeta` then `datastoreGet ids`; `all:true` fails with 5994). A failed library or
   add-on read aborts; a failed notification read is `null` ("couldn't read"), not `[]`. A read
   that looks broken (no add-ons, or an empty library for a profile with titles) is refused.
7. **One transaction:** a `pre_switch` backup of the live state, the outgoing profile saved
   (verbatim), the journal opened. Recovery therefore only ever restarts at step 8.
8. **Write the library:** a diff as `datastorePut` upserts (chunks of 150, 75 ms apart; retries
   are safe):
   - Live items missing from the target are tombstoned from the FULL item (a minimal one fails
     with "JSON unmarshal err"): `removed:true`, `temp:false`, progress zeroed, `lastWatched`,
     `video_id` and `watched` blank, `noNotif:true`, `_mtime` now. Clean tombstones on both
     sides aren't rewritten.
   - Target items are pushed verbatim with staggered `_mtime`s (sorted by `lastWatched`, `now -
     i` ms): Home's Continue Watching sorts by `_mtime`, and equal values scramble it. `_mtime`
     is an RFC 3339 string; a number gets a 400.
9. **Write add-ons** (`addonCollectionSet`, full replace, order = display order), with
   OpenProfiles itself always in the list and its catalog id naming the target (see below).
   Skipped when unchanged. A failure throws and leaves the journal open: completing with the old
   add-ons would save them into the target at the next switch away.
10. **Notifications** (`notifItem`, chunks of 100; hidden = `dismissed/seen/delivered`): swapped
    even when the target set is empty, else the new profile gets pings for shows it doesn't
    follow. Best-effort; when they can't be swapped, `notifs_foreign` stops them being saved
    into the profile later.
11. **Flip** `active_profile_id`, close the journal.

**Never scrub `removed:true` items.** `removed` isn't "deleted": a title played without being
added to the library is stored `removed:true, temp:true` with real progress, and Continue
Watching shows `(!removed || temp) && timeOffset > 0`. Removed shows keep watched-episode marks
in `state.watched`. Only removed, not temp, with no progress or marks is a clean tombstone.
(A capture-side scrub wiped Continue Watching in the first live test.)

**Recovery:** an open journal means an operation died mid-write. The page offers **Finish** (run
step 8 on again) or **Go back** (restore the `pre_switch` backup), and nothing else can change
the account until one is picked. Live state is never saved over a profile while it's open.

Restores use the same journal (`kind: 'restore'`). Restoring a backup held by a profile that
isn't in use only replaces that profile's saved copy (no Stremio writes).

### Watching on another device during a switch

stremio-core's player saves the playing title every 180 s and on close, from its own copy or one
rebuilt from the library. A device still playing profile A's title after A→B writes it back over
the switch's tombstone, so B would save it as its own. `core/carryover.js` handles this:

- **Following:** a switch follows A's titles in flight (part-way and watched in the last 30 min,
  or started in the last 5 min with no position yet) in `carryovers` (encrypted: A's copy, and
  what the switch wrote), unless B's own copy has progress or marks.
- **Judging** each later read: untouched (not saved since the write), A's, or released to B.
  **When unsure, B keeps it**: getting it wrong the other way erases B's own viewing. A's needs
  the same video at or past A's position (minus 2 min), or the very next episode (same season
  +1, or next season's first; never specials or jumps). For a title A had barely started, the
  position must beat the time since the switch by 3 s (`BEFORE_SWITCH_MARGIN_MS`): playback can't
  outrun the clock, so a fresh start in B never does. Live tests: a 16 s lead saved 89 s in, 74 s
  after; a 5 s lead saved 180.0 s in, 175.1 s after (the position tracked the play mark to 0.2 s).
- **Settling:** a background check every 3 min reads only the followed titles. 7 quiet minutes
  after the last save seen means stopped: A's progress goes into A's saved copy (first, so a
  put whose answer is lost costs nothing; its `_mtime` is remembered) and the switch's copy is
  put back (`_mtime` max of now and the device's + 1 ms, since a fast device clock would win
  otherwise), taking the title out of B's Continue Watching. It stays followed for a resume until
  2 h after the last movement; untouched titles go after 45 min, everything after 12 h. A switch
  or Save now judges the same way at once.
- **Look-over:** a device can start playing seconds before a switch without Stremio knowing yet,
  so the switch can't follow it. Each switch leaves `sweep:<account>` in `meta`; 4 min on (past
  the player's first save) the background check reads the whole library once and follows, as
  A's, any title saved since at a position it couldn't have reached since (`startedBeforeSwitch`),
  when B has no history of it. A switch away or Save now before then does the same.
- Restore, Finish and Go back stop following. An owner in the bin still gets the progress.
- **Accepted limits** (README "Known limitation"): a title started only a few seconds before a
  switch stays in B; the same title in both profiles around a switch stays B's; a device clock
  more than 3 s behind, or someone in B seeking far ahead in a title A had just started, can read
  as A's.

## In-Stremio switcher

- **Manifest:** a catalog of type `OpenProfiles` (the Home row reads "Switch profile -
  OpenProfiles"), and ONE `meta` resource with `idPrefixes:['openprofiles:']`: stremio-core only
  matches the first `meta` resource, and without it Stremio says "No addons were requested for
  this meta" and never asks for streams.
- **The catalog id names the profile in use** (`openprofiles.<id>`). stremio-core keeps a loaded
  Home row while its request is unchanged, even across an add-on change, and only clears it when
  Home closes, so a fixed id left the checkmark on the old profile.
- **Posters:** square PNGs (mobile can't decode SVG), drawn from bundled Figtree glyph paths and
  rasterised with sharp: the picture or photo, the name band, a checkmark on the profile in use,
  a padlock on a locked one.
- **Stream = the switch.** Opening a profile's page requests its stream; the handler switches
  (waiting up to 25 s, else "still switching" while it finishes) and answers ONE stream with
  `description` only (`title` too makes a duplicate field and "No streams were found") and an
  `externalUrl` that refreshes Stremio. No stream plays anything: a playable one lands in
  Continue Watching. Responses are `no-store`.
- **Refreshing without a restart:**
  - Desktop (Stremio 5 is stremio-web): it re-pulls add-ons, user, library and notifications on
    mount and on window focus only. The stream gets `PUBLIC_URL/refresh/go?to=auto`, a hand-off
    page that sends the browser to `stremio:///` (Home). A direct `stremio://` stream link fails
    on desktop (the app hands stream links to the browser). There's no `/board` route any more.
  - Android phones and Android TV: `externalUrl` (and `androidTvUrl`) is `stremio:///library`
    itself; the app opens its own deep link and reloads. Library, because Home re-syncs the
    library but keeps the old add-ons; going back Home then shows everything. Chrome won't follow
    a redirect into the app without a tap, intents do nothing, chained deep links don't fire. The
    Android app sends no User-Agent, which is how the stream tells it from desktop.
  - Library sync is a two-way merge by `_mtime`, so the switch's fresh `_mtime`s and tombstones
    are what make it a switch rather than a merge.
  - Tested: Windows, Android phones, Android TV. Not yet: macOS, Linux, the web app, iOS.
- **Known limitation, stray new-episode cards:** stremio-core's Continue Watching includes any
  item with entries in the device-local notifications bucket, refetched at most every 6 h. The
  previous profile's shows with new episodes can linger for up to 6 h. Rejected:
  `behaviorHints.isLive` on tombstones (core 0.65 only, and a re-added show would keep it).

## Web page

Tabs with their own URLs: Profiles (`/configure`; a profile's editor at `/profiles/:id`: Basics,
Picture, Passcode, Add-ons, Cinemeta, What's saved, Danger zone), the wizard (`/profiles/new`:
name and picture, start from, add-ons, Cinemeta, review; one form that still works without
JavaScript), the add-on manager (`/profiles/:id/addons`), Backups, Install in Stremio, Account,
and Server (owner only). Every page works on a phone (profiles become one row each under 560 px).

- **First run:** the account as it is becomes "Original" plus a permanent `original` backup; a
  checklist offers the first profile and the install until both are done.
- **Add-ons are named by `ref`** (a hash of the link), never the link: links carry debrid keys.
  Add-by-link fetches through `core/fetchGuard.js` (http(s) only, no private or local addresses
  unless `ALLOW_PRIVATE_ADDONS`, the connected address re-checked so DNS can't swap one in,
  redirects re-checked, 5 s, 512 KB, 80 fetches per account per 10 min).
- **Every edit takes a backup first and offers Undo for 24 h** (newest first; undo puts back
  only the add-ons, never the library). The profile in use edits Stremio's live list (refusing a
  stale page by fingerprint); any other edits its saved copy.
- **Cinemeta per profile** edits Cinemeta's manifest in the list: Popular kept behind a required
  `search` extra, New and Featured removed, search and details pages switchable; `last-videos` and
  `calendar-videos` are never dropped (Calendar and new-episode notifications come only from the
  add-on with id `com.linvo.cinemeta`, so a wrapped copy needs a stock "shell" beside it). Reset
  re-fetches the stock manifest, or refuses rather than half-restore.
- **Metadata card:** details pages come from the first add-on in the list that gives meta for
  `tt` ids; picking one moves it to the top and turns Cinemeta's off (or on).
- **Backups tab:** grouped by kind (newest 5 each, the rest folded), restore with a preview,
  download, delete; the bin; Download everything (optionally passphrase-sealed, scrypt N=2^15) and
  bring it back; import from StremShare (both export formats; a file from another account needs a
  confirm).

## Running a shared server

- **Owner:** the first account ever set up, kept as its Stremio user id
  (`meta.owner_stremio_user_id`), so a later account reusing a deleted owner's row id never
  inherits it; the owner signing in again is the owner again. `ADMINS` (user ids are safer than
  emails) adds more. The owner always passes the access rule.
- **Server tab:** counts only, nothing that names or picks out an account: accounts, switches per
  day, daily jobs, database copies, memory and disk, errors and warnings grouped by their fixed
  message. Settings saved there override env (`core/settings.js`: saved → env → default); those
  that decide where the server lives or what it trusts stay env-only.
- **Unused accounts** (`open` only, `REMOVE_UNUSED_DAYS`, default 90, 0 never): used means a
  sign-in, a page visit (`last_seen_at`), any activity, or Stremio asking the add-on for anything
  (`last_addon_at`, written at most hourly). Only days the server ran count
  (`meta.unused_clock_since` restarts after a gap of more than 2 days), at most 5 go per daily
  run, never the owner or `ADMINS`, never an account with an unfinished switch. Someone signing
  up again gets their stale installed add-on repointed to the new token.
- **Uploads:** one at a time server-wide, cut off after 2 minutes; logo and photos are decoded by
  sharp (PNG, JPEG or WebP, at most 25 megapixels) and redrawn, nothing else from the file kept.
- **Logs** never hold emails, IP addresses, add-on links, watch history or passcodes; tokens in
  paths are masked. The privacy page lists everything kept.
- **Daily jobs** (once per UTC day, checked hourly): a `VACUUM INTO /data/snapshots/` copy (7
  daily + 4 weekly), unused-account removal, each account's automatic backup, emptying bins.

## Passcodes

A keep-the-kids-out lock, not security: anyone with the Stremio password gets past it.

- Exactly 4 digits, kept as `s1$<salt>$<scrypt>`; pages and the add-on only ever see
  `has_passcode`. Exports carry the hash; an import keeps it only if it parses.
- `doSwitch` asks for the target's code after the already-active check and before any Stremio
  call. An unlock is that one switch; switching away never asks.
- **In Stremio** a locked profile's stream doesn't switch: it answers **Unlock** (`externalUrl` and
  `androidTvUrl` = `/<token>/unlock/<id>`) and the usual Refresh. The unlock page needs no session
  (the token proves the account; a bad one is the usual 404); its form carries a one-time nonce
  held in memory (15 min, 20 per account). Success switches and lands on a page that
  meta-refreshes to the same deep link as Refresh, with a Back to Stremio button. A TV without a
  browser unlocks from a phone, then presses Refresh.
- **Web:** Switch on a locked profile asks for the code; so do restoring and downloading a backup
  it holds (`held_profile_id`), unless it's in use. Changing or removing a code needs the current
  one, or a sign-in in the last 10 minutes (how a forgotten code is reset).
- 5 wrong codes in a row, per account and across every page, refuse codes for 15 minutes (in
  memory, checked inside the account's lock).

## Profile pictures

A letter, eleven hand-drawn characters, generated DiceBear faces (CC0 styles only), or one
uploaded photo per profile (shrunk in the browser, redrawn as a 512 px JPEG, encrypted with the
profile, in exports). `avatar_preset` is `initial`, `char:<id>`, `gen:<style>:<seed>` or
`photo:<hash>` (only the profile's own current hash is accepted).

## Stremio API client (reference)

POST `https://api.strem.io/api/<method>` with a JSON body. Up to 4 tries with exponential backoff
and jitter on 429/500/502/503/504/529 and network errors, honouring `Retry-After`; 20 s timeout.
Never put response bodies in errors or logs (Stremio echoes submitted fields), never log add-on
links.

| Need | Method | Body |
|---|---|---|
| Sign in | `login` | `{ email, password, type:'Login', facebook:false }` → `result.authKey` |
| Who am I | `getUser` | `{ type:'GetUser', authKey }` → `_id`, `email`, `parent_id?`, `premiumPrefs` |
| Library read | `datastoreGet` | `{ authKey, collection:'libraryItem', all:true }`, or `ids:[…]` |
| Library write | `datastorePut` | `{ authKey, collection:'libraryItem', changes:[…] }` |
| Notif ids | `datastoreMeta` | `{ authKey, collection:'notifItem' }` → `[[id, mtime], …]` |
| Notif read | `datastoreGet` | `{ authKey, collection:'notifItem', ids:[…] }` |
| Add-ons read | `addonCollectionGet` | `{ type:'AddonCollectionGet', authKey, update:true }` → `result.addons` |
| Add-ons write | `addonCollectionSet` | `{ type:'AddonCollectionSet', authKey, addons:[…] }` (full replace) |

## Later

- Test on macOS, Linux, the web app and iOS (and Stremio 4).
- Whether the stray new-episode cards are noticeable on a profile with a full Continue Watching
  row.
- A curated starter list of add-ons for new profiles.
