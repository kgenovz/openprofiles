# OpenProfiles

Profiles for a free Stremio account. Each profile keeps its own library, Continue Watching,
add-ons and new-episode notifications. Switch from a web page, or from a **Switch profile** row
right on Stremio's Home screen.

OpenProfiles is a small server you run yourself (one Docker container). It is not made by or
affiliated with Stremio.

> **Have Stremio Supporter?** Use Stremio's own profiles instead. They work on several devices
> at the same time; OpenProfiles can't.

## How it works

Stremio keeps one library and one add-on list per account. OpenProfiles saves a copy of them for
each profile. When you switch, it:

1. saves the account as it is now into the profile you're leaving (and takes a backup),
2. writes the profile you picked into the account: library, add-ons and notifications.

Things to know:

- **Switching changes every device signed in to the account.** Everyone sees the same profile.
- **Close and reopen Stremio after switching.** That's the only refresh that works on every app.
- **Save before switching** if you finished watching something on another device. Use *Save now*
  on the profile in use, so its latest progress is kept.
- **Opening a profile in the Switch profile row switches to it.** Stremio asks for the profile's
  "stream" as soon as its page opens, and that request is the switch.

## Set up

You need a server with Docker and a domain name with https. Stremio only installs add-ons over
https.

1. Copy [`docker-compose.yml`](docker-compose.yml) and set:

   | Variable | Required | What it is |
   |---|---|---|
   | `PUBLIC_URL` | yes | The https address OpenProfiles is reached at, e.g. `https://profiles.example.com` |
   | `ADMIN_PASSWORD` | yes | Password for the settings page (8+ characters; longer is better) |
   | `LOG_LEVEL` | no | `error`, `warn`, `info` (default) or `debug` |
   | `SECRET_KEY` | no | 32-byte key (64 hex chars) instead of the generated `/data/secret.key` |
   | `PORT` | no | Port inside the container (default `7000`) |
   | `TRUST_PROXY` | no | Express trust-proxy setting (default trusts local and private networks) |

2. Put it behind a reverse proxy that handles https. With [Caddy](https://caddyserver.com):

   ```
   profiles.example.com {
       reverse_proxy 127.0.0.1:7000
   }
   ```

3. `docker compose up -d`, open `https://profiles.example.com`, sign in with `ADMIN_PASSWORD`.
4. **Connect your Stremio account** with its email and password. The password is sent to
   Stremio once to get a sign-in key and is never stored. Your account as it is now becomes the
   **Original** profile, and a permanent backup of it is kept.
5. Create profiles: an empty one (same add-ons, empty library) or a copy of the account.
6. Under **Switch from inside Stremio**, choose **Install in Stremio**.

### Back up the data volume

`/data` holds the database **and** `secret.key`. Everything stored is encrypted with that key
(add-on links often contain debrid keys, and libraries are watch history). Without the key, the
saved profiles and backups can't be read. Back up the whole volume.

## Backups and recovery

- A backup is taken automatically before every switch and restore. You can also make one
  yourself, restore any backup (with a preview first), or download it as JSON.
  Downloads contain your add-on links: keep them private.
- The backup made at setup is kept forever.
- If a switch stops partway (Stremio went down, the server restarted), the page shows
  **A switch didn't finish** with two choices: finish switching, or go back to how things were.
  Nothing else can change until you pick one.

## Import from StremShare

In StremShare, open **Tools › Backup & restore** and download a backup. In OpenProfiles, choose
the file under **Import from StremShare**. It's saved as a backup and, if you like, as a new
profile. Nothing changes in Stremio until you switch to that profile or restore the backup.
Both StremShare export formats are read (`format: "stremshare-account-backup"` v1, and the
older `schemaVersion: 1` files). A file from a different Stremio account needs an extra
confirmation.

## Profile pictures

Each profile has a colour and a picture: its first letter, one of eleven hand-drawn characters,
or a generated face. Generated faces come from [DiceBear](https://www.dicebear.com) styles that
are public domain (CC0): Lorelei, Notionists, Open Peeps, Pixel Art and Thumbs.

## Security notes

- The add-on link contains a secret token, because opening a profile in Stremio switches the
  account. Treat the link like a password. **Get a new link** on the settings page replaces it
  (and updates the copy installed in Stremio).
- The settings page uses a session cookie (`HttpOnly`, `SameSite=Strict`), CSRF tokens on every
  form, and a login rate limit.
- One server serves one Stremio account.

## Development

Needs Node 22+.

```bash
npm install
npm test          # unit and integration tests against a fake Stremio API
npm run lint
```

To try the web page without a real account, run the fake Stremio API and point OpenProfiles at
it (sign in to the fake with `kyle@example.com` / `hunter22`):

```bash
node scripts/dev-stremio.js
```

```bash
PUBLIC_URL=http://localhost:7000 ADMIN_PASSWORD=devpassword DATA_DIR=./data-dev \
  STREMIO_API_URL=http://localhost:7001 npm run dev
```

`scripts/make-clips.js` regenerates the two short clips Stremio shows after a switch, and
`scripts/render-art-preview.js` writes sample posters for a visual check.

Design notes and decisions live in [PLAN.md](PLAN.md).

## Credits

- [Figtree](https://github.com/erikdkennedy/figtree) by Erik Kennedy (SIL Open Font License),
  via Fontsource.
- [DiceBear](https://www.dicebear.com) (MIT), with CC0 styles by Lisa Wischofsky (Lorelei),
  Zoish (Notionists), Pablo Stanley (Open Peeps) and DiceBear (Pixel Art, Thumbs).

## License

[MIT](LICENSE)
