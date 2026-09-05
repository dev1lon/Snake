// SPDX-License-Identifier: MIT
// 0.8.20 and up: nothing here needs anything newer, and it keeps an editor's
// bundled compiler happy. Base has supported PUSH0 since Canyon, so the
// shanghai target this compiles to by default is fine.
pragma solidity ^0.8.20;

/// The slice of a Chainlink feed this contract uses.
interface AggregatorV3Interface {
    function decimals() external view returns (uint8);

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @title SnakeArcade
/// @notice Records Base Snake runs and sells revives. Replaces SnakeRecords,
///         which had no notion of a game mode, no level and no way to charge
///         for anything.
///
/// Three things drove the design:
///
/// 1. **Classic and Levels never share a record.** A run carries its mode, and
///    a classic run is always stored at level 0, so a classic score can never
///    land on top of a level score that happens to use the same board size.
///
/// 2. **Prices are dollars, not ether.** A revive is a dollar; that is the
///    product decision. Storing wei would mean the price drifts with every
///    move of the market, so prices are held in cents and converted at payment
///    time through the Chainlink ETH/USD feed.
///
/// 3. **Overpayment comes back.** The quote a player sees is a block or two
///    old by the time it lands, so the frontend sends a little extra and the
///    contract returns the difference. Nobody is charged more than the price.
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

    // ── Prices, in US cents ───────────────────────────────────────────────
    /// One revive, sold at the moment of the crash. 100 = $1.00.
    uint32 public singleRevivePriceCents;
    /// One pack of `packRevives` revives, sold in the shop. 1000 = $10.00.
    uint32 public packRevivePriceCents;
    /// Charged for writing a run onchain — in both modes alike. 10 = $0.10.
    uint32 public recordPriceCents;
    uint16 public packRevives;

    // ── Oracle ────────────────────────────────────────────────────────────
    AggregatorV3Interface public priceFeed;

