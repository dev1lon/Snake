# Contracts

## SnakeArcade (current)

`SnakeArcade.sol` records runs and sells revives. It replaces `SnakeRecords`,
which had no game mode, no level, and no way to charge for anything.

```
recordRun(uint8 mode, uint16 level, uint256 score, uint16 cells, uint32 moves, bool won) payable
buySingleRevive() payable
buyRevivePacks(uint16 packs) payable
```

- **Modes never mix.** `mode` is 0 for classic and 1 for levels, and a classic
  run must record at `level = 0`. Bests are keyed by `(player, mode, level)`, so
  a classic score can never overwrite a level score.
- **Saving costs the same in both modes** — `recordPrice`, charged on every
  `recordRun`.
- **Every price is a variable.** `singleRevivePrice`, `packRevivePrice`,
  `packRevives` and `recordPrice` are set in the constructor and can be retuned
  by the owner with `setPrices`. They are dollar decisions paid in ETH, and ETH
  moves; nothing else about the contract can be changed.
- **Overpayment is refunded.** A price change between quote and confirmation
  costs the player nothing.
- Revives are counted, not consumed, onchain: `revivesPurchased` only grows. The
  backend counts spends against it, because a transaction per death would cost
  more than a revive is worth.
- `withdraw(to, amount)` and `transferOwnership(newOwner)` are owner-only.

### Deploying

The constructor takes every price, in wei — nothing is defaulted, so a deploy
cannot quietly ship the wrong number:

```
constructor(uint256 singleRevivePrice, uint256 packRevivePrice, uint16 packRevives, uint256 recordPrice)
```

Compile with solc 0.8.24 or newer (verified against 0.8.26) and deploy to Base
mainnet. Then:

```bash
# frontend
VITE_ARCADE_CONTRACT_ADDRESS=0x...
# backend
ARCADE_CONTRACT_ADDRESS=0x...
```

For gasless writes, add the deployed address plus `recordRun`,
`buySingleRevive` and `buyRevivePacks` to the paymaster call policy in the
Coinbase Developer Platform. Sponsorship covers gas only — the ETH price of a
save or a revive always comes from the player.

## SnakeRecords (previous)

Deployed on Base mainnet at `0x9e5d82E6B6419C066Bc57F5a70116659c468d780`.

- `recordRun(uint256 score, uint16 cells, bool won, uint256 moves)` emits `RunRecorded`.
- `checkIn()` emits `CheckInRecorded`, 24 hour interval with a 12 hour grace window.

Daily check-in still runs against this contract. Runs no longer do.

Builder code: `bc_8wev2t9h`, appended to call data as
`VITE_BUILDER_CODE_SUFFIX`.
