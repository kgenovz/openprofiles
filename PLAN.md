# OpenProfiles: a self-hosted profile switcher for Stremio (plan)

Status: M1 in progress (2026-10-10). Repo: `kgenovz/openprofiles`. StremShare's swap-in profile
wind-down (docs/snapshot-profiles-retirement-plan.md in the StremShare repo) links here via
`SNAPSHOT_PROFILES_SPINOFF_URL`.

## What it is

A small, open-source add-on you run yourself (one Docker container) that gives one Stremio
account several profiles. Each profile is a saved library, add-on list and notification set.
Switching saves the current state into the outgoing profile and writes the incoming one to the
account. You switch from a web page or from a "Switch profile" row inside Stremio.

It is StremShare's swap-in profiles, minus everything StremShare-specific (templates, rec
rails, curator, catalog memory, watch-history stamping), written fresh.

**Who it's for:** households on a free Stremio account. Stremio Supporter accounts have native
profiles, which are better (all work at once); the README and the setup page say so.

**Non-goals (v1):** multi-tenant hosting for strangers, watch-history tracking, per-profile
catalogs, anything StremShare does.

## Naming

- Product name: **OpenProfiles** (inside Stremio the add-on shows as "OpenProfiles").
- Repo/package: `openprofiles` (`kgenovz/openprofiles`). Doesn't lead with the Stremio trademark.
- License: MIT (in the repo).

## Shape

- Node 20+, Express (or Fastify), better-sqlite3, one process. No stremio-addon-sdk: we need
  custom routes (configure page, videos, PNG posters) and side-effecting stream GETs.
- **Single-tenant by design:** one instance serves one Stremio account. Multi-account is a
  later maybe. This keeps auth simple and the blast radius small.
- `docker compose up` with one volume (`/data`: SQLite DB + generated secret key). Publish an
  image to GHCR. Env: `PUBLIC_URL` (required, https), `ADMIN_PASSWORD` (required), optional
  `DATA_DIR`, `PORT`, `LOG_LEVEL`.
- Secrets: a 32-byte key generated into `/data/secret.key` on first boot (or `SECRET_KEY` env).
  AES-256-GCM for the Stremio authKey and all snapshot blobs (add-on transport URLs carry
  debrid keys; libraries are personal data).
- **Add-on URL carries an unguessable token**: `PUBLIC_URL/<token>/manifest.json`. A stream GET
  performs a switch, so the URL is a bearer secret. Rotate from the web page.
- Web page (`/configure`) behind `ADMIN_PASSWORD` (session cookie, SameSite=Strict, CSRF on
  writes, rate-limited login).

## Data model (SQLite)

- `account`: one row. stremio_user_id, stremio_email, auth_key_enc, linked_at.
- `profiles`: id, name (unique), avatar (preset id + colour), library_enc, addons_enc,
  notifs_enc, library_count (excl. tombstones), addon_count, notif_count, snapshot_taken_at,
  stremio_user_id (anchor), created_at.
- `state`: active_profile_id, addon_token.
- `backups`: id, kind (`original` | `auto` | `pre_switch` | `pre_restore` | `manual` |
  `imported`), label, blobs, counts, stremio_user_id, created_at. Retention: original never
  pruned; auto keep 7 (max 1/day); pre_switch keep 5; pre_restore keep 3; manual keep 10.
- `switch_journal`: id, from_profile_id, to_profile_id, phase, started_at, finished_at, error.
  (StremShare had no journal; see "Switch algorithm".)

## Switch algorithm (with StremShare's lessons built in)

One switch at a time (process-wide mutex; single tenant). Steps:

1. **Already active?** Return immediately, no API calls (the in-Stremio stream can fire twice;
   stream prefetch and detail-page opens can hit it too, so it must be idempotent).
2. Validate the token with `getUser`. Map auth errors to "sign in again", network errors to
   "Stremio unreachable", 429/503/529 to "Stremio is busy, try again in a minute".
