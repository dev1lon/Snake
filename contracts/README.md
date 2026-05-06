# SnakeRecords

`SnakeRecords.sol` is the Base mainnet contract for Snake.

Functions:

- `recordRun(uint256 score, uint16 cells, bool won, uint256 moves)` emits `RunRecorded`.
- `checkIn()` emits `CheckInRecorded` and uses a 24 hour interval with a 12 hour grace window.

Frontend env after deployment:

```bash
VITE_RECORD_CONTRACT_ADDRESS=0x9e5d82E6B6419C066Bc57F5a70116659c468d780
VITE_PAYMASTER_URL=https://...
```

Backend env for Base App notifications:

```bash
BASE_API_KEY=...
ADMIN_WALLET_ADDRESS=0x...
```

`BASE_APP_URL` is optional if `FRONTEND_ORIGIN` already points to the public app URL.

For gasless Base mainnet writes, add the deployed contract address and `recordRun` call policy to the paymaster allowlist in Base/Coinbase Developer Platform.
