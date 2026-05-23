/**
 * Triptych analytics — Cloudflare Worker
 *
 * Endpoints:
 *   POST /api/submit       — receive a finished play from the game
 *   POST /api/ping         — DAU heartbeat (called once per session)
 *   POST /api/admin/login  — exchange password for a short-lived token
 *   GET  /api/admin/*      — dashboard data (token required)
 *   GET  /                 — serves the admin dashboard HTML
 *
 * All player data is pseudonymous (random clientId, no PII).
 */

const ADMIN_TOKEN_TTL_MS = 1000 * 60 * 60 * 12; // 12h
const MAX_SUBMIT_PER_MIN = 30;                  // per IP

// ──────────────────────────────────────────────────────────────────────
// helpers
// ──────────────────────────────────────────────────────────────────────
function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "Content-Type": "application/json; charset=utf-8", ...(init.headers || {}) },
  });
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  const allow = allowed.includes(origin) ? origin : allowed[0] || "*";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function pacificDateStr(d = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit",
  });
  return fmt.format(d);
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// In-memory IP rate limiter — per-isolate, fine for our scale.
const rateMap = new Map();
function rateLimit(ip, limit, windowMs) {
  const now = Date.now();
  const bucket = rateMap.get(ip) || [];
  const fresh = bucket.filter(t => now - t < windowMs);
  if (fresh.length >= limit) return false;
  fresh.push(now);
  rateMap.set(ip, fresh);
  return true;
}

// ──────────────────────────────────────────────────────────────────────
// admin token (signed, stateless)
// ──────────────────────────────────────────────────────────────────────
async function hmac(key, msg) {
  const k = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]
  );
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replaceAll("+","-").replaceAll("/","_").replaceAll("=","");
}

async function makeAdminToken(secret) {
  const exp = Date.now() + ADMIN_TOKEN_TTL_MS;
  const payload = `admin.${exp}`;
  const sig = await hmac(secret, payload);
  return `${payload}.${sig}`;
}

async function verifyAdminToken(token, secret) {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [, expStr, sig] = parts;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || Date.now() > exp) return false;
  const expected = await hmac(secret, `admin.${exp}`);
  return sig === expected;
}

// ──────────────────────────────────────────────────────────────────────
// validation
// ──────────────────────────────────────────────────────────────────────
function validSubmit(b) {
  if (!b || typeof b !== "object") return "not an object";
  if (typeof b.clientId !== "string" || !/^[0-9a-f-]{16,64}$/i.test(b.clientId)) return "bad clientId";
  if (!["daily", "free", "custom"].includes(b.mode)) return "bad mode";
  if (b.mode === "daily") {
    if (typeof b.puzzleDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(b.puzzleDate)) return "bad puzzleDate";
  }
  if (b.mode === "free" && !["beginner","normal","hard","expert"].includes(b.difficulty)) return "bad difficulty";
  if (!Number.isInteger(b.attempts) || b.attempts < 1 || b.attempts > 20) return "bad attempts";
  if (typeof b.won !== "boolean") return "bad won";
  if (!Number.isInteger(b.timeSeconds) || b.timeSeconds < 0 || b.timeSeconds > 60 * 60 * 6) return "bad timeSeconds";
  if (!Number.isInteger(b.hintsUsed) || b.hintsUsed < 0 || b.hintsUsed > 20) return "bad hintsUsed";
  if (!Number.isInteger(b.clientTs)) return "bad clientTs";
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// routes
// ──────────────────────────────────────────────────────────────────────
async function handleSubmit(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
  if (!rateLimit(`s:${ip}`, MAX_SUBMIT_PER_MIN, 60_000)) {
    return json({ error: "rate_limited" }, { status: 429 });
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: "bad_json" }, { status: 400 }); }

  const err = validSubmit(body);
  if (err) return json({ error: "validation", detail: err }, { status: 400 });

  const ua = (request.headers.get("User-Agent") || "").slice(0, 100);
  const uaHash = (await sha256Hex(ua)).slice(0, 16);

  const sql = `
    INSERT INTO plays
      (client_id, puzzle_date, mode, difficulty, attempts, won,
       time_seconds, hints_used, client_ts, app_version, ua_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(client_id, puzzle_date)
      WHERE mode = 'daily' AND puzzle_date != ''
      DO UPDATE SET
        attempts     = excluded.attempts,
        won          = excluded.won,
        time_seconds = excluded.time_seconds,
        hints_used   = excluded.hints_used,
        client_ts    = excluded.client_ts,
        app_version  = excluded.app_version
  `;
  await env.DB.prepare(sql).bind(
    body.clientId,
    body.mode === "daily" ? body.puzzleDate : "",
    body.mode,
    body.difficulty || null,
    body.attempts,
    body.won ? 1 : 0,
    body.timeSeconds,
    body.hintsUsed,
    body.clientTs,
    body.appVersion || null,
    uaHash,
  ).run();

  return json({ ok: true });
}

