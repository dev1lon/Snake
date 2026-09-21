import type { IncomingMessage, ServerResponse } from "node:http";
import { app, cleanupExpiredSessions, ensureSessionStore } from "../backend/src/app.js";

// Vercel entry point. The same Express app that Render runs, wrapped in a
// function — see backend/src/app.ts. server.ts is still the Render entry, so
// either platform can serve this API from the one codebase.

// Schema setup must finish before the first request and must not run again on
// every one: a cold start awaits this promise, a warm one already has it.
let ready: Promise<void> | null = null;

function initialise() {
  if (!process.env.DATABASE_URL) {
    // Without a database, revive spends would live in a function's memory and
    // vanish between invocations — every player would get free revives.
    return Promise.reject(new Error("DATABASE_URL is required to persist paid revive usage."));
  }

  return ensureSessionStore();
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    ready = ready ?? initialise();
    await ready;
  } catch (error) {
    // Let the next cold start try again rather than serving errors forever.
    ready = null;
    console.error("Backend initialization failed", error);
    res.statusCode = 503;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Service is starting up. Try again shortly." }));
    return;
  }

  // A function has nowhere to keep a timer, so the session sweep arrives as a
  // scheduled request instead (see vercel.json). Vercel signs it with
  // CRON_SECRET; nothing else may trigger it.
  if (req.url?.startsWith("/api/cron/cleanup")) {
    const secret = process.env.CRON_SECRET;

    if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
      res.statusCode = 401;
      res.end();
      return;
    }

    await cleanupExpiredSessions();
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  return app(req, res);
}
