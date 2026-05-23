# Triptych Analytics Backend

Pseudonymous analytics + admin dashboard for the [Triptych](https://github.com/justinsteu/triptych) daily word puzzle. Runs on Cloudflare Workers + D1.

## One-click deploy (no Terminal needed)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/justinsteu/triptych-analytics)

Click the button. Cloudflare will:

1. Fork this repo into **your** GitHub account
2. Create the `triptych-analytics` D1 database in your Cloudflare account
3. Apply the SQL schema (creates the `plays` and `sessions` tables)
4. Ask you to enter `ADMIN_PASSWORD` — this gates your dashboard. Pick a strong one.
5. Build and deploy the Worker

When it finishes (~3 min), Cloudflare shows your live URL — something like:

```
https://triptych-analytics.YOUR-NAME.workers.dev
```

That URL **is** your admin dashboard. Open it, type your password.

## What gets collected

For every finished puzzle:

- A random `clientId` (UUID, generated client-side, stored in the device's localStorage). **Not** an email, IP, name, or fingerprint.
- Mode (`daily` / `free` / `custom`), difficulty, attempts used, win/loss, time in seconds, hints used.
- A SHA-256 hash of the first 100 chars of User-Agent (so we can spot bot waves without storing raw UAs).

For daily-active-user tracking:

- A heartbeat ping (`clientId` + today's Pacific date) when the game loads.

**No IPs. No PII.** The `clientId` is meaningless outside the player's own device.

## After your Worker is deployed

Two more things to wire it to your game:

### 1. Tell the game where to send data

Open `app.jsx` in your `triptych` repo on GitHub. Find this line near the top (~line 929):

```js
const ANALYTICS_URL = "";
```

Paste your Worker URL between the quotes:

```js
const ANALYTICS_URL = "https://triptych-analytics.YOUR-NAME.workers.dev";
```

Commit and push. Cloudflare Pages auto-redeploys the game.

### 2. (Optional) Lock CORS to your real domain

In your forked `triptych-analytics` repo, edit `wrangler.toml`:

```toml
[vars]
ALLOWED_ORIGINS = "https://triptych.pages.dev,https://YOUR-CUSTOM-DOMAIN.com"
```

Commit and push. Cloudflare Workers auto-redeploys (or you can hit "Deploy" in the dashboard).

## What the dashboard shows

- **KPI tiles**: DAU / WAU / MAU / total players / today's win rate / today's avg attempts / today's avg time / total plays
- **DAU chart** — daily active devices over the last 30 days
- **Daily outcomes chart** — plays, wins, and avg attempts per day
- **Today's attempts histogram** — distribution of how many tries today's players needed
- **Mode breakdown table** — past 7 days of plays grouped by mode/difficulty

Token is cached in your browser's localStorage for 12 hours, so you only type the password ~twice a day.

## API endpoints

Public (no auth):

- `POST /api/submit` — finished play
- `POST /api/ping` — DAU heartbeat

Admin (Bearer token from `/api/admin/login`):

- `GET /api/admin/overview`
- `GET /api/admin/dau?days=30`
- `GET /api/admin/daily?days=30`
- `GET /api/admin/attempts?date=YYYY-MM-DD`
- `GET /api/admin/modes?days=7`

## Manual deploy (Terminal users)

If you'd rather use the command line:

```bash
git clone https://github.com/justinsteu/triptych-analytics.git
cd triptych-analytics
npx wrangler login
npx wrangler d1 create triptych-analytics
# paste the printed database_id into wrangler.toml
npx wrangler d1 execute triptych-analytics --file=./schema.sql --remote
npx wrangler secret put ADMIN_PASSWORD
npx wrangler deploy
```

## Costs

Cloudflare's free tier covers:

- 100,000 Worker requests per day
- 5 GB of D1 storage
- 5 million D1 row reads per day
- 100,000 D1 row writes per day

Triptych would need ~50,000 daily players before hitting any limit.

## Privacy note for your game

Add this one-liner to your README or game footer:

> Triptych collects anonymous play stats (mode, attempts, time) tied to a random per-device ID. No personal information is collected or stored.

That's accurate.
