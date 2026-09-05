import cors from "cors";
import express from "express";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createPublicClient, decodeEventLog, http, type Hex } from "viem";
import { base } from "viem/chains";
import { parseSiweMessage } from "viem/siwe";

// viem PublicClient verifies SIWE for ALL signature types (EOA, ERC-1271, EIP-6492).
// Base Smart Wallet uses ERC-1271/EIP-6492 — siwe@3 alone can't validate it.
// RPC_URL should point at a dedicated provider: every login is an eth_call and
// the default public endpoint rate-limits under real traffic.
const rpcUrl = process.env.RPC_URL ?? process.env.BASE_RPC_URL;
const verifyClient = createPublicClient({ chain: base, transport: http(rpcUrl) });

type WalletMode = "Smart Wallet" | "Standard Wallet";

type Session = {
  address: string;
  createdAt: number;
  mode: WalletMode;
  lastSeenAt?: number;
};

type StreakRecord = {
  address: string;
  lastCheckInAt: number;
  streak: number;
};

type NotificationResult = {
  failedCount: number;
  sentCount: number;
};

const app = express();
const port = Number(process.env.PORT ?? 4000);
const frontendOrigin = process.env.FRONTEND_ORIGIN;
const defaultFrontendOrigin = "https://base-snake.app";
const publicFrontendOrigin = frontendOrigin ? normalizeOrigin(frontendOrigin) : defaultFrontendOrigin;
const databaseUrl = process.env.DATABASE_URL;
const baseAppUrl = process.env.BASE_APP_URL ?? publicFrontendOrigin;
const baseNotificationsApiKey = process.env.BASE_API_KEY ?? process.env.BASE_NOTIFICATIONS_API_KEY;
// Supports either ADMIN_ADDRESSES (comma-separated list) or single
// ADMIN_WALLET_ADDRESS for backwards compatibility.
const adminAddresses = new Set<string>(
  [
    ...(process.env.ADMIN_ADDRESSES ?? "").split(","),
    process.env.ADMIN_WALLET_ADDRESS ?? ""
  ]
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);
const nonces = new Map<string, number>();
const sessions = new Map<string, Session>();
const streaks = new Map<string, StreakRecord>();
// The arcade contract is where a run becomes real: a score only reaches the
// database if a transaction to this address recorded it. Without the address
// configured the run endpoints answer 503 rather than trusting the client.
const arcadeAddress = (process.env.ARCADE_CONTRACT_ADDRESS ?? "").trim().toLowerCase();

type GameMode = "classic" | "levels";

type RunRow = {
  address: string;
  mode: GameMode;
  level: number;
  score: number;
  cells: number;
  moves: number;
  won: boolean;
  txHash: string;
};

// In-memory stand-ins, used exactly like the streak maps when DATABASE_URL is
// unset: enough to develop against, lost on restart.
const memoryRuns = new Map<string, RunRow>();
const memoryBests = new Map<string, RunRow>();
const memoryReviveUsage = new Map<string, number>();

// Only what the backend actually reads. The full ABI lives in the frontend.
const arcadeAbi = [
  {
    type: "event",
    name: "RunRecorded",
    inputs: [
      { name: "player", type: "address", indexed: true },
      { name: "mode", type: "uint8", indexed: true },
      { name: "level", type: "uint16", indexed: true },
      { name: "runId", type: "uint256", indexed: false },
      { name: "score", type: "uint256", indexed: false },
      { name: "cells", type: "uint16", indexed: false },
      { name: "moves", type: "uint32", indexed: false },
      { name: "won", type: "bool", indexed: false },
      { name: "personalBest", type: "bool", indexed: false },
      { name: "paid", type: "uint256", indexed: false },
      { name: "recordedAt", type: "uint256", indexed: false }
    ]
  },
  {
    type: "function",
    name: "revivesPurchased",
    stateMutability: "view",
    inputs: [{ name: "player", type: "address" }],
    outputs: [{ name: "", type: "uint256" }]
  }
] as const;
const pool = databaseUrl
  ? new Pool({
      connectionString: databaseUrl,
      ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined
    })
  : null;
const sessionCookieName = "sneak_session";
// Sessions used to live forever: no TTL in the DB, a 400 day cookie and no
// cleanup. A token lifted out of localStorage stayed valid indefinitely.
// 60 days of inactivity, with the cookie lifetime matching so both agree.
const sessionMaxAgeSeconds = 60 * 60 * 24 * 60;
const sessionIdleTtlMs = sessionMaxAgeSeconds * 1000;
const nonceMaxAgeMs = 10 * 60 * 1000;
// Hard cap: without it a flood of unauthenticated /api/auth/nonce calls grows
// the map until the instance runs out of memory.
const nonceMaxEntries = 20_000;
const checkInIntervalMs = 24 * 60 * 60 * 1000;
const checkInGraceMs = 12 * 60 * 60 * 1000;
const externalFetchTimeoutMs = 10_000;
const notificationTexts = [
  "Your Snake streak is waiting.",
  "One clean run can beat your record.",
  "The board is ready. Keep the streak alive.",
  "Snake check-in is open.",
  "Base snake is calling you back.",
  "Don't break the chain — check in now.",
  "A new run is waiting for you.",
  "Your streak won't last forever. Check in.",
  "Time to slither. Check in today.",
  "Keep it going — your streak is on the line."
];