async function handlePing(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
  if (!rateLimit(`p:${ip}`, 60, 60_000)) return json({ error: "rate_limited" }, { status: 429 });

  let body;
  try { body = await request.json(); } catch { return json({ error: "bad_json" }, { status: 400 }); }
  if (typeof body?.clientId !== "string" || !/^[0-9a-f-]{16,64}$/i.test(body.clientId)) {
    return json({ error: "bad_clientId" }, { status: 400 });
  }

  const day = pacificDateStr();
  const now = Date.now();
  await env.DB.prepare(`
    INSERT INTO sessions (client_id, day_pacific, first_ts, last_ts)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(client_id, day_pacific) DO UPDATE SET last_ts = excluded.last_ts
  `).bind(body.clientId, day, now, now).run();

  return json({ ok: true });
}

async function handleLogin(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
  if (!rateLimit(`l:${ip}`, 10, 60_000)) return json({ error: "rate_limited" }, { status: 429 });

  let body;
  try { body = await request.json(); } catch { return json({ error: "bad_json" }, { status: 400 }); }

  const pass = body?.password;
  if (typeof pass !== "string" || !env.ADMIN_PASSWORD) {
    return json({ error: "unauthorized" }, { status: 401 });
  }
  // constant-time compare
  const a = await sha256Hex(pass);
  const b = await sha256Hex(env.ADMIN_PASSWORD);
  if (a !== b) return json({ error: "unauthorized" }, { status: 401 });

  const token = await makeAdminToken(env.ADMIN_PASSWORD);
  return json({ token, expiresAt: Date.now() + ADMIN_TOKEN_TTL_MS });
}

async function requireAdmin(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const ok = await verifyAdminToken(token, env.ADMIN_PASSWORD || "");
  return ok;
}

// ──────────────────────────────────────────────────────────────────────
// admin queries
// ──────────────────────────────────────────────────────────────────────
async function statsOverview(env) {
  const today = pacificDateStr();
  const oneDayAgo  = Date.now() - 86_400_000;
  const oneWeekAgo = Date.now() - 7 * 86_400_000;
  const oneMonthAgo = Date.now() - 30 * 86_400_000;

  const [dau, wau, mau, totalPlayers, totalPlays, dailiesToday] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(DISTINCT client_id) AS n FROM sessions WHERE last_ts >= ?`).bind(oneDayAgo).first(),
    env.DB.prepare(`SELECT COUNT(DISTINCT client_id) AS n FROM sessions WHERE last_ts >= ?`).bind(oneWeekAgo).first(),
    env.DB.prepare(`SELECT COUNT(DISTINCT client_id) AS n FROM sessions WHERE last_ts >= ?`).bind(oneMonthAgo).first(),
    env.DB.prepare(`SELECT COUNT(DISTINCT client_id) AS n FROM sessions`).first(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM plays`).first(),
    env.DB.prepare(`SELECT COUNT(*) AS n, SUM(won) AS w, AVG(attempts) AS a, AVG(time_seconds) AS t
                    FROM plays WHERE mode='daily' AND puzzle_date = ?`).bind(today).first(),
  ]);

  return {
    today,
    dau: dau?.n || 0,
    wau: wau?.n || 0,
    mau: mau?.n || 0,
    totalPlayers: totalPlayers?.n || 0,
    totalPlays: totalPlays?.n || 0,
    dailyToday: {
      plays: dailiesToday?.n || 0,
      wins: dailiesToday?.w || 0,
      winRate: dailiesToday?.n ? (dailiesToday.w / dailiesToday.n) : 0,
      avgAttempts: dailiesToday?.a || 0,
      avgTimeSeconds: dailiesToday?.t || 0,
    },
  };
}

