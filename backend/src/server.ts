import { app, databaseUrl, ensureSessionStore, pool, rpcUrl, sweepExpired } from "./app.js";

const port = Number(process.env.PORT ?? 4000);

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
  void sweepExpired().catch((error) => {
    console.error("Expiry sweep failed", error);
  });
}, sessionCleanupIntervalMs).unref();

async function start() {
  if (process.env.NODE_ENV === "production" && !databaseUrl) {
    throw new Error("DATABASE_URL is required in production to persist paid revive usage.");
  }
  await ensureSessionStore();
  if (!rpcUrl) console.warn("RPC_URL is unset; public Base RPC may rate-limit login and payments.");
  app.listen(port, () => {
    console.log(`Snake backend listening on http://localhost:${port}`);
  });
}

void start().catch(() => {
  console.error("Backend initialization failed. Check database connectivity and schema permissions.");
  process.exitCode = 1;
  void pool?.end();
});
