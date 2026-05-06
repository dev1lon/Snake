// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract SnakeRecords {
    uint16 public constant BOARD_CELLS = 256;
    uint256 public constant CHECK_IN_INTERVAL = 24 hours;
    uint256 public constant CHECK_IN_GRACE = 12 hours;

    struct Player {
        uint256 bestScore;
        uint16 bestCells;
        uint256 totalRuns;
        uint256 streak;
        uint256 lastCheckInAt;
    }

    mapping(address player => Player) public players;

    event RunRecorded(
        address indexed player,
        uint256 indexed runId,
        uint256 score,
        uint16 cells,
        bool won,
        uint256 moves,
        uint256 recordedAt
    );

    event CheckInRecorded(
        address indexed player,
        uint256 streak,
        uint256 checkedInAt,
        uint256 nextCheckInAt,
        uint256 expiresAt
    );

    error InvalidCells();
    error CheckInTooEarly(uint256 nextCheckInAt);

    function recordRun(
        uint256 score,
        uint16 cells,
        bool won,
        uint256 moves
    ) external returns (uint256 runId) {
        if (cells == 0 || cells > BOARD_CELLS) {
            revert InvalidCells();
        }

        Player storage player = players[msg.sender];
        runId = ++player.totalRuns;

        if (score > player.bestScore || (score == player.bestScore && cells > player.bestCells)) {
            player.bestScore = score;
            player.bestCells = cells;
        }

        emit RunRecorded(msg.sender, runId, score, cells, won, moves, block.timestamp);
    }

    function checkIn() external returns (uint256 streak) {
        Player storage player = players[msg.sender];

        if (player.lastCheckInAt == 0) {
            player.streak = 1;
        } else {
            uint256 nextCheckInAt = player.lastCheckInAt + CHECK_IN_INTERVAL;

            if (block.timestamp < nextCheckInAt) {
                revert CheckInTooEarly(nextCheckInAt);
            }

            player.streak = block.timestamp <= nextCheckInAt + CHECK_IN_GRACE ? player.streak + 1 : 1;
        }

        player.lastCheckInAt = block.timestamp;
        streak = player.streak;

        emit CheckInRecorded(
            msg.sender,
            streak,
            block.timestamp,
            block.timestamp + CHECK_IN_INTERVAL,
            block.timestamp + CHECK_IN_INTERVAL + CHECK_IN_GRACE
        );
    }
}
