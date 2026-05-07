import cors from "cors";
import express from "express";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { SiweMessage } from "siwe";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";

// viem PublicClient verifies SIWE for ALL signature types (EOA, ERC-1271, EIP-6492).
// Base Smart Wallet uses ERC-1271/EIP-6492 — siwe@3 alone can't validate it.
const verifyClient = createPublicClient({ chain: base, transport: http() });

type LeaderboardEntry = {
  id: string;
  name: string;
  score: number;
  cells: number;
  won: boolean;
  createdAt: string;
};

type WalletMode = "Smart Wallet" | "Standard Wallet";

type Session = {
  address: string;
  createdAt: number;
  mode: WalletMode;
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
const adminWalletAddress = process.env.ADMIN_WALLET_ADDRESS?.toLowerCase();
const leaderboard: LeaderboardEntry[] = [];
const nonces = new Map<string, number>();
const sessions = new Map<string, Session>();
const streaks = new Map<string, StreakRecord>();
const recordedPlayers = new Set<string>();
const pool = databaseUrl
  ? new Pool({
      connectionString: databaseUrl,
      ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined
    })
  : null;
const sessionCookieName = "sneak_session";
const sessionMaxAgeSeconds = 60 * 60 * 24 * 400;
const nonceMaxAgeMs = 10 * 60 * 1000;
const checkInIntervalMs = 24 * 60 * 60 * 1000;
const checkInGraceMs = 12 * 60 * 60 * 1000;
const notificationTexts = [
  "Your Snake streak is waiting.",
  "One clean run can beat your record.",
  "The board is ready. Keep the streak alive.",
  "Snake check-in is open.",
  "Base snake is calling you back."
];

function getAllowedOrigins() {
  const origins = new Set([
    publicFrontendOrigin,
    defaultFrontendOrigin,
    "http://localhost:5173",
    "http://127.0.0.1:5173"
  ]);

  return Array.from(origins);
}

function normalizeOrigin(value: string) {
  return value.startsWith("http") ? value : `https://${value}`;
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS recorded_runs (
      address TEXT PRIMARY KEY,
      first_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function getSession(token: string) {
  if (!pool) {
    return sessions.get(token);
  }

  const result = await pool.query<{
    address: string;
    created_at: Date;
    mode: WalletMode;
  }>("SELECT address, created_at, mode FROM auth_sessions WHERE token = $1", [token]);
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

async function getRequestSession(cookieHeader: string | undefined) {
  const token = getSessionToken(cookieHeader);
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
  return Boolean(adminWalletAddress && address?.toLowerCase() === adminWalletAddress);
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

  const response = await fetch("https://dashboard.base.org/api/v1/notifications/send", {
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
  const data = (await response.json().catch(() => null)) as NotificationResult | null;

  if (!response.ok || !data) {
    return { failedCount: walletAddresses.length, sentCount: 0 };
  }

  return {
    failedCount: data.failedCount,
    sentCount: data.sentCount
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

    const response = await fetch(url, {
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

app.use(
  cors({
    credentials: true,
    origin: getAllowedOrigins()
  })
);
app.use(express.json({ limit: "32kb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/auth/nonce", (_req, res) => {
  cleanupNonces();

  const nonce = createNonce();
  nonces.set(nonce, Date.now());
  res.json({ nonce });
});

app.get("/api/auth/me", async (req, res) => {
  const token = getSessionToken(req.headers.cookie);
  const session = token ? await getSession(token) : undefined;

  if (!token || !session) {
    res.status(401).json({ authenticated: false });
    return;
  }

  res.setHeader("Set-Cookie", makeSessionCookie(token));
  res.json({
    authenticated: true,
    address: session.address,
    mode: session.mode
  });
});

app.post("/api/auth/logout", async (req, res) => {
  const token = getSessionToken(req.headers.cookie);

  if (token) {
    await deleteSession(token);
  }

  res.setHeader("Set-Cookie", makeClearSessionCookie());
  res.json({ ok: true });
});

app.post("/api/auth/verify", async (req, res) => {
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
  const siweMessage = new SiweMessage(message);
  const nonce = siweMessage.nonce;
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
    mode: walletMode
  };

  await saveSession(token, session);
  res.setHeader("Set-Cookie", makeSessionCookie(token));
  res.json({
    authenticated: true,
    address: session.address,
    mode: session.mode
  });
});

app.get("/api/streak", async (req, res) => {
  const { session, token } = await getRequestSession(req.headers.cookie);

  if (!token || !session) {
    res.status(401).json({ authenticated: false });
    return;
  }

  const record = await getStreak(session.address);

  res.json(makeStreakStatus(record, false, isAdminAddress(session.address)));
});

app.post("/api/streak/check-in", async (req, res) => {
  const { session, token } = await getRequestSession(req.headers.cookie);

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
});

app.post("/api/admin/notify-random", async (req, res) => {
  const { session, token } = await getRequestSession(req.headers.cookie);

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
  const result = await sendBaseNotification(audience, "Snake", text, "/");

  res.json(result);
});

app.get("/api/leaderboard", (_req, res) => {
  res.json({
    entries: leaderboard
      .slice()
      .sort((a, b) => b.score - a.score || Number(b.won) - Number(a.won))
      .slice(0, 10)
  });
});

app.post("/api/leaderboard", (req, res) => {
  const { name, score, cells, won } = req.body as Partial<LeaderboardEntry>;

  if (
    typeof name !== "string" ||
    typeof score !== "number" ||
    typeof cells !== "number" ||
    typeof won !== "boolean"
  ) {
    res.status(400).json({ error: "Invalid leaderboard payload." });
    return;
  }

  const entry: LeaderboardEntry = {
    id: randomUUID(),
    name: name.trim().slice(0, 18) || "Player",
    score: Math.max(0, Math.floor(score)),
    cells: Math.max(0, Math.floor(cells)),
    won,
    createdAt: new Date().toISOString()
  };

  leaderboard.push(entry);
  leaderboard.sort((a, b) => b.score - a.score || Number(b.won) - Number(a.won));
  leaderboard.splice(50);

  res.status(201).json({ entry });
});

app.post("/api/player/record", async (req, res) => {
  const { session } = await getRequestSession(req.headers.cookie);

  if (!session) {
    res.status(401).json({ error: "Not authenticated." });
    return;
  }

  const address = session.address.toLowerCase();

  if (pool) {
    await pool.query(
      `INSERT INTO recorded_runs (address) VALUES ($1) ON CONFLICT (address) DO NOTHING`,
      [address]
    );
  } else {
    recordedPlayers.add(address);
  }

  res.json({ ok: true });
});

// Paymaster proxy — forwards JSON-RPC to CDP Paymaster while keeping
// the API key server-side. Only allows the methods needed for sponsorship.
const cdpPaymasterUrl = process.env.CDP_PAYMASTER_URL ?? process.env.PAYMASTER_URL;
const allowedPaymasterMethods = new Set([
  "pm_getPaymasterStubData",
  "pm_getPaymasterData",
  "pm_sponsorUserOperation",
  "pimlico_getUserOperationGasPrice"
]);

app.post("/api/paymaster", async (req, res) => {
  if (!cdpPaymasterUrl) {
    res.status(503).json({ error: "Paymaster is not configured." });
    return;
  }

  const body = req.body as { method?: unknown };
  if (typeof body?.method !== "string" || !allowedPaymasterMethods.has(body.method)) {
    res.status(400).json({ error: "Method not allowed." });
    return;
  }

  try {
    const response = await fetch(cdpPaymasterUrl, {
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
});

app.get("/api/stats", async (_req, res) => {
  let players = 0;

  if (pool) {
    const result = await pool.query<{ count: string }>(`
      SELECT COUNT(DISTINCT address) AS count FROM (
        SELECT address FROM check_in_streaks
        UNION
        SELECT address FROM recorded_runs
      ) t
    `);
    players = parseInt(result.rows[0]?.count ?? "0", 10);
  } else {
    const all = new Set([...streaks.keys(), ...recordedPlayers]);
    players = all.size;
  }

  res.json({ players });
});

app.listen(port, () => {
  console.log(`Snake backend listening on http://localhost:${port}`);
});
