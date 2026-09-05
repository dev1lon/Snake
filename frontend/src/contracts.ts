import type { Address } from "viem";

// The original record contract: no mode, no level, nothing payable. Kept for
// the runs already written to it; new runs go to SnakeArcade.
export const snakeRecordsAbi = [
  {
    type: "function",
    name: "recordRun",
    stateMutability: "nonpayable",
    inputs: [
      { name: "score", type: "uint256" },
      { name: "cells", type: "uint16" },
      { name: "won", type: "bool" },
      { name: "moves", type: "uint256" }
    ],
    outputs: [{ name: "runId", type: "uint256" }]
  },
  {
    type: "function",
    name: "checkIn",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [{ name: "streak", type: "uint256" }]
  }
] as const;

// SnakeArcade: runs carry their mode and level, and every price is a variable
// the owner can retune. See contracts/SnakeArcade.sol.
export const snakeArcadeAbi = [
  {
    type: "function",
    name: "recordRun",
    stateMutability: "payable",
    inputs: [
      { name: "mode", type: "uint8" },
      { name: "level", type: "uint16" },
      { name: "score", type: "uint256" },
      { name: "cells", type: "uint16" },
      { name: "moves", type: "uint32" },
      { name: "won", type: "bool" }
    ],
    outputs: [{ name: "runId", type: "uint256" }]
  },
  {
    type: "function",
    name: "buySingleRevive",
    stateMutability: "payable",
    inputs: [],
    outputs: []
  },
  {
    type: "function",
    name: "buyRevivePacks",
    stateMutability: "payable",
    inputs: [{ name: "packs", type: "uint16" }],
    outputs: []
  },
  // Prices are held in cents and converted through the ETH/USD feed, so the
  // wei to send is a quote, not a constant.
  {
    type: "function",
    name: "quoteRecord",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }]
  },
  {
    type: "function",
    name: "quoteSingleRevive",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }]
  },
  {
    type: "function",
    name: "quotePacks",
    stateMutability: "view",
    inputs: [{ name: "packs", type: "uint16" }],
    outputs: [{ name: "", type: "uint256" }]
  },
  {
    type: "function",
    name: "singleRevivePriceCents",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint32" }]
  },
  {
    type: "function",
    name: "packRevivePriceCents",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint32" }]
  },
  {
    type: "function",
    name: "recordPriceCents",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint32" }]
  },
  {
    type: "function",
    name: "packRevives",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint16" }]
  },
  {
    type: "function",
    name: "revivesPurchased",
    stateMutability: "view",
    inputs: [{ name: "player", type: "address" }],
    outputs: [{ name: "", type: "uint256" }]
  },
  {
    type: "function",
    name: "bests",
    stateMutability: "view",
    inputs: [
      { name: "player", type: "address" },
      { name: "mode", type: "uint8" },
      { name: "level", type: "uint16" }
    ],
    outputs: [
      { name: "score", type: "uint128" },
      { name: "cells", type: "uint16" },
      { name: "moves", type: "uint32" },
      { name: "updatedAt", type: "uint40" }
    ]
  }
] as const;

export const MODE_CLASSIC = 0;
export const MODE_LEVELS = 1;

function getAddressEnv(value: string | undefined): Address | null {
  return value && /^0x[a-fA-F0-9]{40}$/.test(value.trim()) ? (value.trim() as Address) : null;
}

// Unset until the arcade contract is deployed. Everything that costs money
// checks this first and falls back to a local sandbox, so the game stays
// playable in the meantime.
export const ARCADE_ADDRESS = getAddressEnv(import.meta.env.VITE_ARCADE_CONTRACT_ADDRESS);
