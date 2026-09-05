import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { encodeAbiParameters, encodeEventTopics, parseAbi, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";

const account = privateKeyToAccount(generatePrivateKey());
const arcade = "0xd3a355586a035baa80ea56d6d8627b0f64141d78";
const txHash = `0x${"ab".repeat(32)}`;
const blockHash = `0x${"12".repeat(32)}`;
const score = 2n ** 256n - 1n;
const eventAbi = parseAbi(["event RunRecorded(address indexed player, uint8 indexed mode, uint16 indexed level, uint256 runId, uint256 score, uint16 cells, uint32 moves, bool won, bool personalBest, uint256 paid, uint256 recordedAt)"]);
let rpcMode = "ok";
let backend;
let api;
let token;
let rpc;
let database;
let databaseAdmin;
let databaseUrl = "";
const schema = `snake_release_${randomUUID().replaceAll("-", "")}`;

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

async function request(path, body, headers = {}) {
  return fetch(`${api}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

async function signedPayload() {
  const { nonce } = await (await request("/api/auth/nonce")).json();
  const message = createSiweMessage({ address: account.address, chainId: 8453, domain: "localhost:5173", uri: "http://localhost:5173", version: "1", nonce });
  return { message, signature: await account.signMessage({ message }), mode: "Standard Wallet" };
}

before(async () => {
  if (process.env.SNAKE_TEST_DATABASE_URL) {
    databaseAdmin = new Pool({ connectionString: process.env.SNAKE_TEST_DATABASE_URL });
    await databaseAdmin.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(process.env.SNAKE_TEST_DATABASE_URL);
    url.searchParams.set("options", `-c search_path=${schema}`);
    databaseUrl = url.toString();
    database = new Pool({ connectionString: databaseUrl });
    // Reproduce the previous production schema and preserve its historical rows.
    await database.query(`
      CREATE TABLE recorded_runs (address TEXT PRIMARY KEY, score BIGINT NOT NULL);
      INSERT INTO recorded_runs VALUES ('legacy-player', 42);
      CREATE TABLE runs (
        id BIGSERIAL PRIMARY KEY, tx_hash TEXT NOT NULL UNIQUE, address TEXT NOT NULL,
        mode TEXT NOT NULL, level SMALLINT NOT NULL, score BIGINT NOT NULL,
        cells INTEGER NOT NULL, moves INTEGER NOT NULL, won BOOLEAN NOT NULL,
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE player_bests (
        address TEXT NOT NULL, mode TEXT NOT NULL, level SMALLINT NOT NULL,
        score BIGINT NOT NULL, cells INTEGER NOT NULL, moves INTEGER NOT NULL,
        tx_hash TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (address, mode, level)
      );
      INSERT INTO runs (tx_hash,address,mode,level,score,cells,moves,won)
        VALUES ('legacy-hash','legacy-player','classic',0,42,8,12,false);
      INSERT INTO player_bests (address,mode,level,score,cells,moves,tx_hash)
        VALUES ('legacy-player','classic',0,42,8,12,'legacy-hash');
      CREATE TABLE revive_usage (
        id BIGSERIAL PRIMARY KEY, address TEXT NOT NULL, used_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      INSERT INTO revive_usage (address) VALUES ('legacy-player');
    `);
  }
  rpc = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const call = JSON.parse(raw);
    let result = "0x";
    let error;
    if (rpcMode === "offline") error = { code: -32005, message: "Rate limit" };
    else if (call.method.startsWith("pm_")) error = { code: -32000, message: "Sponsorship is disabled in CDP" };
    else if (call.method === "eth_call" && call.params[0].to?.toLowerCase() === arcade) result = toHex(1n, { size: 32 });
    else if (call.method === "eth_getTransactionReceipt") {
      result = rpcMode === "pending" ? null : {
        transactionHash: txHash, transactionIndex: "0x0", blockHash, blockNumber: "0x1",
        from: account.address, to: arcade, cumulativeGasUsed: "0x1", gasUsed: "0x1",
        effectiveGasPrice: "0x1", contractAddress: null, logsBloom: `0x${"00".repeat(256)}`, status: "0x1", type: "0x2",
        logs: [{ address: arcade, blockHash, blockNumber: "0x1", transactionHash: txHash, transactionIndex: "0x0", logIndex: "0x0", removed: false,
          topics: encodeEventTopics({ abi: eventAbi, eventName: "RunRecorded", args: { player: account.address, mode: 0, level: 0 } }),
          data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint16" }, { type: "uint32" }, { type: "bool" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }], [1n, score, 16, 4294967295, false, true, 1n, 1n])
        }]
      };
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, ...(error ? { error } : { result }) }));
  });
  const rpcPort = await listen(rpc);
  const portFinder = createServer();
  const port = await listen(portFinder);
  await new Promise((resolve) => portFinder.close(resolve));
  api = `http://127.0.0.1:${port}`;
  backend = spawn(process.execPath, ["dist/server.js"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: { ...process.env, NODE_ENV: databaseUrl ? "production" : "test", FRONTEND_ORIGIN: "http://localhost:5173", PORT: String(port), RPC_URL: `http://127.0.0.1:${rpcPort}`, DATABASE_URL: databaseUrl, DATABASE_SSL: "false", BASE_API_KEY: "", BASE_NOTIFICATIONS_API_KEY: "", CDP_PAYMASTER_URL: `http://127.0.0.1:${rpcPort}`, ARCADE_CONTRACT_ADDRESS: arcade }
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Backend did not start")), 10_000);
    backend.stdout.on("data", (data) => {
      if (data.toString().includes("listening")) { clearTimeout(timeout); resolve(); }
    });
    backend.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Backend exited: ${code}`)); });
  });
  const response = await request("/api/auth/verify", await signedPayload());
  assert.equal(response.status, 200);
  token = (await response.json()).token;
});

after(async () => {
  if (backend && backend.exitCode === null) {
    const exited = new Promise((resolve) => backend.once("exit", resolve));
    backend.kill();
    await exited;
  }
  if (rpc) await new Promise((resolve) => rpc.close(resolve));
  await database?.end();
  if (databaseAdmin) {
    await databaseAdmin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await databaseAdmin.end();
  }
});

test("production schema migration preserves history and uses full numeric ranges", { skip: !process.env.SNAKE_TEST_DATABASE_URL }, async () => {
  for (const table of ["recorded_runs", "runs", "player_bests", "revive_usage"]) {
    assert.equal((await database.query(`SELECT COUNT(*) FROM ${table} WHERE address = 'legacy-player'`)).rows[0].count, "1");
  }
  const columns = (await database.query(`SELECT table_name, column_name, data_type
    FROM information_schema.columns WHERE table_schema = $1
    AND table_name IN ('runs', 'player_bests') AND column_name IN ('score', 'moves')`, [schema])).rows;
  assert.equal(columns.length, 4);
  for (const column of columns) assert.equal(column.data_type, column.column_name === "score" ? "numeric" : "bigint");
});

test("provider controls sponsorship independently of RPC reads", async () => {
  const response = await request("/api/paymaster", { jsonrpc: "2.0", id: 1, method: "pm_getPaymasterData", params: [] });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).error, { code: -32000, message: "Sponsorship is disabled in CDP" });
  assert.equal((await (await request("/api/revives")).json()).balance, 1);
});

test("parallel distinct spends consume only one available revive; replay does not spend again", async () => {
  const keys = Array.from({ length: 8 }, (_, i) => `revive-request-${String(i).padStart(4, "0")}`);
  const responses = await Promise.all(keys.map((key) => request("/api/revives/use", {}, { "Idempotency-Key": key })));
  assert.equal(responses.filter((response) => response.status === 200).length, 1);
  assert.equal(responses.filter((response) => response.status === 409).length, 7);
  const acceptedKey = keys[responses.findIndex((response) => response.status === 200)];
  const replay = await request("/api/revives/use", {}, { "Idempotency-Key": acceptedKey });
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), { balance: 0, purchased: 1, used: 1 });
});

test("concurrent SIWE replay produces only one session", async () => {
  const payload = await signedPayload();
  const results = await Promise.all([request("/api/auth/verify", payload), request("/api/auth/verify", payload)]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 400]);
});

test("cross-origin logout is rejected and leaves the session usable", async () => {
  assert.equal((await request("/api/auth/logout", {}, { Origin: "https://untrusted.example" })).status, 403);
  assert.equal((await request("/api/auth/me")).status, 200);
});

test("receipt pending and RPC outage have different retryable responses", async () => {
  rpcMode = "pending";
  assert.equal((await request("/api/runs", { txHash })).status, 409);
  rpcMode = "offline";
  assert.equal((await request("/api/runs", { txHash })).status, 503);
  rpcMode = "ok";
});

test("run replay preserves full uint256 scores and uint32 moves", async () => {
  for (const hash of [txHash, `0x${txHash.slice(2).toUpperCase()}`]) {
    const response = await request("/api/runs", { txHash: hash });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.run.score, score.toString());
    assert.equal(body.run.moves, 4294967295);
    assert.equal(body.bests[0].score, score.toString());
  }
  assert.equal((await request("/api/runs", {})).status, 400);
});

test("production without persistent storage exits instead of reporting healthy", async () => {
  const child = spawn(process.execPath, ["dist/server.js"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: { ...process.env, NODE_ENV: "production", DATABASE_URL: "", PORT: "0" },
    stdio: "ignore"
  });
  const code = await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(code, 1);
});
