# Triptych Analytics Backend

Cloudflare Worker + D1 database that collects pseudonymous play stats from the Triptych game and serves a password-protected admin dashboard.

## What gets collected

For every finished puzzle:

- A random `clientId` (UUID, generated client-side, stored in the device's localStorage). **Not** an email, IP, name, or fingerprint.
- Mode (`daily` / `free` / `custom`), difficulty, attempts used, win/loss, time in seconds, hints used.
- A SHA-256 hash of the first 100 chars of User-Agent (so we can spot bot waves without storing raw UAs).

For DAU tracking:

- A heartbeat ping (`clientId` + today's Pacific date) when the game loads.

No IPs are stored. No PII is stored. The `clientId` is meaningless outside the player's own device.

## Architecture

```
 ┌──────────────┐    POST /api/submit, /api/ping     ┌─────────────────────┐
 │  Triptych    │ ─────────────────────────────────▶ │ Cloudflare Worker   │
 │  game (PWA)  │                                    │ + D1 database       │
 └──────────────┘                                    │                     │
                                                     │ GET / (dashboard)   │
 ┌──────────────┐    password → token → fetch        │ GET /api/admin/*    │
 │  You (admin) │ ─────────────────────────────────▶ │                     │
 └──────────────┘                                    └─────────────────────┘
```

One Worker handles both the game's analytics submissions and the admin dashboard. The dashboard HTML is bundled into the Worker.

## One-time setup

### Prerequisites

- A Cloudflare account (free tier is fine)
- Node 18+ installed locally
- `npm install -g wrangler` (Cloudflare's CLI)

### 1. Authenticate

```bash
wrangler login
```

This opens a browser window. Sign into Cloudflare and authorize.

### 2. Create the D1 database

```bash
cd triptych-backend
wrangler d1 create triptych-analytics
```

The CLI prints something like:

```
✅ Successfully created DB 'triptych-analytics'
[[d1_databases]]
binding = "DB"
database_name = "triptych-analytics"
database_id = "abc12345-6789-..."
```

**Copy the `database_id`** and paste it into `wrangler.toml`, replacing `REPLACE_WITH_D1_DATABASE_ID`.

### 3. Apply the schema

```bash
wrangler d1 execute triptych-analytics --file=./schema.sql --remote
```

(The `--remote` flag runs it against the real database, not a local emulator.)

### 4. Set the admin password

Pick something strong — this gates your dashboard.

```bash
wrangler secret put ADMIN_PASSWORD
```

You'll be prompted to type the password (it's hidden). Don't commit this anywhere.

### 5. Deploy the Worker

```bash
wrangler deploy
```

Wrangler prints your Worker URL — something like:

```
Published triptych-analytics
  https://triptych-analytics.YOUR-SUBDOMAIN.workers.dev
```

**Copy this URL.** You'll need it in two places:

1. **The game's `app.jsx`** — set `ANALYTICS_URL` near the top of the file:
   ```js
   const ANALYTICS_URL = "https://triptych-analytics.YOUR-SUBDOMAIN.workers.dev";
   ```
   Then redeploy the game (`git push`).

2. **Your bookmarks** — `https://triptych-analytics.YOUR-SUBDOMAIN.workers.dev/` is your admin dashboard. Open it, type your password.

### 6. (Optional) Lock down CORS

Edit `wrangler.toml`'s `ALLOWED_ORIGINS` to list only your real domain(s):

```toml
[vars]
ALLOWED_ORIGINS = "https://triptych.pages.dev,https://triptych.game"
```

Then redeploy:

```bash
wrangler deploy
```

## Daily use

- Visit `https://triptych-analytics.YOUR-SUBDOMAIN.workers.dev/`
- Type password
- Token is cached in localStorage for 12 hours
- Hit **Refresh** anytime to pull the latest data

## What the dashboard shows

- **KPI tiles**: DAU / WAU / MAU / total players / today's win rate / today's avg attempts / today's avg time / total plays
- **DAU chart** — daily active devices over the last 30 days
- **Daily outcomes chart** — plays + wins + avg attempts per day
- **Today's attempts histogram** — distribution of how many tries today's players needed
- **Mode breakdown table** — past 7 days of plays grouped by mode/difficulty

## Updating the Worker

Edit files, then:

```bash
wrangler deploy
```

That's it — re-running `deploy` overwrites the previous version. Secrets and the D1 database persist.

## Schema changes

Add a column? Edit `schema.sql` (write a new `ALTER TABLE` statement) then:

```bash
wrangler d1 execute triptych-analytics --remote --command "ALTER TABLE plays ADD COLUMN your_new_col TEXT"
```

## Costs

Free tier covers:
- 100,000 Worker requests per day
- 5 GB of D1 storage
- 5 million D1 row reads per day
- 100,000 D1 row writes per day

Triptych would need ~50,000 daily players before hitting any limit.

## Privacy notes for your site

If you publish this game with telemetry enabled, add a one-line privacy note to your README or footer:

> Triptych collects anonymous play stats (mode, attempts, time) tied to a random per-device ID. No personal information is collected or stored.

That's true and accurate.
