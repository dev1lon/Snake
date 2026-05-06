import cors from "cors";
import express from "express";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { SiweMessage } from "siwe";

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

const app = express();
const port = Number(process.env.PORT ?? 4000);
const frontendOrigin = process.env.FRONTEND_ORIGIN;
const databaseUrl = process.env.DATABASE_URL;
const leaderboard: LeaderboardEntry[] = [];
const nonces = new Map<string, number>();
const sessions = new Map<string, Session>();
const pool = databaseUrl
  ? new Pool({
      connectionString: databaseUrl,
      ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined
    })
  : null;
const sessionCookieName = "sneak_session";
const sessionMaxAgeSeconds = 60 * 60 * 24 * 400;
const nonceMaxAgeMs = 10 * 60 * 1000;

function getAllowedOrigins() {
  if (!frontendOrigin) {
    return true;
  }

  const origin = frontendOrigin.startsWith("http") ? frontendOrigin : `https://${frontendOrigin}`;
  const host = origin.replace(/^https?:\/\//, "");

  return [origin, `https://${host}`, `http://${host}`];
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

  const verification = await siweMessage.verify(
    {
      nonce,
      signature
    },
    {
      suppressExceptions: true
    }
  );

  if (!verification.success) {
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

app.listen(port, () => {
  console.log(`Snake backend listening on http://localhost:${port}`);
});