3. **Account anchor:** refuse if the target profile's `stremio_user_id` differs from the linked
   account (applying A's snapshot to B overwrites B's library and debrid-keyed add-ons).
4. **Target guard (StremShare missed this):** decrypt the target's library/add-ons BEFORE any
   write. Refuse if a blob can't be decrypted, isn't an array, or `library_count > 0` but the
   decoded array is empty. Refuse an empty add-on list (writing `[]` uninstalls Cinemeta and
   everything else). Enforce caps: 10,000 library items, 50 add-ons. Throw, never truncate.
5. Read live library (`datastoreGet libraryItem all:true`), add-ons (`addonCollectionGet`) and
   notifications (via `datastoreMeta` + `datastoreGet ids`; `all:true` fails with 5994) in
   parallel. A failed library or add-on read aborts. A failed notification read = `null`
   ("couldn't read"), not `[]`.
6. **Journal `started`** and take a `pre_switch` backup of the live state. If it fails, abort.
7. **Save the outgoing profile** (library + add-ons + notifications in one transaction; keep the
   old notification blob if the read failed). Store items **verbatim**.
   ~~Capture-side scrub: zero the resume fields on every `removed:true` item.~~ **Wrong, removed
   2026-10-11 after it wiped Continue Watching in the first live test.** `removed: true` is not
   "deleted": anything played without being added to the library is stored as
   `removed: true, temp: true` with real progress, and Continue Watching shows
   `(!removed || temp) && timeOffset > 0`. Removed shows also keep watched-episode marks in
   `state.watched`. The "pollution" StremShare saw was this data. Only an item that is removed,
   not temp, and has no progress or watched marks counts as a clean tombstone.
8. **Write the library** (diff-based full replace via `datastorePut changes:[…]`, chunks of 150,
   75 ms apart; upserts by `_id`, so retries are safe):
   - Items live now but missing from the target are tombstoned with the FULL original item
     (a minimal tombstone fails with "JSON unmarshal err"): `removed:true`, `temp:false`, zero
     `timeOffset/timeWatched/timesWatched/flaggedWatched/overallTimeWatched`, blank
     `lastWatched/video_id/watched`, `noNotif:true`, zero season/episode, `_mtime` now.
   - Target items pushed verbatim (keep `state`, `temp`, `removed`), with staggered `_mtime`s:
     sort by `state.lastWatched` desc, assign `now - i` ms (the home Continue Watching row
     sorts by `_mtime`; identical values scramble it).
   - `_mtime` is an RFC 3339 string (`toISOString()`); a millisecond integer gets a 400.
9. **Write add-ons** (`addonCollectionSet`, full-list replace, array order = display order),
   **making sure the Profiles add-on itself is in the list** (insert it if the target profile's
   list lacks it, keep its URL current). Otherwise the switcher row vanishes after switching
   into a profile captured before Profiles was installed. Best-effort: on failure, record it
   in the journal and continue (the library is already swapped; throwing would leave the
   pointer unflipped and a retry would save the swapped library into the outgoing profile).
10. **Write notifications** (`notifItem`, chunks of 100; tombstone = `dismissed/seen/delivered`
    all true; leave `_mtime` alone). Swap even when the target set is empty ("clean slate"),
    else the user gets new-episode pings for shows outside the profile. Skip if the live read
    failed. Best-effort.
11. **Flip `active_profile_id`**, journal `finished`.

**Recovery (new):** on boot and before any switch, an unfinished journal row means a switch died
mid-write. Show it on the web page with two buttons: "Finish switching to X" (re-run from step 8
with the saved target) and "Go back to Y" (restore the `pre_switch` backup). Never auto-save
live state while a journal row is open (that is how StremShare could save a half-swapped
library over the good outgoing snapshot).

**Dropped from StremShare:** resume-position healing and cross-profile exclusion. Both depend
on StremShare's scrobble table, which Profiles doesn't have. Mitigation: "Save now" on the web
page and a hint ("finished watching on another device? save before switching"). Possible v2:
compare live item `state.timeOffset` vs the stored one per `_id` and only ever advance.