    /// How old the feed's answer may be before payments stop. Chainlink's
    /// ETH/USD feeds update on deviation *or* on a heartbeat, so this has to be
    /// generous enough to survive a quiet market: too tight and a calm day
    /// takes the shop offline.
    uint256 public maxPriceAge;

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
        uint32 singleRevivePriceCents,
        uint32 packRevivePriceCents,
        uint16 packRevives,
        uint32 recordPriceCents
    );

    event PriceFeedUpdated(address indexed feed, uint256 maxPriceAge);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event Withdrawn(address indexed to, uint256 amount);

    error NotOwner();
    error ZeroAddress();
    error InvalidMode();
    error InvalidLevel();
    error InvalidCells();
    error InvalidPackSize();
    error InvalidPriceAge();
    error NothingToBuy();
    error Underpaid(uint256 required);
    error TransferFailed();
    error StalePrice(uint256 updatedAt);
    error InvalidPrice(int256 answer);

    modifier onlyOwner() {
        if (msg.sender != owner) {
            revert NotOwner();
        }
        _;
    }

    /// @param priceFeed_ Chainlink ETH/USD aggregator. On Base mainnet that is
    ///        0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70 (8 decimals).
    /// @param maxPriceAge_ seconds an answer stays usable
    /// @param singleRevivePriceCents_ cents for one revive (100 = $1)
    /// @param packRevivePriceCents_ cents for one pack (1000 = $10)
    /// @param packRevives_ revives in a pack
    /// @param recordPriceCents_ cents to save a run (10 = $0.10)
    constructor(
        address priceFeed_,
        uint256 maxPriceAge_,
        uint32 singleRevivePriceCents_,
        uint32 packRevivePriceCents_,
        uint16 packRevives_,
        uint32 recordPriceCents_
    ) {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);

        _setPriceFeed(priceFeed_, maxPriceAge_);
        _setPrices(
            singleRevivePriceCents_,
            packRevivePriceCents_,
            packRevives_,
            recordPriceCents_
        );
    }

    // ── Quotes ────────────────────────────────────────────────────────────

    /// @notice The feed's current answer, rejected if stale or nonsensical.
    function ethUsdPrice() public view returns (uint256 price, uint8 feedDecimals) {
        (, int256 answer, , uint256 updatedAt, ) = priceFeed.latestRoundData();

        if (answer <= 0) {
            revert InvalidPrice(answer);
        }

        if (updatedAt == 0 || block.timestamp - updatedAt > maxPriceAge) {
            revert StalePrice(updatedAt);
        }

        return (uint256(answer), priceFeed.decimals());
    }

    /// @notice What `cents` costs in wei right now.
    function weiForCents(uint256 cents) public view returns (uint256) {
        if (cents == 0) {
            return 0;
        }

        (uint256 price, uint8 feedDecimals) = ethUsdPrice();

        // cents / 100 dollars, divided by dollars-per-ETH, scaled to wei. The
        // feed's own decimals cancel out of the division.
        return (cents * 1e18 * (10 ** feedDecimals)) / (price * 100);
    }

    function quoteRecord() external view returns (uint256) {
        return weiForCents(recordPriceCents);
    }

    function quoteSingleRevive() external view returns (uint256) {
        return weiForCents(singleRevivePriceCents);
    }

    function quotePacks(uint16 packs) external view returns (uint256) {
        return weiForCents(uint256(packs) * packRevivePriceCents);
    }

    // ── Playing ───────────────────────────────────────────────────────────

    /// @notice Write a finished run. Costs `recordPriceCents` in either mode;
    ///         anything paid above the current conversion is sent straight
    ///         back.
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

        uint256 price = weiForCents(recordPriceCents);

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
        _buy(1, weiForCents(singleRevivePriceCents));
    }

    /// @notice Packs from the shop. Any number of them.
    function buyRevivePacks(uint16 packs) external payable {
        if (packs == 0) {
            revert NothingToBuy();
        }

        _buy(
            uint256(packs) * uint256(packRevives),
            weiForCents(uint256(packs) * packRevivePriceCents)
        );
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
        uint32 singleRevivePriceCents_,
        uint32 packRevivePriceCents_,
        uint16 packRevives_,
        uint32 recordPriceCents_
    ) external onlyOwner {
        _setPrices(
            singleRevivePriceCents_,
            packRevivePriceCents_,
            packRevives_,
            recordPriceCents_
        );
    }

    /// @notice Point at a different aggregator, or change how stale an answer
    ///         may be. The new feed has to answer before it is accepted.
    function setPriceFeed(address priceFeed_, uint256 maxPriceAge_) external onlyOwner {
        _setPriceFeed(priceFeed_, maxPriceAge_);
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
        uint32 singleRevivePriceCents_,
        uint32 packRevivePriceCents_,
        uint16 packRevives_,
        uint32 recordPriceCents_
    ) private {
        if (packRevives_ == 0) {
            revert InvalidPackSize();
        }

        singleRevivePriceCents = singleRevivePriceCents_;
        packRevivePriceCents = packRevivePriceCents_;
        packRevives = packRevives_;
        recordPriceCents = recordPriceCents_;

        emit PricesUpdated(
            singleRevivePriceCents_,
            packRevivePriceCents_,
            packRevives_,
            recordPriceCents_
        );
    }

    function _setPriceFeed(address priceFeed_, uint256 maxPriceAge_) private {
        if (priceFeed_ == address(0)) {
            revert ZeroAddress();
        }

        // A day of silence is already unusual for ETH/USD; anything shorter
        // than an hour risks taking the shop down over nothing.
        if (maxPriceAge_ < 1 hours || maxPriceAge_ > 7 days) {
            revert InvalidPriceAge();
        }

        priceFeed = AggregatorV3Interface(priceFeed_);
        maxPriceAge = maxPriceAge_;

        // Fail here rather than at the first player's payment: a feed that
        // can't answer now is not one to switch to.
        ethUsdPrice();

        emit PriceFeedUpdated(priceFeed_, maxPriceAge_);
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
