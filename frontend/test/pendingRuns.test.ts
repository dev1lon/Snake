import assert from "node:assert/strict";
import { test } from "node:test";
import { pendingRuns, queueRun, syncRun, type PendingRun } from "../src/pendingRuns";

const stored = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { value: {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => stored.set(key, value)
} });

test("queued payment survives RPC failure, sync retries without confirming or paying again", async () => {
  const run: PendingRun = { address: "player-a", contract: "arcade-a", kind: "transaction", reference: "tx-a" };
  queueRun(run);
  let confirms = 0;
  const confirm = async () => { confirms++; return { ok: true, hash: `0x${"ab".repeat(32)}` }; };
  assert.equal(await syncRun(run, confirm, async () => { throw new Error("Offline"); }), "pending");
  assert.equal(pendingRuns("player-b", "arcade-a").length, 0);
  assert.equal(pendingRuns("player-a", "arcade-b").length, 0);
  const [retry] = pendingRuns("player-a", "arcade-a");
  assert.ok(retry.hash);
  assert.equal(await syncRun(retry, confirm, async () => true), "synced");
  assert.equal(confirms, 1);
  assert.equal(pendingRuns("player-a", "arcade-a").length, 0);
});

test("parallel retry shares the same confirmation; reverted transactions leave the queue", async () => {
  const run: PendingRun = { address: "player-a", contract: "arcade-a", kind: "calls", reference: "bundle-a" };
  queueRun(run);
  let confirms = 0;
  const confirm = async () => { confirms++; await new Promise((resolve) => setTimeout(resolve, 10)); return { ok: false, hash: null }; };
  const results = await Promise.all([syncRun(run, confirm, async () => true), syncRun(run, confirm, async () => true)]);
  assert.deepEqual(results, ["failed", "failed"]);
  assert.equal(confirms, 1);
  assert.equal(pendingRuns("player-a", "arcade-a").length, 0);
});

test("confirmation timeout keeps the submitted bundle for a later retry", async () => {
  const run: PendingRun = { address: "player-c", contract: "arcade-a", kind: "calls", reference: "bundle-c" };
  queueRun(run);
  assert.equal(await syncRun(run, async () => { throw new Error("Timeout"); }, async () => true), "pending");
  assert.equal(pendingRuns("player-c", "arcade-a")[0].reference, "bundle-c");
});
