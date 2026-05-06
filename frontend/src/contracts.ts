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
