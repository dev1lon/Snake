// SPDX-License-Identifier: MIT
// 0.8.20 and up: nothing here needs anything newer, and it keeps an editor's
// bundled compiler happy. Base has supported PUSH0 since Canyon, so the
// shanghai target this compiles to by default is fine.
pragma solidity ^0.8.20;

/// @title SnakeArcade
/// @notice Records Base Snake runs and sells revives. Replaces SnakeRecords,
///         which had no notion of a game mode, no level and no way to charge
///         for anything.
///
/// Two things drove the design:
///
/// 1. **Classic and Levels never share a record.** A run carries its mode, and
///    a classic run is always stored at level 0, so a classic score can never
///    land on top of a level score that happens to use the same board size.
///
/// 2. **Every price is a variable, not a constant.** These are dollar decisions
///    paid in ETH, and ETH moves — pinning wei into the bytecode would mean
///    redeploying every time the market does something. The owner can retune
///    them; nothing else about the contract can be changed.
contract SnakeArcade {
    // ── Modes ─────────────────────────────────────────────────────────────
    uint8 public constant MODE_CLASSIC = 0;
    uint8 public constant MODE_LEVELS = 1;

    /// Largest board the game ships is 32x32, with room to grow.
    uint16 public constant MAX_CELLS = 4096;
    /// Levels are 1-based; the ladder is six long today.
    uint16 public constant MAX_LEVEL = 64;

    // ── Ownership ─────────────────────────────────────────────────────────
    address public owner;

    // ── Prices, all in wei ────────────────────────────────────────────────
    /// One revive, sold at the moment of the crash.
    uint256 public singleRevivePrice;
    /// One pack of `packRevives` revives, sold in the shop.
    uint256 public packRevivePrice;
    uint16 public packRevives;
    /// Charged for writing a run onchain — in both modes alike.
    uint256 public recordPrice;

    struct Best {
        uint128 score;
        uint16 cells;
        uint32 moves;
        uint40 updatedAt;
    }

    /// player => mode => level => their best run on that exact board.
    mapping(address => mapping(uint8 => mapping(uint16 => Best))) public bests;
    /// How many runs a player has written, and the source of their run ids.
    mapping(address => uint256) public runsRecorded;
    /// Revives bought, ever. Consumption is tracked off-chain against this
    /// number — a transaction per death would cost more than a revive is worth.
    mapping(address => uint256) public revivesPurchased;

    event RunRecorded(
        address indexed player,
        uint8 indexed mode,
        uint16 indexed level,
        uint256 runId,
        uint256 score,
        uint16 cells,
        uint32 moves,
        bool won,
        bool personalBest,
        uint256 paid,
        uint256 recordedAt
    );

    event RevivesPurchased(
        address indexed player,
        uint256 amount,
        uint256 paid,
        uint256 totalPurchased,
        uint256 purchasedAt
    );

    event PricesUpdated(
        uint256 singleRevivePrice,
        uint256 packRevivePrice,
        uint16 packRevives,
        uint256 recordPrice
    );

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event Withdrawn(address indexed to, uint256 amount);

    error NotOwner();
    error ZeroAddress();
    error InvalidMode();
    error InvalidLevel();
    error InvalidCells();
    error InvalidPackSize();
    error NothingToBuy();
    error Underpaid(uint256 required);
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) {
            revert NotOwner();
        }
        _;
    }

    /// @param singleRevivePrice_ wei charged for one revive
    /// @param packRevivePrice_ wei charged for one pack
    /// @param packRevives_ revives in a pack
    /// @param recordPrice_ wei charged for writing a run
    /// @dev Nothing is defaulted on purpose: the deployer states every price,
    ///      so no run of a deploy script can quietly ship the wrong one.
    constructor(
        uint256 singleRevivePrice_,
        uint256 packRevivePrice_,
        uint16 packRevives_,
        uint256 recordPrice_
    ) {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
        _setPrices(singleRevivePrice_, packRevivePrice_, packRevives_, recordPrice_);
    }

    // ── Playing ───────────────────────────────────────────────────────────

    /// @notice Write a finished run. Costs `recordPrice` in either mode;
    ///         anything paid above it is sent straight back, so a price change
    ///         between quote and confirmation costs the player nothing.
    /// @param mode MODE_CLASSIC or MODE_LEVELS
    /// @param level 0 for classic, 1..MAX_LEVEL for the ladder
    function recordRun(
        uint8 mode,
        uint16 level,
        uint256 score,
        uint16 cells,
        uint32 moves,
        bool won
    ) external payable returns (uint256 runId) {
        if (mode > MODE_LEVELS) {
            revert InvalidMode();
        }

        // Classic has no ladder. Forcing it to level 0 is what keeps the two
        // modes' records apart for good.
        if (mode == MODE_CLASSIC) {
            if (level != 0) {
                revert InvalidLevel();
            }
        } else if (level == 0 || level > MAX_LEVEL) {
            revert InvalidLevel();
        }

        if (cells == 0 || cells > MAX_CELLS) {
            revert InvalidCells();
        }

        uint256 price = recordPrice;

        if (msg.value < price) {
            revert Underpaid(price);
        }

        runId = ++runsRecorded[msg.sender];

        Best storage best = bests[msg.sender][mode][level];
        bool personalBest = score > best.score || (score == best.score && cells > best.cells);

        if (personalBest) {
            best.score = uint128(score);
            best.cells = cells;
            best.moves = moves;
            best.updatedAt = uint40(block.timestamp);
        }

        emit RunRecorded(
            msg.sender,
            mode,
            level,
            runId,
            score,
            cells,
            moves,
            won,
            personalBest,
            price,
            block.timestamp
        );

        _refund(price);
    }

    // ── Buying revives ────────────────────────────────────────────────────

    /// @notice The single revive offered on the death screen.
    function buySingleRevive() external payable {
        _buy(1, singleRevivePrice);
    }

    /// @notice Packs from the shop. Any number of them.
    function buyRevivePacks(uint16 packs) external payable {
        if (packs == 0) {
            revert NothingToBuy();
        }

        _buy(uint256(packs) * uint256(packRevives), uint256(packs) * packRevivePrice);
    }

    /// @notice What `packs` packs cost right now, for the UI to quote.
    function quotePacks(uint16 packs) external view returns (uint256) {
        return uint256(packs) * packRevivePrice;
    }

    function _buy(uint256 amount, uint256 price) private {
        if (amount == 0) {
            revert NothingToBuy();
        }

        if (msg.value < price) {
            revert Underpaid(price);
        }

        uint256 total = revivesPurchased[msg.sender] + amount;
        revivesPurchased[msg.sender] = total;

        emit RevivesPurchased(msg.sender, amount, price, total, block.timestamp);

        _refund(price);
    }

    // ── Owner ─────────────────────────────────────────────────────────────

    function setPrices(
        uint256 singleRevivePrice_,
        uint256 packRevivePrice_,
        uint16 packRevives_,
        uint256 recordPrice_
    ) external onlyOwner {
        _setPrices(singleRevivePrice_, packRevivePrice_, packRevives_, recordPrice_);
    }

    function withdraw(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) {
            revert ZeroAddress();
        }

        emit Withdrawn(to, amount);

        (bool sent, ) = to.call{value: amount}("");

        if (!sent) {
            revert TransferFailed();
        }
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) {
            revert ZeroAddress();
        }

        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // ── Internals ─────────────────────────────────────────────────────────

    function _setPrices(
        uint256 singleRevivePrice_,
        uint256 packRevivePrice_,
        uint16 packRevives_,
        uint256 recordPrice_
    ) private {
        if (packRevives_ == 0) {
            revert InvalidPackSize();
        }

        singleRevivePrice = singleRevivePrice_;
        packRevivePrice = packRevivePrice_;
        packRevives = packRevives_;
        recordPrice = recordPrice_;

        emit PricesUpdated(singleRevivePrice_, packRevivePrice_, packRevives_, recordPrice_);
    }

    /// Sends back whatever was paid above the price. State is already final
    /// when this runs, so a re-entrant call finds nothing left to exploit.
    function _refund(uint256 price) private {
        uint256 excess = msg.value - price;

        if (excess == 0) {
            return;
        }

        (bool sent, ) = msg.sender.call{value: excess}("");

        if (!sent) {
            revert TransferFailed();
        }
    }
}