// Comma-separated extra origins (preview deploys, a second domain). They join
// the CORS allowlist, the CSRF check and the set of hosts SIWE will accept.
const additionalOrigins = (process.env.ADDITIONAL_ORIGINS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean)
  .map(normalizeOrigin);

function getAllowedOrigins() {
  const origins = new Set([publicFrontendOrigin, defaultFrontendOrigin, ...additionalOrigins]);

  if (process.env.NODE_ENV !== "production") {
    origins.add("http://localhost:5173");
    origins.add("http://127.0.0.1:5173");
  }

  return Array.from(origins);
}

const allowedOrigins = getAllowedOrigins();
// A SIWE message carries a host (RFC 4361 `domain`), a request carries an
// origin. Same allowlist, two views of it.
const allowedHosts = new Set(
  allowedOrigins.map(getHostFromOrigin).filter((host): host is string => Boolean(host))
);

function normalizeOrigin(value: string) {
  return value.startsWith("http") ? value : `https://${value}`;
}

function getHostFromOrigin(value: string) {
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}

// Express 4 does not await route handlers, so a rejected promise becomes an
// unhandledRejection and Node kills the process. Every async route goes
// through here.
function asyncRoute(
  handler: (req: express.Request, res: express.Response) => Promise<unknown>
): express.RequestHandler {
  return (req, res, next) => {
    handler(req, res).catch(next);
  };
}

function getClientIp(req: express.Request) {
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

type RateLimitBucket = {
  count: number;
  resetAt: number;
};

// Fixed-window limiter kept in memory. Single instance today; if the service
// ever scales out, move these buckets to Redis.
function createRateLimiter(name: string, limit: number, windowMs: number) {
  const buckets = new Map<string, RateLimitBucket>();

  return function consume(key: string) {
    const now = Date.now();
    const bucketKey = `${name}:${key}`;
    const bucket = buckets.get(bucketKey);

    if (!bucket || now >= bucket.resetAt) {
      buckets.set(bucketKey, { count: 1, resetAt: now + windowMs });

      if (buckets.size > 50_000) {
        buckets.forEach((value, mapKey) => {
          if (now >= value.resetAt) {
            buckets.delete(mapKey);
          }
        });
      }

      return { allowed: true, retryAfterSeconds: 0 };
    }

    bucket.count += 1;

    if (bucket.count > limit) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
      };
    }

    return { allowed: true, retryAfterSeconds: 0 };
  };
}

const limitByIp = (name: string, limit: number, windowMs: number) => {
  const consume = createRateLimiter(name, limit, windowMs);

  return function middleware(req: express.Request, res: express.Response, next: express.NextFunction) {
    const result = consume(getClientIp(req));

    if (!result.allowed) {
      res.setHeader("Retry-After", String(result.retryAfterSeconds));
      res.status(429).json({ error: "Too many requests. Slow down." });
      return;
    }

    next();
  };
};

// CORS only decides whether a browser lets a page read the response — the
// request still runs. For state-changing routes we check the origin ourselves
// so a cross-site form post can't act on a session cookie.
function hasAllowedOrigin(req: express.Request) {
  const origin = req.headers.origin;

  if (origin) {
    return allowedOrigins.includes(origin);
  }

  const referer = req.headers.referer;

  if (referer) {
    try {
      return allowedOrigins.includes(new URL(referer).origin);
    } catch {
      return false;
    }
  }

  // No Origin and no Referer: not a browser-initiated cross-site request.
  // Bearer-authenticated clients (Base App webview) land here.
  return true;
}

function requireAllowedOrigin(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  if (!hasAllowedOrigin(req)) {
    res.status(403).json({ error: "Origin not allowed." });
    return;
  }

  next();
}

async function fetchWithTimeout(
  input: string | URL,
  init: RequestInit = {},
  timeoutMs = externalFetchTimeoutMs
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function createNonce() {
  return randomUUID().replace(/-/g, "");
}

function parseCookies(cookieHeader: string | undefined) {
  const cookies = new Map<string, string>();

  if (!cookieHeader) {
    return cookies;
  }

  cookieHeader.split(";").forEach((cookie) => {
    const [rawName, ...rawValue] = cookie.trim().split("=");

    if (rawName && rawValue.length > 0) {
      cookies.set(rawName, decodeURIComponent(rawValue.join("=")));
    }
  });

  return cookies;
}

function getSessionToken(cookieHeader: string | undefined) {
  return parseCookies(cookieHeader).get(sessionCookieName);
}

// Authorization: Bearer <token> takes priority over cookie because in-app
// browsers (Base App webview, iOS Safari) often block third-party cookies.
function getAuthToken(req: express.Request): string | undefined {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith("Bearer ")) {
    return auth.slice(7);
  }
  return getSessionToken(req.headers.cookie);
}