async function statsDailyTimeseries(env, days = 30) {
  const rows = await env.DB.prepare(`
    SELECT puzzle_date            AS date,
           COUNT(*)                AS plays,
           SUM(won)                AS wins,
           AVG(attempts)           AS avg_attempts,
           AVG(time_seconds)       AS avg_time,
           COUNT(DISTINCT client_id) AS unique_players
    FROM plays
    WHERE mode='daily'
      AND puzzle_date >= date('now','-${days} days')
    GROUP BY puzzle_date
    ORDER BY puzzle_date ASC
  `).all();
  return (rows.results || []).map(r => ({
    date: r.date,
    plays: r.plays,
    wins: r.wins,
    winRate: r.plays ? r.wins / r.plays : 0,
    avgAttempts: r.avg_attempts,
    avgTimeSeconds: r.avg_time,
    uniquePlayers: r.unique_players,
  }));
}

async function statsDauTimeseries(env, days = 30) {
  const rows = await env.DB.prepare(`
    SELECT day_pacific AS date,
           COUNT(DISTINCT client_id) AS dau
    FROM sessions
    WHERE day_pacific >= date('now','-${days} days')
    GROUP BY day_pacific
    ORDER BY day_pacific ASC
  `).all();
  return rows.results || [];
}

async function statsAttemptsHistogram(env, puzzleDate) {
  const date = puzzleDate || pacificDateStr();
  const rows = await env.DB.prepare(`
    SELECT attempts, won, COUNT(*) AS n
    FROM plays
    WHERE mode='daily' AND puzzle_date = ?
    GROUP BY attempts, won
    ORDER BY attempts ASC
  `).bind(date).all();
  return { date, buckets: rows.results || [] };
}

async function statsModeBreakdown(env, days = 7) {
  const rows = await env.DB.prepare(`
    SELECT mode, difficulty,
           COUNT(*) AS plays,
           SUM(won) AS wins,
           AVG(attempts) AS avg_attempts
    FROM plays
    WHERE server_ts >= ?
    GROUP BY mode, difficulty
    ORDER BY plays DESC
  `).bind(Date.now() - days * 86_400_000).all();
  return rows.results || [];
}

// ──────────────────────────────────────────────────────────────────────
// admin dashboard HTML (served at root)
// ──────────────────────────────────────────────────────────────────────
// Bundled at build time via Wrangler's text-module rule (see wrangler.toml)
import dashboardHtml from "../admin/index.html";

// ──────────────────────────────────────────────────────────────────────
// router
// ──────────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      // public
      if (url.pathname === "/api/submit" && request.method === "POST") {
        const r = await handleSubmit(request, env);
        return new Response(r.body, { status: r.status, headers: { ...r.headers, ...cors } });
      }
      if (url.pathname === "/api/ping" && request.method === "POST") {
        const r = await handlePing(request, env);
        return new Response(r.body, { status: r.status, headers: { ...r.headers, ...cors } });
      }
      if (url.pathname === "/api/admin/login" && request.method === "POST") {
        return await handleLogin(request, env);
      }

      // admin (auth required)
      if (url.pathname.startsWith("/api/admin/")) {
        if (!(await requireAdmin(request, env))) {
          return json({ error: "unauthorized" }, { status: 401 });
        }
        if (url.pathname === "/api/admin/overview")           return json(await statsOverview(env));
        if (url.pathname === "/api/admin/daily")              return json(await statsDailyTimeseries(env, Number(url.searchParams.get("days")) || 30));
        if (url.pathname === "/api/admin/dau")                return json(await statsDauTimeseries(env, Number(url.searchParams.get("days")) || 30));
        if (url.pathname === "/api/admin/attempts")           return json(await statsAttemptsHistogram(env, url.searchParams.get("date")));
        if (url.pathname === "/api/admin/modes")              return json(await statsModeBreakdown(env, Number(url.searchParams.get("days")) || 7));
        return json({ error: "not_found" }, { status: 404 });
      }

      // dashboard HTML
      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(dashboardHtml, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      return json({ error: "not_found" }, { status: 404 });
    } catch (e) {
      return json({ error: "server_error", message: String(e?.message || e) }, { status: 500 });
    }
  },
};