*Built (2026-10-12), titles still playing elsewhere after a switch* (`core/carryover.js`,
migration 10). stremio-core's player saves the played title every 180 s and on close, from its
own copy or one rebuilt from the library (it keeps the stored flags and state), so a device still
playing A's title after A→B writes it back over the tombstone and B would save it. A switch now
follows A's titles that were part-way and watched in the last 30 min (`carryovers`, encrypted:
A's copy, and what the switch wrote). Every later read judges each one: untouched (mtime not past
the write), A's (same video at or past A's position minus 2 min, finished, or a later episode:
someone in B starts from zero because the tombstone has no progress), or released to B. A's
progress merges into A's saved copy (position from live, everything else from A's copy, counters
never down; episode marks made on a rebuilt copy are lost) and B saves what the switch wrote
instead. The switch back to A writes the merged copy. A background check every 3 min reads only
the followed titles (one `datastoreGet` by ids, not counted in the budget); 7 quiet minutes after
the last save seen means stopped, so it puts the written copy back (out of B's Continue Watching)
and keeps following for a resume until 2 h after the last movement. Untouched titles go after
45 min, everything after 12 h; a restore, Finish or Go back stops following. The hint was removed.

*Tightened the same day: when unsure, the profile in use keeps it.* A review found the "A's"
verdict too loose, and the put-back then erased B's own viewing. Now A's needs strong evidence,
anything else behaves as if nothing were followed: never a title B's copy (what the switch
wrote) has progress or marks in (not even followed); only the very next episode (same season +1,
or next season's first; never specials, never a jump); with A under 2 min in at the switch
(just started, or finished and back at 0), a position more than 3 s past the time since the
switch (device `lastWatched` − follow time), i.e. playback began before it (a live test: started
16 s before, saved at 89 s 74 s after; another 5 s before, saved at 180.0 s 175.1 s after); finished counts only sooner than the video's length after
the switch. A's progress is saved before the put-back, whose `_mtime` (max of now and the
device's + 1 ms, as a fast device clock would win otherwise) is remembered, so a put that lands
with its answer lost reads as untouched. Signed out keeps records until they expire; an owner in
the bin still gets progress (into its binned row) and the put-back. Known gap: a device clock
more than 3 s behind, or someone in B seeking past the time since the switch, can still read as
A carrying on a title A had barely started.

*Look-over after a switch (2026-10-13):* a live test started a movie seconds before switching,
before the device had told Stremio, so the switch had nothing to follow and the movie's saves
went into B. Each switch now leaves a `meta` row `sweep:<account>` (`switchAt`, from, to).
`SWEEP_AFTER_MS` (4 min, past the player's first 3-minute save) on, the background check reads
the whole library once: a title saved since the switch at a position it couldn't have reached
since (`startedBeforeSwitch`, the same proof as above) whose B copy has no history of its own is
followed as A's from then on (`strayRecords`), and goes home like any other. A switch away or
Save now before the look-over runs the same test on the library it reads anyway. Restore and
recovery drop the row; it's let go after 30 minutes.

## In-Stremio switcher

- Manifest: catalog `{ id:'profiles', type:<'other' or similar>, name:'Switch profile' }`, the
  type listed in `types[]`, and ONE `meta` resource with `idPrefixes:['profiles:']` (stremio-core
  only matches the first `meta` resource; without it Stremio shows "No addons were requested
  for this meta" and never asks for streams). Resources: catalog, meta, stream.
- Catalog: one meta per profile, `id: profiles:<id>`, `posterShape:'square'`, **PNG posters**
  (mobile can't decode SVG), the active profile gets a poster with a baked-in checkmark (mobile
  grids show nothing else). Generate posters at boot with `sharp` (initial on colour).
  *Built note:* the catalog id names the profile in use (`openprofiles.<id>`). stremio-core keeps a
  loaded Home row while its request is unchanged, even across an add-on change, and only clears it
  when Home closes (Library opens on top of it), so a fixed id left the checkmark on the old profile.
- Meta: minimal (name, poster, background, description), echo the requested type; 404 for
  unknown ids.
- Stream GET **performs the switch**, then returns one stream
  `{ name, description, url: PUBLIC_URL/switching.mp4, behaviorHints:{ notWebReady:true } }`;
  errors return `/switch-error.mp4` with the reason in `description` (put the key line first:
  mobile pickers truncate). Playing the clip is optional; it covers the refresh.
- ~~Tell the user: "Close and reopen Stremio" (the only refresh that works on every client).~~
  **Refresh without a restart (2026-10-11):** the success stream's `externalUrl` makes Stremio
  leave and re-enter, which re-syncs. Desktop gets `PUBLIC_URL/refresh/go?to=auto` (a 302 to a
  `stremio://` deep link, behind a dark hand-off page), Android gets the deep link directly.
  A second stream keeps the clip + "close and reopen" fallback.
  - Desktop (Stremio 5 runs stremio-web): `PullAddonsFromAPI`, `PullUserFromAPI`,
    `SyncLibraryWithAPI` and `PullNotifications` fire on mount and on window `focus` only
    (src/App/App.js). Redirect to `stremio:///` (Home). A direct `stremio://` stream link fails
    on desktop: the app hands every stream link to the browser, which can't open it. Current
    stremio-web has no `/board`
    route: it shows "page not found". Switching from the settings page needs only a click back
    into Stremio.
  - Android (tested on a Galaxy S22): the stream's `externalUrl` is `stremio:///library`
    itself. The app opens its own deep link with no browser and reloads. That works perfectly.
    The browser route doesn't: Chrome won't follow a redirect (or script) into an app without
    a tap on the page when another app opened it. Library (or `/addons`) is the target because
    Home re-syncs the library but keeps the old add-ons on Home; Library reloads everything
    once you go back Home. Intents (`intent://…package=com.stremio.one`) do nothing; chained
    deep links don't fire. The Android app's stream request has no User-Agent, while desktop
    (WebView2) sends a Windows browser one, which is how the stream picks the link.
  - Library sync is a two-way merge by `_mtime` (client pushes its newer items back), so the
    switch's now-stamped writes and tombstones are what make it a switch, not a merge.
  - Unverified: Android TV, iOS, Stremio 4.
- **Known limitation, stray new-episode cards (2026-10-11):** stremio-core's Continue Watching
  (models/continue_watching_preview.rs) includes any library item with entries in the local
  `NotificationsBucket`, removed or not, sorted by newest episode release. The bucket is
  device-local (storage key `notifications`; the server `notifItem` collection isn't read) and
  pruned only when `PullNotifications` actually refetches, throttled to every 6 h
  (update_notifications.rs), on login, or on dismiss. So the previous profile's shows with new
  episodes linger in CW for up to 6 h after a switch. Rejected workaround: `behaviorHints.isLive`
  (or type `tv`) on tombstones hides them (CW skips live items), but it only exists in core 0.65
  (Oct 2026) and a show re-added from the other profile would keep the flag and become a "live"
  item. Still to check: how noticeable it is on a profile with a full Continue Watching row.
- Make our own short clips (no third-party footage). `Cache-Control: no-store` on catalog and
  stream responses.

## Web page

- First run: sign in with Stremio email + password → authKey (password never stored). Refuse a
  native child-profile key (`getUser` has `parent_id`). If the account has native profiles
  (`premiumPrefs.userProfiles`), warn: "your Stremio account has its own profiles; Profiles
  would swap the library inside whichever one is open."
- Setup creates "Original" (current state, also the immutable `original` backup) and offers
  "New empty profile" (same add-ons, empty library and notifications).
- Profile list: switch, save now, rename, avatar, delete (not the active one), "create from
  current" / "create empty".
- Backups: list by kind, restore (preview counts first; take `pre_restore`), download, delete.
- **Import from StremShare:** upload a StremShare backup export (`format:
  "stremshare-account-backup"`, `version: 1`; spec in docs/snapshot-profiles-retirement-plan.md
  appendix) → becomes a new profile (or a backup). Refuse when its `stremio_user_id` differs
  from the linked account, unless the user ticks "this is a different account, I understand".
- Add-on link with copy, "Install in Stremio" deep link, rotate.
- Unfinished-switch banner (journal recovery).

## Stremio API client (reference)

POST `https://api.strem.io/api/<method>` with a JSON body. Retry up to 4 times with exponential
backoff + jitter on 429/500/502/503/504/529 and network errors, honouring `Retry-After`. Never put
response bodies in error messages or logs (Stremio echoes submitted fields). Never log add-on
transport URLs.

| Need | Method | Body |
|---|---|---|
| Sign in | `login` | `{ email, password, type:'Login', facebook:false }` → `result.authKey` |
| Who am I | `getUser` | `{ type:'GetUser', authKey }` → `_id`, `email`, `parent_id?`, `premiumPrefs` |
| Library read | `datastoreGet` | `{ authKey, collection:'libraryItem', all:true }` → array (throw on non-array) |
| Library write | `datastorePut` | `{ authKey, collection:'libraryItem', changes:[…] }` |
| Notif ids | `datastoreMeta` | `{ authKey, collection:'notifItem' }` → `[[id, mtime], …]` |
| Notif read | `datastoreGet` | `{ authKey, collection:'notifItem', ids:[…] }` |
| Add-ons read | `addonCollectionGet` | `{ type:'AddonCollectionGet', authKey, update:true }` → `result.addons` |
| Add-ons write | `addonCollectionSet` | `{ type:'AddonCollectionSet', authKey, addons:[…] }` (full replace) |

## Milestones

1. **M1 core:** sign-in, profiles CRUD, switch from the web page with the full algorithm +
   journal + backups. Tests against a mocked Stremio API (diff/tombstone rules, target guard,
   empty add-on refusal, journal recovery, idempotent re-switch).
   *Built 2026-10-10, not yet tried on a real account.* Decisions made while building:
   - Steps 6 and 7 (pre_switch backup, outgoing save, journal open) are one SQLite transaction,
     so recovery only ever restarts at step 8.
   - Restores use the same journal (`kind: 'restore'`) and the same Finish / Go back recovery.
   - Clean tombstones aren't re-written (live or target side); tombstones pile up across
     switches, so this keeps each switch's writes close to the real difference.
   - A profile with no saved notifications (`notifs_enc` NULL) skips the notification swap
     with a warning rather than treating it as a clean slate.
   - The add-on write is skipped when the target list equals the live one.
   - `scripts/dev-stremio.js` serves the test fake over HTTP for trying the web page locally.
2. **M2 in-Stremio switcher:** manifest/catalog/meta/stream, PNG posters, clips, self-insert of
   the Profiles add-on into every profile's add-on list.
   *Built 2026-10-10, not yet tried in a real Stremio client.* Design canvas (posters, Home row,
   phone flow, clips, settings page): https://claude.ai/artifact/MM5EADPs5PtpRcSscSGoNB.
   Decisions made while building:
   - Catalog type `OpenProfiles`, so the Home row reads "Switch profile - OpenProfiles".
     Meta ids are `openprofiles:<id>`.
   - Posters are drawn from bundled Figtree glyph paths (opentype.js) and rasterised with
     sharp, so they don't depend on the container's fonts. Names the font can't draw get a
     person glyph. Avatar colours were darkened so white text passes contrast; migration 2
     remaps existing profiles.
   - Opening a profile's page in Stremio requests its stream, so opening it switches. The
     stream text is written for that ("Switched to Kids").
   - The stream handler waits up to 25 s for the switch, then answers "still switching" and
     lets it finish in the background.
   - "Get a new link" repoints the installed add-on in the account before changing the token.
   - Clips are made by `scripts/make-clips.js` (ffmpeg-static, dev only) and committed.
3. **M3 ship:** StremShare import, Docker image on GHCR, README (setup, Supporter warning,
   "switching rewrites the library on every device", backup/restore, recovery), MIT license,
   CI (lint + tests). Live test on a burner Stremio account across desktop, Android, TV.
   *Built 2026-10-10 except the live test.* Notes:
   - Import reads both StremShare formats (v1 `format`/`version`, and pre-v1 `schemaVersion`),
     saves an `imported` backup and optionally a profile, and never writes to Stremio. A file
     whose account doesn't match, or can't be told, needs a confirm tick. The upload is held
     server-side for 15 minutes between the preview and confirm steps.
   - Profile pictures (added alongside M3): letter, eleven hand-drawn characters (including
     "Spark", Claude's self-portrait), or DiceBear faces from CC0 styles only. Stored in
     `avatar_preset` as `initial`, `char:<id>` or `gen:<style>:<seed>`.
   - Node 22+ (better-sqlite3 13 requires it). Image: `node:22-bookworm-slim`, runs as `node`,
     multi-arch (amd64, arm64), published by `.github/workflows/docker.yml`.
4. **Then** set `SNAPSHOT_PROFILES_SPINOFF_URL` on StremShare prod and start the wind-down.

Later maybes: resume healing v2, a curated add-on list.

## Phase 2 (planned 2026-10-11): accounts, safety, ease

Kyle's three asks, in build order. Each is a milestone with its own tests; the design canvas gets
the sign-in, wizard and edit-page screens before M5/M6 are built.

### M4: sign in with Stremio, many accounts per server

*Built 2026-10-11.* Migration 3 + the re-encryption were checked on a copy of Kyle's real local
data first (token kept, every profile and backup decrypts).

No admin password. You sign in with your Stremio email + password (sent to Stremio once for an
authKey, never stored), and that Stremio account *is* your OpenProfiles account. One server
holds many accounts, which is what the free hosted instance needs; a self-hosted server is just
one with an access rule.

- **Access rule** (env `ACCESS`): `owner` (default for self-hosting: the first account to sign
  in owns the server, nobody else can sign in), `list` (only `ALLOWED_ACCOUNTS`, emails or
  Stremio user ids), `open` (anyone; the hosted instance). `MAX_ACCOUNTS` caps `open`.
- **Data model** (migration 3): `accounts` (id, stremio_user_id unique, email, auth_key_enc,
  addon_token unique, active_profile_id, addon_installed, created_at, last_login_at,
  settings_json) replaces `account` + `state`. `profiles`, `backups`, `switch_journal`,
  `sessions` gain `account_id` (NOT NULL, FK, cascade). The existing single account migrates
  to account 1 with its token unchanged, so installed add-ons keep working. Profile names are
  unique per account.
- **Keys:** each account's blobs are bound to the account id in the AES-GCM associated data
  (`<purpose>:<accountId>`), so a blob moved between accounts won't decrypt. (Built that way
  instead of a per-account HKDF key: the binding is what matters, and one key stays simple to
  back up.) Pre-accounts data is re-encrypted once at boot (`core/rekey.js`, `enc_version`).
- **Service:** one `ProfilesService` per account (cached), each with its own mutex; the add-on
  routes resolve token → account. Everything that is "the account" today becomes "this account".
- **Sessions:** cookie session → account; 30-day idle expiry; "Signed in on" list with sign-out
  everywhere. An expired Stremio authKey asks you to sign in again; your profiles stay.
- **Delete my account:** removes everything for that account after a typed confirmation and a
  final download offer.

### M5: nothing gets lost

*Built 2026-10-11* (migration 4: `backups.content_hash`, `backups.profile_id`, `activity`, `meta`).
Undo for an edit = restoring its `pre_change` backup: for a profile not in use that only puts the
profile's saved copy back (no Stremio writes), and takes a backup of the current copy first. The
edit tools themselves (and their "Undo" banner) arrive with M6. The SSRF guard lands with the
add-on manager in M6, which is its first user. Daily jobs (`core/scheduler.js`) run once per UTC
day, checked hourly and two minutes after boot.

- **Automatic backups:** daily `auto` backup of each account's live state (keep 14), only when
  something changed since the last one; plus the existing pre-switch / pre-restore ones.
- **Undo for every write:** add-on and Cinemeta edits, profile edits and imports take a
  `pre_change` backup (keep 20) and show "Undo" for 24 h.
- **Deleted profiles go to a bin** for 30 days (restorable), then are purged.
- **Download everything:** one file with every profile and backup of the account, optionally
  passphrase-encrypted (scrypt + AES-GCM), and a matching import that restores it onto a
  fresh server.
- **Server snapshots:** nightly `VACUUM INTO /data/snapshots/` (7 daily + 4 weekly), plus a
  boot check that `secret.key` matches the data (a key fingerprint stored in the DB) so a lost
  or wrong key is caught loudly instead of corrupting writes. README: back up `/data`
  off-site; the VPS restic job must include `~/stack/addons/openprofiles/data`.
- **Hardening:** login rate limit per IP and per email; per-account caps (profiles 20,
  backups by retention, upload size); SSRF guard on every add-on URL fetch (no private
  addresses, 5 s, 512 KB); an activity log per account (sign-ins, switches, restores, edits)
  on the account tab; `npm audit` in CI.

### M6: easy to set up and use

*Built 2026-10-11* (migration 5: `backups.edit_kind`, `backups.undone_at`). Notes from building it:

- Pages are tabs with their own URLs: `/configure` (Profiles), `/profiles/:id` (the row plus that
  profile's editor), `/profiles/new` (the wizard, one form; app.js shows a step at a time and it
  still works without JavaScript), `/profiles/:id/addons` (manager + Cinemeta side by side),
  `/backups`, `/install`, `/account`. The first-run checklist on Profiles stays until a second
  profile exists and the add-on is installed.
- Pages name add-ons by `ref` (a hash of the link), never the link: links carry debrid keys.
  Add-by-link fetches through `core/fetchGuard.js` (checks the address actually connected to, so
  DNS can't swap in a private one; redirects re-checked), and the server holds the result 30 min
  by ref. Add-on tiles are coloured initials: the page doesn't load other sites' logos.
- Every edit goes through `ProfilesService.doEditAddons`: the profile in use edits Stremio's live
  list (backup of the whole account first, `base` fingerprint refuses a stale page); any other
  profile edits its saved copy only. Undo (24 h, newest edit first, chainable) puts back only the
  add-on list, never the library, so nothing watched since is lost.
- Cinemeta's "New" (`year`) has a required genre, so it's a Discover catalog, not a Home row; the
  switches say so. Catalogs Stremio never shows (required extras other than genre, e.g. the
  calendar ones) aren't offered for renaming.
- `ALLOW_PRIVATE_ADDONS=true` opts a home server out of the private-address check.

- **First run:** sign in, see your account become "Original", then the wizard offers your
  first new profile; the install card is part of the flow, not buried.
- **New-profile wizard:** 1 Name + picture + colour → 2 Start from (empty, copy of the account
  now, copy of another profile) → 3 Add-ons: pick from every add-on any of your profiles has,
  add by URL, drag or up/down to order → 4 Cinemeta: hide Popular / New / Featured, search,
  metadata → 5 Review → Create (and optionally switch now). Nothing touches Stremio until a
  profile is switched to (or it's the active one).
- **Edit page, in tabs:** Profiles (the big profile row stays; picking one opens its sections:
  Basics, Picture, Add-ons, Cinemeta, What's saved, Danger zone) · Backups · Install in
  Stremio · Account (sessions, activity, download everything, delete).
- **Add-on manager** (per profile): reorder, remove, add by URL, rename catalogs, health
  check. Protected add-ons (Cinemeta, Local Files) can be reordered, not removed; OpenProfiles
  itself is always kept. Editing the active profile also writes the live account (with a
  `pre_change` backup).
- **Cinemeta control** (per profile): StremShare's approach. Edit Cinemeta's manifest in the
  list: Popular (`top`) is kept with a required `search` extra while search stays on; New
  (`year`) and Featured (`imdbRating`) are removed; search strips the search extra; metadata
  drops `meta` from resources (warn if no other add-on gives metadata). Never drop
  `last-videos` / `calendar-videos`. Reset re-fetches the stock manifest (SSRF-guarded); if
  that fails, refuse rather than half-restore.

### Server tab (owner only)

*Built 2026-10-12* (migration 7: `settings`, `meta.owner_account_id`). Design: "Server tab"
board on the Phase 2 page of the design canvas. Kyle's brief: observability with the smallest
amount of useful information and nothing exposing users; every env var that isn't a security
concern editable; full control of how the server presents itself.

- **Who:** the owner is the first account ever set up (recorded at sign-in; migration 7 back-fills
  the lowest id). `ADMINS` (emails or Stremio user ids) adds more, and is the recovery path if
  the owner's account is deleted. The owner always passes the access rule. Everyone else gets a
  404 for `/admin` and its POSTs.
- **Settings** (`core/settings.js`): saved value → env var → default, read on every request.
  Saving the value it would have anyway deletes the override. Editable: `ACCESS`,
  `ALLOWED_ACCOUNTS`, `MAX_ACCOUNTS`, `LOG_LEVEL`, `OPERATOR`, `PRIVACY_NOTE`, plus new ones:
  name, accent, appearance, logo, sign-in headline and intro, GitHub links on/off,
  announcement, contact, add-on name, description and row name. Env only: `PUBLIC_URL`,
  `SECRET_KEY`, `TRUST_PROXY`, `STREMIO_API_URL`, `ALLOW_PRIVATE_ADDONS`, `PORT`, `DATA_DIR`.
- **Theming:** the CSP allows no inline styles, so the accent is `/theme.css?v=`. Buttons keep
  white labels by darkening a mid-tone accent to 4.5:1 (a light accent gets dark labels); links
  are moved toward black/white until they read on both themes. Appearance sets `data-theme` on
  `<html>`; app.css's dark tokens are guarded so either choice wins.
- **Logo:** uploaded as raw bytes by app.js, decoded by sharp (PNG/JPEG/WebP only, 2 MB) and
  redrawn as a 256 px PNG; it's the page header, favicon and the add-on's Stremio logo.
- **Add-on:** name, description and row name go into the manifest; the catalog type stays
  "OpenProfiles" (installed copies and libraries keep it).
- **Observability** (`core/stats.js`): counts only. Errors and warnings are counted by their
  fixed log message in memory (`log.problems()`), never their fields. The daily jobs store a
  count summary in `meta.last_daily_summary`.

### Profile photos

*Built 2026-10-12* (migration 8: `profiles.photo_enc`, `profiles.photo_hash`). One uploaded photo
per profile, on a fourth "Photo" tab of the picture picker (editor only; a new profile gets one
after it's created). `avatar_preset` `photo:<hash>` shows it, and only the profile's own current
hash is accepted. app.js shrinks the photo to 1024 px before uploading; `normalisePhoto` redraws
it as a 512 px JPEG. Encrypted per account (purpose `photo`). Posters draw it full-bleed under
the name band, backgrounds at half opacity, the web tile embeds it (its CSP allows `img-src
data:`). Picking another picture keeps the photo for later; "Remove the photo" deletes it.
Exports carry it; imports redraw it.

## Open questions for Kyle

- Default access rule for a self-hosted server: `owner` (first sign-in claims it) is the plan.
- Hosted instance limits: `MAX_ACCOUNTS`, and whether it needs its own add-on token domain.
