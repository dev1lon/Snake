# Contracts

## SnakeArcade (current)

Deployed on Base mainnet at `0xd3a355586a035bAA80eA56d6D8627b0F64141D78`.

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
- **Saving costs the same in both modes** — `recordPriceCents`, charged on every
  `recordRun`.
- **Prices are dollars, not ether.** A revive is a dollar; that is the product
  decision. `singleRevivePriceCents`, `packRevivePriceCents` and
  `recordPriceCents` are held in US cents and converted at payment time through
  the Chainlink ETH/USD feed, so a move in the market doesn't quietly reprice
  the game. The owner can retune them with `setPrices`; nothing else about the
  contract can be changed.
- **Quotes are views.** `quoteRecord()`, `quoteSingleRevive()` and
  `quotePacks(n)` return what to send in wei. The frontend adds 2% and the
  contract refunds the difference, because a quote is a block or two old by the
  time the transaction lands.
- **The feed is guarded.** An answer older than `maxPriceAge`, or one that
  isn't positive, reverts the payment rather than charging a made-up price.
  `setPriceFeed(feed, maxAge)` can move to another aggregator, and it rejects
  one that can't answer.
- Revives are counted, not consumed, onchain: `revivesPurchased` only grows. The
  backend counts spends against it, because a transaction per death would cost
  more than a revive is worth.
- `withdraw(to, amount)` and `transferOwnership(newOwner)` are owner-only.

### Deploying

The constructor takes the feed, the staleness window and every price — nothing
is defaulted, so a deploy cannot quietly ship the wrong number:

```
constructor(
  address priceFeed,
  uint256 maxPriceAge,
  uint32 singleRevivePriceCents,
  uint32 packRevivePriceCents,
  uint16 packRevives,
  uint32 recordPriceCents
)
```

For Base mainnet:

```
0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70, 90000, 100, 1000, 20, 10
```

| argument | value | meaning |
| --- | --- | --- |
| `priceFeed` | `0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70` | Chainlink ETH/USD on Base — verified onchain: `description()` is `ETH / USD`, `decimals()` is 8 |
| `maxPriceAge` | `90000` | 25 hours, comfortably past a 24 hour heartbeat |
| `singleRevivePriceCents` | `100` | $1.00 |
| `packRevivePriceCents` | `1000` | $10.00 |
| `packRevives` | `20` | revives per pack |
| `recordPriceCents` | `10` | $0.10 |

The dollar prices hold on their own from here: no maintenance transaction is
needed when ETH moves. `setPrices` is for changing what something costs, not
for tracking the market.

Compile with solc 0.8.20 or newer — verified against both 0.8.20 and 0.8.26 —
and deploy to Base mainnet. Then:

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
