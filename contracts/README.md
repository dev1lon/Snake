# SnakeRecords

`SnakeRecords.sol` is the Base mainnet contract for Snake.

Functions:

- `recordRun(uint256 score, uint16 cells, bool won, uint256 moves)` emits `RunRecorded`.
- `checkIn()` emits `CheckInRecorded` and uses a 24 hour interval with a 12 hour grace window.

Frontend env after deployment:

```bash
VITE_RECORD_CONTRACT_ADDRESS=0x...
VITE_PAYMASTER_URL=https://...
```

Backend env for Base App notifications:

```bash
BASE_APP_URL=https://snake-frontend-cx28.onrender.com
BASE_NOTIFICATIONS_API_KEY=...
ADMIN_NOTIFICATION_KEY=...
```

For gasless Base mainnet writes, add the deployed contract address and `recordRun` call policy to the paymaster allowlist in Base/Coinbase Developer Platform.
