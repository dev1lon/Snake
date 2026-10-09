#!/usr/bin/env node
// Lists players who still hold revives they paid for, so a replacement arcade
// contract can start out owing them exactly what the old one did.
//
//   DATABASE_URL="postgresql://…supabase…"      (spends live here)
//   ARCADE_CONTRACT_ADDRESS="0x…"               (the OLD contract)
//   RPC_URL="https://…"                         (optional; public endpoint otherwise)
//   node backend/scripts/arcade-holders.mjs
//
// Balance is what the contract counted as bought minus what the database
// counted as spent — the same arithmetic the API does. Read-only: it changes
// nothing, onchain or in the database. The output is the exact list of
// grantRevives calls to make on the new contract.

import { Pool } from "pg";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";

const databaseUrl = process.env.DATABASE_URL;
const arcadeAddress = process.env.ARCADE_CONTRACT_ADDRESS;

if (!databaseUrl || !arcadeAddress) {
  console.error("Set DATABASE_URL and ARCADE_CONTRACT_ADDRESS first.");
  process.exit(1);
}

const abi = [
  {
    type: "function",
    name: "revivesPurchased",
    stateMutability: "view",
    inputs: [{ name: "player", type: "address" }],
    outputs: [{ name: "", type: "uint256" }]
  }
];

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: process.env.DATABASE_SSL === "false" ? undefined : { rejectUnauthorized: false }
});

// Multicall batching keeps this to a couple of requests; one call per player
// would hit a public endpoint's rate limit well before the list ended.
const client = createPublicClient({
  chain: base,
  transport: http(process.env.RPC_URL),
  batch: { multicall: true }
});

try {
  // Everyone the game has ever seen. Buying needs a signed-in wallet, so no
  // buyer can be missing from this union.
  const { rows: players } = await pool.query(
    `SELECT address FROM auth_sessions
      UNION SELECT address FROM runs
      UNION SELECT address FROM revive_usage
      UNION SELECT address FROM check_in_streaks
      ORDER BY address`
  );

  const { rows: usageRows } = await pool.query(
    "SELECT address, COUNT(*)::int AS used FROM revive_usage GROUP BY address"
  );
  const usage = new Map(usageRows.map((row) => [row.address.toLowerCase(), row.used]));

  console.log(`Checking ${players.length} known wallets against ${arcadeAddress}\n`);

  const purchased = await Promise.all(
    players.map((row) =>
      client
        .readContract({
          address: arcadeAddress,
          abi,
          functionName: "revivesPurchased",
          args: [row.address]
        })
        .catch(() => null)
    )
  );

  const holders = [];
  let unreadable = 0;

  players.forEach((row, index) => {
    const bought = purchased[index];

    if (bought === null) {
      unreadable += 1;
      return;
    }

    if (Number(bought) > 0) {
      const spent = usage.get(row.address.toLowerCase()) ?? 0;

      holders.push({
        address: row.address,
        bought: Number(bought),
        spent,
        remaining: Number(bought) - spent
      });
    }
  });

  if (unreadable > 0) {
    console.log(`${unreadable} wallet(s) could not be read — rerun with RPC_URL set.\n`);
  }

  if (holders.length === 0) {
    console.log("No wallet ever bought a revive. Nothing to carry over to a new contract.");
  } else {
    for (const holder of holders) {
      console.log(
        `${holder.address}  bought ${holder.bought}, spent ${holder.spent}, still owed ${holder.remaining}`
      );
    }

    const owed = holders.filter((holder) => holder.remaining > 0);

    console.log(
      `\n${holders.length} buyer(s); ${owed.length} still hold revives they have not used.`
    );

    if (owed.length > 0) {
      console.log("\nOn the new contract, call grantRevives once per wallet:\n");

      for (const holder of owed) {
        console.log(`  grantRevives("${holder.address}", ${holder.remaining})`);
      }
    }
  }
} catch (error) {
  console.error("Lookup failed:", error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
