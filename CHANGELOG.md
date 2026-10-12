# Changelog

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
