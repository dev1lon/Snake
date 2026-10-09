#!/usr/bin/env node
// Prints what the arcade contract is holding, in the unit the explorer's
// withdraw form actually wants: wei. Copy the number, paste it into `amount`.
//
//   node backend/scripts/arcade-balance.mjs
//   node backend/scripts/arcade-balance.mjs 0x<other contract>
//
// RPC_URL is used when set; the public Base endpoint otherwise.

import { createPublicClient, formatEther, http } from "viem";
import { base } from "viem/chains";

const address =
  process.argv[2] ??
  process.env.ARCADE_CONTRACT_ADDRESS ??
  "0xd3a355586a035bAA80eA56d6D8627b0F64141D78";

const client = createPublicClient({ chain: base, transport: http(process.env.RPC_URL) });
const balance = await client.getBalance({ address });

console.log(`contract  ${address}`);
console.log(`balance   ${formatEther(balance)} ETH`);
console.log(`\npaste into amount (wei):\n${balance}`);

if (balance === 0n) {
  console.log("\nNothing to withdraw — the transfer would revert.");
}