function makeSessionCookie(token: string) {
  const secure = process.env.NODE_ENV === "production";
  const sameSite = secure ? "None" : "Lax";
  const parts = [
    `${sessionCookieName}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    `SameSite=${sameSite}`,
    `Max-Age=${sessionMaxAgeSeconds}`
  ];

  if (secure) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

function makeClearSessionCookie() {
  return `${sessionCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function cleanupNonces() {
  const now = Date.now();

  nonces.forEach((createdAt, nonce) => {
    if (now - createdAt > nonceMaxAgeMs) {
      nonces.delete(nonce);
    }
  });

  // Still above the cap after dropping expired entries — evict oldest first.
  if (nonces.size > nonceMaxEntries) {
    const oldestFirst = Array.from(nonces.entries()).sort((a, b) => a[1] - b[1]);
    const excess = nonces.size - nonceMaxEntries;

    for (let index = 0; index < excess; index += 1) {
      nonces.delete(oldestFirst[index][0]);
    }
  }
}

async function ensureSessionStore() {
  if (!pool) {
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token TEXT PRIMARY KEY,
      address TEXT NOT NULL,
      mode TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS check_in_streaks (
      address TEXT PRIMARY KEY,
      streak INTEGER NOT NULL,
      last_check_in_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // One row per run that made it onchain. tx_hash is unique, so replaying the
  // same transaction can never double-count a score.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS runs (
      id BIGSERIAL PRIMARY KEY,
      tx_hash TEXT NOT NULL UNIQUE,
      address TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('classic', 'levels')),
      level SMALLINT NOT NULL,
      score BIGINT NOT NULL,
      cells INTEGER NOT NULL,
      moves INTEGER NOT NULL,
      won BOOLEAN NOT NULL,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query("CREATE INDEX IF NOT EXISTS runs_player_idx ON runs (address, mode, level)");

  // Best per board, and a board is (mode, level) — classic always sits at
  // level 0, so the two modes can never overwrite each other.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS player_bests (
      address TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('classic', 'levels')),
      level SMALLINT NOT NULL,
      score BIGINT NOT NULL,
      cells INTEGER NOT NULL,
      moves INTEGER NOT NULL,
      tx_hash TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (address, mode, level)
    )
  `);

  // Purchases are counted onchain; this table is the other half of the sum —
  // one row per revive actually spent.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS revive_usage (
      id BIGSERIAL PRIMARY KEY,
      address TEXT NOT NULL,
      used_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query("CREATE INDEX IF NOT EXISTS revive_usage_address_idx ON revive_usage (address)");

  // Superseded by `runs`: it only ever stored an address and was never read.
  await pool.query("DROP TABLE IF EXISTS recorded_runs");
}

async function getSession(token: string): Promise<Session | undefined> {
  const now = Date.now();

  if (!pool) {
    const session = sessions.get(token);

    if (!session) {
      return undefined;
    }

    if (now - (session.lastSeenAt ?? session.createdAt) > sessionIdleTtlMs) {
      sessions.delete(token);
      return undefined;
    }

    session.lastSeenAt = now;
    return session;
  }

  const result = await pool.query<{
    address: string;
    created_at: Date;
    mode: WalletMode;
  }>(
    `SELECT address, created_at, mode
       FROM auth_sessions
      WHERE token = $1
        AND last_seen_at > NOW() - make_interval(secs => $2)`,
    [token, sessionMaxAgeSeconds]
  );
  const row = result.rows[0];

  if (!row) {
    return undefined;
  }

  await pool.query("UPDATE auth_sessions SET last_seen_at = NOW() WHERE token = $1", [token]);

  return {
    address: row.address,
    createdAt: row.created_at.getTime(),
    mode: row.mode
  };
}

// Expired rows would otherwise pile up forever: nothing ever deleted them.
async function cleanupExpiredSessions() {
  const now = Date.now();

  if (!pool) {
    sessions.forEach((session, token) => {
      if (now - (session.lastSeenAt ?? session.createdAt) > sessionIdleTtlMs) {
        sessions.delete(token);
      }
    });
    return;
  }

  await pool.query("DELETE FROM auth_sessions WHERE last_seen_at < NOW() - make_interval(secs => $1)", [
    sessionMaxAgeSeconds
  ]);
}

async function saveSession(token: string, session: Session) {
  if (!pool) {
    sessions.set(token, session);
    return;
  }

  await pool.query(
    `
      INSERT INTO auth_sessions (token, address, mode)
      VALUES ($1, $2, $3)
      ON CONFLICT (token)
      DO UPDATE SET address = EXCLUDED.address, mode = EXCLUDED.mode, last_seen_at = NOW()
    `,
    [token, session.address, session.mode]
  );
}

async function deleteSession(token: string) {
  if (!pool) {
    sessions.delete(token);
    return;
  }

  await pool.query("DELETE FROM auth_sessions WHERE token = $1", [token]);
}

async function getRequestSession(req: express.Request) {
  const token = getAuthToken(req);
  const session = token ? await getSession(token) : undefined;

  return { session, token };
}

async function getStreak(address: string) {
  const key = address.toLowerCase();

  if (!pool) {
    return streaks.get(key);
  }

  const result = await pool.query<{
    address: string;
    last_check_in_at: Date;
    streak: number;
  }>("SELECT address, last_check_in_at, streak FROM check_in_streaks WHERE address = $1", [key]);
  const row = result.rows[0];

  if (!row) {
    return undefined;
  }

  return {
    address: row.address,
    lastCheckInAt: row.last_check_in_at.getTime(),
    streak: row.streak
  };
}

async function saveStreak(record: StreakRecord) {
  const key = record.address.toLowerCase();

  if (!pool) {
    streaks.set(key, { ...record, address: key });
    return;
  }

  await pool.query(
    `
      INSERT INTO check_in_streaks (address, streak, last_check_in_at)
      VALUES ($1, $2, to_timestamp($3 / 1000.0))
      ON CONFLICT (address)
      DO UPDATE SET
        streak = EXCLUDED.streak,
        last_check_in_at = EXCLUDED.last_check_in_at,
        updated_at = NOW()
    `,
    [key, record.streak, record.lastCheckInAt]
  );
}

function makeStreakStatus(record: StreakRecord | undefined, checkedInToday = false, isAdmin = false) {
  if (!record) {
    return {
      authenticated: true,
      canCheckIn: true,
      checkedInToday,
      expiresAt: null,
      isAdmin,
      nextCheckInAt: null,
      streak: 0
    };
  }

  const nextCheckInAt = record.lastCheckInAt + checkInIntervalMs;
  const expiresAt = nextCheckInAt + checkInGraceMs;
  const now = Date.now();
  const activeStreak = now <= expiresAt ? record.streak : 0;

  return {
    authenticated: true,
    canCheckIn: now >= nextCheckInAt,
    checkedInToday,
    expiresAt: new Date(expiresAt).toISOString(),
    isAdmin,
    nextCheckInAt: new Date(nextCheckInAt).toISOString(),
    streak: activeStreak
  };
}

function isAdminAddress(address: string | undefined) {
  if (!address || adminAddresses.size === 0) return false;
  return adminAddresses.has(address.toLowerCase());
}

function applyCheckIn(record: StreakRecord | undefined, address: string) {
  const now = Date.now();
  const key = address.toLowerCase();

  if (!record) {
    return { address: key, lastCheckInAt: now, streak: 1 };
  }

  const nextCheckInAt = record.lastCheckInAt + checkInIntervalMs;
  const expiresAt = nextCheckInAt + checkInGraceMs;

  if (now < nextCheckInAt) {
    return record;
  }

  return {
    address: key,
    lastCheckInAt: now,
    streak: now <= expiresAt ? record.streak + 1 : 1
  };
}

async function sendBaseNotification(
  walletAddresses: string[],
  title: string,
  message: string,
  targetPath = "/"
): Promise<NotificationResult> {
  if (!baseNotificationsApiKey || !baseAppUrl) {
    return { failedCount: walletAddresses.length, sentCount: 0 };
  }

  const response = await fetchWithTimeout("https://dashboard.base.org/api/v1/notifications/send", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": baseNotificationsApiKey
    },
    body: JSON.stringify({
      app_url: baseAppUrl,
      message,
      target_path: targetPath,
      title,
      wallet_addresses: walletAddresses
    })
  });

  const data = (await response.json().catch(() => null)) as {
    sentCount?: number;
    failedCount?: number;
    results?: Array<{ sent: boolean; failureReason?: string }>;
  } | null;

  if (!response.ok || !data) {
    console.error("Base notify error", response.status, data);
    return { failedCount: walletAddresses.length, sentCount: 0 };
  }

  // Log first failure reason for debugging
  const firstFailure = data.results?.find((r) => !r.sent && r.failureReason);
  if (firstFailure) {
    console.warn("Base notify partial failure:", firstFailure.failureReason);
  }

  return {
    failedCount: data.failedCount ?? 0,
    sentCount: data.sentCount ?? 0
  };
}

async function getNotificationAudience() {
  if (!baseNotificationsApiKey || !baseAppUrl) {
    return [];
  }

  const addresses: string[] = [];
  let cursor: string | undefined;

  do {
    const url = new URL("https://dashboard.base.org/api/v1/notifications/app/users");
    url.searchParams.set("app_url", baseAppUrl);
    url.searchParams.set("notification_enabled", "true");
    url.searchParams.set("limit", "100");

    if (cursor) {
      url.searchParams.set("cursor", cursor);
    }

    const response = await fetchWithTimeout(url, {
      headers: {
        "x-api-key": baseNotificationsApiKey
      }
    });
    const data = (await response.json().catch(() => null)) as
      | { nextCursor?: string; users?: Array<{ address?: string }> }
      | null;

    if (!response.ok || !data?.users) {
      break;
    }

    data.users.forEach((user) => {
      if (user.address) {
        addresses.push(user.address);
      }
    });
    cursor = data.nextCursor;
  } while (cursor && addresses.length < 1000);

  return addresses.slice(0, 1000);
}

void ensureSessionStore().catch((error) => {
  console.error("Failed to initialize session store", error);
});

// Render terminates TLS in front of the app, so without this every request
// looks like it comes from the proxy and the rate limiters share one bucket.
app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

app.use(
  cors({
    credentials: true,
    origin: allowedOrigins
  })
);
app.use(express.json({ limit: "32kb" }));

// Deliberately loose. Mobile carriers put many players behind one address, so
// these are sized to stop floods and memory growth, not to police normal play.
const nonceLimiter = limitByIp("nonce", 120, 10 * 60 * 1000);
const verifyLimiter = limitByIp("verify", 60, 10 * 60 * 1000);
const readLimiter = limitByIp("read", 600, 5 * 60 * 1000);
const writeLimiter = limitByIp("write", 300, 60 * 60 * 1000);
const notifyLimiter = limitByIp("notify", 20, 60 * 60 * 1000);

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// Diagnostic endpoint — confirms the backend picked up admin config at all.
// It used to return the last 6 chars of every admin address; combined with the
// project's onchain history that was enough to pin down the admin wallet, so
// now it only reports whether config arrived and whether *you* are an admin.
app.get(
  "/api/admin/whoami",
  readLimiter,
  asyncRoute(async (req, res) => {
    const { session } = await getRequestSession(req);

    res.json({
      adminConfigured: adminAddresses.size > 0,
      authenticated: Boolean(session),
      isAdmin: isAdminAddress(session?.address)
    });
  })
);

app.get("/api/auth/nonce", nonceLimiter, (_req, res) => {
  cleanupNonces();

  const nonce = createNonce();
  nonces.set(nonce, Date.now());
  res.json({ nonce });
});

app.get(
  "/api/auth/me",
  readLimiter,
  asyncRoute(async (req, res) => {
    const token = getAuthToken(req);
    const session = token ? await getSession(token) : undefined;

    if (!token || !session) {
      res.status(401).json({ authenticated: false });
      return;
    }

    res.setHeader("Set-Cookie", makeSessionCookie(token));
    res.json({
      authenticated: true,
      address: session.address,
      mode: session.mode,
      isAdmin: isAdminAddress(session.address)
    });
  })
);

app.post(
  "/api/auth/logout",
  writeLimiter,
  asyncRoute(async (req, res) => {
    const token = getAuthToken(req);

    if (token) {
      await deleteSession(token);
    }

    res.setHeader("Set-Cookie", makeClearSessionCookie());
    res.json({ ok: true });
  })
);

app.post(
  "/api/auth/verify",
  verifyLimiter,
  asyncRoute(async (req, res) => {
    const { message, mode, signature } = req.body as {
      message?: unknown;
      mode?: unknown;
      signature?: unknown;
    };

    if (typeof message !== "string" || typeof signature !== "string") {
      res.status(400).json({ error: "Invalid SIWE payload." });
      return;
    }

    const walletMode: WalletMode = mode === "Smart Wallet" ? "Smart Wallet" : "Standard Wallet";
    // viem's parser returns a partial object instead of throwing. siwe@3's
    // constructor threw on malformed input, and an uncaught throw in an async
    // express handler takes the whole process down.
    const siweMessage = parseSiweMessage(message);
    const nonce = siweMessage.nonce;
    const messageDomain = siweMessage.domain?.toLowerCase();

    if (!nonce || !siweMessage.address || !messageDomain) {
      res.status(400).json({ error: "Invalid SIWE payload." });
      return;
    }

    // Without this check any signature the user produced on another site is
    // accepted here, as long as it carries a nonce issued by us: viem only
    // compares the domain when one is passed in.
    if (!allowedHosts.has(messageDomain)) {
      res.status(401).json({ error: "Sign-in domain is not allowed." });
      return;
    }

    const nonceCreatedAt = nonces.get(nonce);

    if (!nonceCreatedAt || Date.now() - nonceCreatedAt > nonceMaxAgeMs) {
      nonces.delete(nonce);
      res.status(400).json({ error: "Invalid or expired nonce." });
      return;
    }

    // viem.verifySiweMessage handles EOA, ERC-1271 (smart contract wallet),
    // and EIP-6492 (counterfactually-deployed Smart Wallet) signatures.
    let valid = false;
    try {
      valid = await verifyClient.verifySiweMessage({
        message,
        signature: signature as `0x${string}`,
        domain: siweMessage.domain,
        nonce
      });
    } catch (err) {
      console.error("SIWE verification error", err);
    }

    if (!valid) {
      res.status(401).json({ error: "Invalid wallet signature." });
      return;
    }

    nonces.delete(nonce);

    const token = randomUUID();
    const session: Session = {
      address: siweMessage.address,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      mode: walletMode
    };

    await saveSession(token, session);
    res.setHeader("Set-Cookie", makeSessionCookie(token));
    res.json({
      authenticated: true,
      address: session.address,
      isAdmin: isAdminAddress(session.address),
      mode: session.mode,
      token
    });
  })
);

app.get(
  "/api/streak",
  readLimiter,
  asyncRoute(async (req, res) => {
    const { session, token } = await getRequestSession(req);

    if (!token || !session) {
      res.status(401).json({ authenticated: false });
      return;
    }

    const record = await getStreak(session.address);

    res.json(makeStreakStatus(record, false, isAdminAddress(session.address)));
  })
);

app.post(
  "/api/streak/check-in",
  writeLimiter,
  requireAllowedOrigin,
  asyncRoute(async (req, res) => {
    const { session, token } = await getRequestSession(req);

    if (!token || !session) {
      res.status(401).json({ error: "Connect wallet to check in." });
      return;
    }

    const current = await getStreak(session.address);
    const before = current?.lastCheckInAt;
    const next = applyCheckIn(current, session.address);
    const checkedInToday = before !== next.lastCheckInAt;

    await saveStreak(next);

    if (checkedInToday) {
      void sendBaseNotification(
        [session.address],
        "Snake streak",
        `Streak ${next.streak} saved. Next check-in opens in 24h.`,
        "/"
      ).catch((error) => console.error("Failed to send streak notification", error));
    }

    res.json(makeStreakStatus(next, checkedInToday, isAdminAddress(session.address)));
  })
);

app.post(
  "/api/admin/notify-random",
  notifyLimiter,
  requireAllowedOrigin,
  asyncRoute(async (req, res) => {
    const { session, token } = await getRequestSession(req);

    if (!token || !session || !isAdminAddress(session.address)) {
      res.status(403).json({ error: "Admin wallet required." });
      return;
    }

    if (!baseNotificationsApiKey || !baseAppUrl) {
      res.status(501).json({ error: "Base notification env is not configured." });
      return;
    }

    const audience = await getNotificationAudience();

    if (audience.length === 0) {
      res.json({ failedCount: 0, sentCount: 0 });
      return;
    }

    const text = notificationTexts[Math.floor(Math.random() * notificationTexts.length)];
    // Include short date in title so the same text isn't considered identical
    // across days — Base deduplicates identical (title+message) within 24 hours.
    const today = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    const result = await sendBaseNotification(audience, `Snake • ${today}`, text, "/");

    res.json({ ...result, audienceCount: audience.length });
  })
);

// ── Runs ────────────────────────────────────────────────────────────────
//
// A score reaches the database through exactly one door: a transaction that
// the arcade contract accepted. The client sends a hash and nothing else —
// mode, level, score, cells and moves are all read back out of the event, so
// there is no number here for anyone to inflate.

function isTxHash(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

type ArcadeRun = {
  cells: number;
  level: number;
  mode: GameMode;
  moves: number;
  score: bigint;
  won: boolean;
};

// uint256 scores don't always fit a JS number. Ours do, but the contract
// accepts anything, so a huge one goes out as a string rather than as garbage.
function scoreToJson(score: bigint) {
  return score <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(score) : score.toString();
}

async function readRunFromTransaction(txHash: Hex, player: string): Promise<ArcadeRun | null> {
  const receipt = await verifyClient.getTransactionReceipt({ hash: txHash });

  if (receipt.status !== "success") {
    return null;
  }

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== arcadeAddress) {
      continue;
    }

    let decoded;

    try {
      decoded = decodeEventLog({ abi: arcadeAbi, data: log.data, topics: log.topics });
    } catch {
      // Some other event from the same contract; not ours to read.
      continue;
    }

    if (decoded.eventName !== "RunRecorded") {
      continue;
    }

    const args = decoded.args as unknown as {
      player: string;
      mode: number;
      level: number;
      score: bigint;
      cells: number;
      moves: number;
      won: boolean;
    };

    // A player can only file their own runs, whoever sent the transaction.
    if (args.player.toLowerCase() !== player.toLowerCase()) {
      continue;
    }

    return {
      cells: Number(args.cells),
      level: Number(args.level),
      mode: args.mode === 1 ? "levels" : "classic",
      moves: Number(args.moves),
      score: args.score,
      won: args.won
    };
  }

  return null;
}

function bestKey(address: string, mode: GameMode, level: number) {
  return `${address.toLowerCase()}:${mode}:${level}`;
}

function isBetter(candidate: RunRow, current: RunRow | undefined) {
  if (!current) {
    return true;
  }

  return (
    candidate.score > current.score ||
    (candidate.score === current.score && candidate.cells > current.cells)
  );
}

async function saveRun(address: string, txHash: string, run: ArcadeRun) {
  const key = address.toLowerCase();
  const score = scoreToJson(run.score);

  if (!pool) {
    const row: RunRow = {
      address: key,
      cells: run.cells,
      level: run.level,
      mode: run.mode,
      moves: run.moves,
      score: Number(run.score),
      txHash,
      won: run.won
    };

    memoryRuns.set(txHash, row);

    const bestId = bestKey(key, run.mode, run.level);

    if (isBetter(row, memoryBests.get(bestId))) {
      memoryBests.set(bestId, row);
    }

    return;
  }

  await pool.query(
    `
      INSERT INTO runs (tx_hash, address, mode, level, score, cells, moves, won)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (tx_hash) DO NOTHING
    `,
    [txHash, key, run.mode, run.level, String(score), run.cells, run.moves, run.won]
  );

  // The best only moves on a better run: a worse one still lands in `runs`.
  await pool.query(
    `
      INSERT INTO player_bests (address, mode, level, score, cells, moves, tx_hash)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (address, mode, level) DO UPDATE
        SET score = EXCLUDED.score,
            cells = EXCLUDED.cells,
            moves = EXCLUDED.moves,
            tx_hash = EXCLUDED.tx_hash,
            updated_at = NOW()
      WHERE EXCLUDED.score > player_bests.score
         OR (EXCLUDED.score = player_bests.score AND EXCLUDED.cells > player_bests.cells)
    `,
    [key, run.mode, run.level, String(score), run.cells, run.moves, txHash]
  );
}

async function getBests(address: string) {
  const key = address.toLowerCase();

  if (!pool) {
    return Array.from(memoryBests.values())
      .filter((row) => row.address === key)
      .map((row) => ({
        cells: row.cells,
        level: row.level,
        mode: row.mode,
        moves: row.moves,
        score: row.score
      }));
  }

  const result = await pool.query<{
    cells: number;
    level: number;
    mode: GameMode;
    moves: number;
    score: string;
  }>(
    `SELECT mode, level, score, cells, moves
       FROM player_bests
      WHERE address = $1
      ORDER BY mode, level`,
    [key]
  );

  return result.rows.map((row) => ({
    cells: row.cells,
    level: row.level,
    mode: row.mode,
    moves: row.moves,
    score: scoreToJson(BigInt(row.score))
  }));
}

// ── Revives ─────────────────────────────────────────────────────────────
//
// Purchases are counted onchain, spending is counted here. Reading the total
// from the contract instead of mirroring every purchase means a dropped
// request costs nobody their revives: the next balance check picks them up.

async function readPurchasedRevives(address: string) {
  if (!arcadeAddress) {
    return 0;
  }

  const purchased = await verifyClient.readContract({
    address: arcadeAddress as Hex,
    abi: arcadeAbi,
    functionName: "revivesPurchased",
    args: [address as Hex]
  });

  return Number(purchased);
}

async function getReviveUsage(address: string) {
  const key = address.toLowerCase();

  if (!pool) {
    return memoryReviveUsage.get(key) ?? 0;
  }

  const result = await pool.query<{ used: string }>(
    "SELECT COUNT(*)::text AS used FROM revive_usage WHERE address = $1",
    [key]
  );

  return Number(result.rows[0]?.used ?? 0);
}

async function addReviveUsage(address: string) {
  const key = address.toLowerCase();

  if (!pool) {
    memoryReviveUsage.set(key, (memoryReviveUsage.get(key) ?? 0) + 1);
    return;
  }

  await pool.query("INSERT INTO revive_usage (address) VALUES ($1)", [key]);
}

async function getReviveBalance(address: string) {
  const [purchased, used] = await Promise.all([
    readPurchasedRevives(address),
    getReviveUsage(address)
  ]);

  return { balance: Math.max(0, purchased - used), purchased, used };
}

app.post(
  "/api/runs",
  writeLimiter,
  requireAllowedOrigin,
  asyncRoute(async (req, res) => {
    const { session } = await getRequestSession(req);

    if (!session) {
      res.status(401).json({ error: "Not authenticated." });
      return;
    }

    if (!arcadeAddress) {
      res.status(503).json({ error: "Arcade contract is not configured." });
      return;
    }

    const { txHash } = req.body as { txHash?: unknown };

    if (!isTxHash(txHash)) {
      res.status(400).json({ error: "A transaction hash is required." });
      return;
    }

    let run: ArcadeRun | null;

    try {
      run = await readRunFromTransaction(txHash, session.address);
    } catch (error) {
      // Not mined yet, or the RPC hasn't caught up. Worth retrying, so say so
      // with a status the client can tell apart from a rejection.
      console.warn("Could not read run transaction", txHash, error);
      res.status(409).json({ error: "Transaction is not confirmed yet." });
      return;
    }

    if (!run) {
      res.status(400).json({ error: "That transaction did not record a run for this wallet." });
      return;
    }

    await saveRun(session.address, txHash, run);

    res.json({
      ok: true,
      run: {
        cells: run.cells,
        level: run.level,
        mode: run.mode,
        moves: run.moves,
        score: scoreToJson(run.score),
        won: run.won
      },
      bests: await getBests(session.address)
    });
  })
);

app.get(
  "/api/runs/best",
  readLimiter,
  asyncRoute(async (req, res) => {
    const { session } = await getRequestSession(req);

    if (!session) {
      res.status(401).json({ error: "Not authenticated." });
      return;
    }

    res.json({ bests: await getBests(session.address) });
  })
);

app.get(
  "/api/revives",
  readLimiter,
  asyncRoute(async (req, res) => {
    const { session } = await getRequestSession(req);

    if (!session) {
      res.status(401).json({ error: "Not authenticated." });
      return;
    }

    res.json(await getReviveBalance(session.address));
  })
);

app.post(
  "/api/revives/use",
  writeLimiter,
  requireAllowedOrigin,
  asyncRoute(async (req, res) => {
    const { session } = await getRequestSession(req);

    if (!session) {
      res.status(401).json({ error: "Not authenticated." });
      return;
    }

    const before = await getReviveBalance(session.address);

    if (before.balance <= 0) {
      res.status(409).json({ error: "No revives left.", ...before });
      return;
    }

    await addReviveUsage(session.address);

    res.json({
      balance: before.balance - 1,
      purchased: before.purchased,
      used: before.used + 1
    });
  })
);

// Paymaster proxy — forwards JSON-RPC to CDP Paymaster while keeping
// the API key server-side. Only allows the methods needed for sponsorship.
const cdpPaymasterUrl = process.env.CDP_PAYMASTER_URL ?? process.env.PAYMASTER_URL;
const allowedPaymasterMethods = new Set([
  "pm_getPaymasterStubData",
  "pm_getPaymasterData",
  "pm_sponsorUserOperation",
  "pimlico_getUserOperationGasPrice"
]);

// Sponsorship requests arrive from the wallet infrastructure, not from our
// frontend — the paymasterService URL is handed to the wallet — so there is no
// session and no Origin to check here. What we can bound is how much any one
// smart account draws, plus a ceiling for the whole service. The contract and
// call policy allowlist itself lives in the CDP dashboard.
const consumePaymasterSender = createRateLimiter("paymaster-sender", 60, 60 * 60 * 1000);
const consumePaymasterGlobal = createRateLimiter("paymaster-global", 2000, 60 * 60 * 1000);

function getUserOperationSender(params: unknown): string | null {
  if (!Array.isArray(params) || params.length === 0) {
    return null;
  }

  const userOperation = params[0] as { sender?: unknown } | null;

  return typeof userOperation?.sender === "string" ? userOperation.sender.toLowerCase() : null;
}

app.post(
  "/api/paymaster",
  asyncRoute(async (req, res) => {
    if (!cdpPaymasterUrl) {
      res.status(503).json({ error: "Paymaster is not configured." });
      return;
    }

    const body = req.body as { method?: unknown; jsonrpc?: unknown; params?: unknown };
    if (
      typeof body?.method !== "string" ||
      !allowedPaymasterMethods.has(body.method) ||
      (body.jsonrpc !== undefined && body.jsonrpc !== "2.0") ||
      (body.params !== undefined && !Array.isArray(body.params))
    ) {
      res.status(400).json({ error: "Method not allowed." });
      return;
    }

    if (!consumePaymasterGlobal("all").allowed) {
      console.warn("Paymaster global rate limit hit");
      res.status(429).json({ error: "Sponsorship temporarily unavailable." });
      return;
    }

    const sender = getUserOperationSender(body.params);

    if (sender && !consumePaymasterSender(sender).allowed) {
      console.warn("Paymaster per-sender rate limit hit", sender);
      res.status(429).json({ error: "Sponsorship limit reached for this account." });
      return;
    }

    try {
      const response = await fetchWithTimeout(cdpPaymasterUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req.body)
      });
      const data = await response.json();
      res.status(response.status).json(data);
    } catch (error) {
      console.error("Paymaster proxy error", error);
      res.status(502).json({ error: "Paymaster upstream error." });
    }
  })
);

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (res.headersSent) {
    return;
  }

  // Malformed JSON is the caller's mistake, not ours.
  if (error instanceof SyntaxError && "body" in error) {
    res.status(400).json({ error: "Invalid JSON body." });
    return;
  }

  console.error("Unhandled route error", error);
  res.status(500).json({ error: "Internal error." });
});

// A rejected promise that escapes a handler used to kill the process, and with
// it every in-memory session and streak. Log and keep serving instead.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection", reason);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception", error);
});

const sessionCleanupIntervalMs = 6 * 60 * 60 * 1000;
setInterval(() => {
  void cleanupExpiredSessions().catch((error) => {
    console.error("Session cleanup failed", error);
  });
}, sessionCleanupIntervalMs).unref();

app.listen(port, () => {
  console.log(`Snake backend listening on http://localhost:${port}`);
});
