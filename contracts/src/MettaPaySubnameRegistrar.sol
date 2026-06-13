// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MettaPaySubnameRegistrar
/// @notice Issues `*.mettapay.eth` subnames on Base via a Durin L2 Registry.
///         Free tier: deterministic `0x{first5}.mettapay.eth` issued by the
///         backend signer for any wallet (no expiry). Paid tier: arbitrary
///         labels in lowercase `[a-z0-9-]` (3–32 chars) at $7/$17/$30 for
///         1/3/5 years, paid in USDC (1:1 from 6-decimals) or ETH (quoted via
///         the canonical Chainlink ETH/USD feed on Base).
/// @dev    Targets the real Durin L2Registry (namestonehq/durin). Subnames are
///         minted with `createSubnode(baseNode, label, owner, data)` and their
///         address records are written with the ENSIP-11 multicoin
///         `setAddr(node, coinType, addr)` for both this chain's coinType and
///         mainnet ETH (coinType 60) — mirroring Durin's reference L2Registrar.
///         This contract must be authorized on the registry via
///         `addRegistrar(address(this))` before any claim will succeed.

interface IDurinL2Registry {
    /// Parent node for this registry (e.g. namehash("mettapay.eth")).
    function baseNode() external view returns (bytes32);
    /// keccak256(parentNode, keccak256(label)) — the subname node.
    function makeNode(bytes32 parentNode, string calldata label) external view returns (bytes32);
    /// Mint the subname `label` under `node` to `owner`. Registrar-gated.
    function createSubnode(bytes32 node, string calldata label, address owner, bytes[] calldata data)
        external
        returns (bytes32);
    /// ENSIP-11 multicoin address record setter (resolver side of the registry).
    function setAddr(bytes32 node, uint256 coinType, bytes calldata addr) external;
    /// Node owner; returns address(0) for a non-existent node (does not revert).
    function owner(bytes32 node) external view returns (address);
    /// Whether `registrar` is authorized to mint subnames.
    function registrars(address registrar) external view returns (bool);
}

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IChainlinkAggregator {
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
    function decimals() external view returns (uint8);
}

contract MettaPaySubnameRegistrar {
    // ─── Constants ────────────────────────────────────────────────────────
    /// USDC token (set per network in the constructor — 6 decimals on Base).
    address public immutable USDC;
    /// Chainlink ETH/USD feed (set per network in the constructor).
    address public immutable ETH_USD_FEED;

    /// Free-tier label prefix (`0x...`) — only the backend signer can mint
    /// these and they cannot collide with paid customizations because they
    /// always start with `0x` and are exactly 7 chars (`0x` + 5 hex).
    uint256 public constant FREE_LABEL_LEN = 7;

    /// Pricing in USD, scaled to USDC's 6 decimals.
    uint256 public constant PRICE_1Y_USDC = 7_000_000;   //  $7
    uint256 public constant PRICE_3Y_USDC = 17_000_000;  // $17
    uint256 public constant PRICE_5Y_USDC = 30_000_000;  // $30

    /// Max staleness of the Chainlink answer (Base ETH/USD heartbeat is ~20m).
    uint256 public constant MAX_PRICE_AGE = 1 hours;

    uint256 public constant SECONDS_PER_YEAR = 365 days;

    /// ENSIP-11 coinType for Ethereum mainnet ETH (what most wallets resolve).
    uint256 public constant COIN_TYPE_ETH = 60;

    // ─── State ────────────────────────────────────────────────────────────
    IDurinL2Registry public immutable registry;
    /// ENSIP-11 coinType for this chain: 0x80000000 | chainId (set at deploy).
    uint256 public immutable coinType;
    address public owner;
    address public treasury;
    address public signer; // backend EOA authorized to mint free names
    bool public paused;

    struct Record {
        address holder;
        uint64 expiresAt; // 0 for free tier
        bool paid;
    }
    /// labelhash → record. labelhash is keccak256(bytes(label)) with the
    /// label already lowercased and validated by this contract.
    mapping(bytes32 => Record) public records;

    // ─── Events ───────────────────────────────────────────────────────────
    event FreeClaimed(bytes32 indexed labelhash, string label, address indexed holder);
    event PaidClaimed(
        bytes32 indexed labelhash,
        string label,
        address indexed holder,
        uint8 years_,
        address paymentToken,
        uint256 paidAmount,
        uint64 expiresAt
    );
    event Renewed(
        bytes32 indexed labelhash,
        address indexed holder,
        uint8 years_,
        address paymentToken,
        uint256 paidAmount,
        uint64 expiresAt
    );
    event AddrChanged(bytes32 indexed labelhash, address indexed holder, address newAddr);
    event TreasuryUpdated(address treasury);
    event SignerUpdated(address signer);
    event PausedSet(bool paused);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);

    // ─── Errors ───────────────────────────────────────────────────────────
    error NotOwner();
    error NotSigner();
    error NotHolder();
    error Paused();
    error BadLabel();
    error LabelTaken();
    error LabelExpired();
    error BadYears();
    error BadToken();
    error WrongValue();
    error StalePrice();
    error TransferFailed();
    error Reentrant();

    // ─── Reentrancy guard ─────────────────────────────────────────────────
    uint256 private _lock = 1;
    modifier nonReentrant() {
        if (_lock != 1) revert Reentrant();
        _lock = 2;
        _;
        _lock = 1;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }
    modifier whenLive() {
        if (paused) revert Paused();
        _;
    }

    constructor(
        IDurinL2Registry _registry,
        address _usdc,
        address _ethUsdFeed,
        address _treasury,
        address _signer
    ) {
        require(address(_registry) != address(0), "registry=0");
        require(_usdc != address(0), "usdc=0");
        require(_ethUsdFeed != address(0), "feed=0");
        require(_treasury != address(0), "treasury=0");
        require(_signer != address(0), "signer=0");
        registry = _registry;
        USDC = _usdc;
        ETH_USD_FEED = _ethUsdFeed;
        owner = msg.sender;
        treasury = _treasury;
        signer = _signer;
        coinType = 0x80000000 | block.chainid; // ENSIP-11 chain coinType
    }

    // ─── Admin ────────────────────────────────────────────────────────────
    function transferOwnership(address newOwner) external onlyOwner {
        owner = newOwner;
    }
    function setTreasury(address t) external onlyOwner { treasury = t; emit TreasuryUpdated(t); }
    function setSigner(address s) external onlyOwner { signer = s; emit SignerUpdated(s); }
    function setPaused(bool p) external onlyOwner { paused = p; emit PausedSet(p); }

    function withdraw(address token, uint256 amount) external onlyOwner nonReentrant {
        if (token == address(0)) {
            (bool ok, ) = treasury.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            if (!IERC20(token).transfer(treasury, amount)) revert TransferFailed();
        }
        emit Withdrawn(token, treasury, amount);
    }

    // ─── Public quotes ────────────────────────────────────────────────────
    function priceUsdc(uint8 years_) public pure returns (uint256) {
        if (years_ == 1) return PRICE_1Y_USDC;
        if (years_ == 3) return PRICE_3Y_USDC;
        if (years_ == 5) return PRICE_5Y_USDC;
        revert BadYears();
    }

    /// @notice ETH wei required to cover the USD price at the current
    ///         Chainlink ETH/USD rate. Reverts on stale feed.
    function priceEth(uint8 years_) public view returns (uint256) {
        uint256 usd6 = priceUsdc(years_); // 6-decimals
        (, int256 answer, , uint256 updatedAt, ) = IChainlinkAggregator(ETH_USD_FEED).latestRoundData();
        if (answer <= 0) revert StalePrice();
        if (block.timestamp - updatedAt > MAX_PRICE_AGE) revert StalePrice();
        uint8 feedDec = IChainlinkAggregator(ETH_USD_FEED).decimals();
        // wei = usd * 1e18 / (ethUsd / 10**feedDec); usd is 6-decimals → scale.
        // wei = usd6 * 10**(18 + feedDec - 6) / answer
        uint256 num = usd6 * (10 ** (uint256(18) + feedDec - 6));
        return num / uint256(answer);
    }

    // ─── Free tier (signer-only) ──────────────────────────────────────────
    /// @notice Mint the deterministic `0x{first5}` subname for `holder`.
    ///         Only callable by the backend signer so the database mirror
    ///         and on-chain state stay consistent.
    function claimFree(string calldata label, address holder) external whenLive nonReentrant {
        if (msg.sender != signer) revert NotSigner();
        _validateFreeLabel(label);
        bytes32 lh = keccak256(bytes(label));
        if (records[lh].holder != address(0)) revert LabelTaken();
        records[lh] = Record({holder: holder, expiresAt: 0, paid: false});
        _issueSubnode(label, holder);
        emit FreeClaimed(lh, label, holder);
    }

    // ─── Paid tier ────────────────────────────────────────────────────────
    /// @notice Pay for a custom label in USDC. Caller must `approve` this
    ///         contract for at least `priceUsdc(years_)` beforehand.
    function claimPaidUsdc(string calldata label, uint8 years_)
        external
        whenLive
        nonReentrant
        returns (uint64 expiresAt)
    {
        _validatePaidLabel(label);
        bytes32 lh = keccak256(bytes(label));
        _ensureAvailable(lh);
        uint256 amount = priceUsdc(years_);
        if (!IERC20(USDC).transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        expiresAt = uint64(block.timestamp + uint256(years_) * SECONDS_PER_YEAR);
        records[lh] = Record({holder: msg.sender, expiresAt: expiresAt, paid: true});
        _issueSubnode(label, msg.sender);
        emit PaidClaimed(lh, label, msg.sender, years_, USDC, amount, expiresAt);
    }

    /// @notice Pay for a custom label in ETH. Send at least `priceEth(years_)`;
    ///         overpayment is refunded.
    function claimPaidEth(string calldata label, uint8 years_)
        external
        payable
        whenLive
        nonReentrant
        returns (uint64 expiresAt)
    {
        _validatePaidLabel(label);
        bytes32 lh = keccak256(bytes(label));
        _ensureAvailable(lh);
        uint256 quote = priceEth(years_);
        if (msg.value < quote) revert WrongValue();
        expiresAt = uint64(block.timestamp + uint256(years_) * SECONDS_PER_YEAR);
        records[lh] = Record({holder: msg.sender, expiresAt: expiresAt, paid: true});
        _issueSubnode(label, msg.sender);
        if (msg.value > quote) {
            (bool ok, ) = msg.sender.call{value: msg.value - quote}("");
            if (!ok) revert TransferFailed();
        }
        emit PaidClaimed(lh, label, msg.sender, years_, address(0), quote, expiresAt);
    }

    /// @notice Extend an existing paid label. Free labels cannot be renewed
    ///         (they never expire); upgrade to paid instead.
    function renewUsdc(string calldata label, uint8 years_) external whenLive nonReentrant {
        bytes32 lh = keccak256(bytes(label));
        Record memory r = records[lh];
        if (r.holder == address(0) || !r.paid) revert NotHolder();
        uint256 amount = priceUsdc(years_);
        if (!IERC20(USDC).transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        uint64 base = r.expiresAt > block.timestamp ? r.expiresAt : uint64(block.timestamp);
        uint64 newExp = base + uint64(uint256(years_) * SECONDS_PER_YEAR);
        records[lh].expiresAt = newExp;
        emit Renewed(lh, r.holder, years_, USDC, amount, newExp);
    }

    function renewEth(string calldata label, uint8 years_) external payable whenLive nonReentrant {
        bytes32 lh = keccak256(bytes(label));
        Record memory r = records[lh];
        if (r.holder == address(0) || !r.paid) revert NotHolder();
        uint256 quote = priceEth(years_);
        if (msg.value < quote) revert WrongValue();
        uint64 base = r.expiresAt > block.timestamp ? r.expiresAt : uint64(block.timestamp);
        uint64 newExp = base + uint64(uint256(years_) * SECONDS_PER_YEAR);
        records[lh].expiresAt = newExp;
        if (msg.value > quote) {
            (bool ok, ) = msg.sender.call{value: msg.value - quote}("");
            if (!ok) revert TransferFailed();
        }
        emit Renewed(lh, r.holder, years_, address(0), quote, newExp);
    }

    // ─── Holder controls ──────────────────────────────────────────────────
    /// @notice Re-point a label at a new address. Holder-only.
    function setAddr(string calldata label, address newAddr) external whenLive {
        bytes32 lh = keccak256(bytes(label));
        Record memory r = records[lh];
        if (r.holder != msg.sender) revert NotHolder();
        if (r.paid && r.expiresAt != 0 && r.expiresAt < block.timestamp) revert LabelExpired();
        bytes32 node = registry.makeNode(registry.baseNode(), label);
        bytes memory a = abi.encodePacked(newAddr);
        registry.setAddr(node, coinType, a);
        registry.setAddr(node, COIN_TYPE_ETH, a);
        emit AddrChanged(lh, msg.sender, newAddr);
    }

    // ─── Views ────────────────────────────────────────────────────────────
    function isAvailable(string calldata label) external view returns (bool) {
        bytes32 lh = keccak256(bytes(label));
        Record memory r = records[lh];
        if (r.holder == address(0)) return true;
        if (r.paid && r.expiresAt != 0 && r.expiresAt < block.timestamp) return true;
        return false;
    }

    function recordOf(string calldata label) external view returns (Record memory) {
        return records[keccak256(bytes(label))];
    }

    // ─── Internal validation ──────────────────────────────────────────────
    function _ensureAvailable(bytes32 lh) internal view {
        Record memory r = records[lh];
        if (r.holder == address(0)) return;
        if (r.paid && r.expiresAt != 0 && r.expiresAt < block.timestamp) return;
        revert LabelTaken();
    }

    /// @dev Mint `label` under the Durin base node to `holder` and point its
    ///      address records (this chain's coinType + mainnet ETH, coinType 60)
    ///      at `holder` — mirroring Durin's reference L2Registrar. If the node
    ///      already exists (e.g. re-issue of an expired paid name), skip the
    ///      mint and just refresh the address records. Requires this contract to
    ///      be authorized on the registry via addRegistrar(address(this)).
    function _issueSubnode(string calldata label, address holder) internal {
        bytes32 base = registry.baseNode();
        bytes32 node = registry.makeNode(base, label);
        bytes memory a = abi.encodePacked(holder);
        registry.setAddr(node, coinType, a);
        registry.setAddr(node, COIN_TYPE_ETH, a);
        if (registry.owner(node) == address(0)) {
            registry.createSubnode(base, label, holder, new bytes[](0));
        }
    }

    /// Paid labels: 3–32 chars, lowercase alphanumeric + hyphen; no leading
    /// or trailing hyphen; cannot start with `0x` followed only by hex (those
    /// are reserved for the free auto-IDs).
    function _validatePaidLabel(string memory label) internal pure {
        bytes memory b = bytes(label);
        uint256 len = b.length;
        if (len < 3 || len > 32) revert BadLabel();
        if (b[0] == "-" || b[len - 1] == "-") revert BadLabel();
        bool allHexAfter0x = len >= 3 && b[0] == "0" && b[1] == "x";
        for (uint256 i = 0; i < len; i++) {
            bytes1 c = b[i];
            bool isLower = c >= "a" && c <= "z";
            bool isDigit = c >= "0" && c <= "9";
            bool isHyphen = c == "-";
            if (!(isLower || isDigit || isHyphen)) revert BadLabel();
            if (allHexAfter0x && i >= 2) {
                bool isHex = (c >= "0" && c <= "9") || (c >= "a" && c <= "f");
                if (!isHex) allHexAfter0x = false;
            }
        }
        // Reserve short 0x-hex labels (≤ 7 chars total) for the free tier.
        if (allHexAfter0x && len <= FREE_LABEL_LEN) revert BadLabel();
    }

    /// Free labels: exactly `0x` + 5 lowercase hex chars.
    function _validateFreeLabel(string memory label) internal pure {
        bytes memory b = bytes(label);
        if (b.length != FREE_LABEL_LEN) revert BadLabel();
        if (b[0] != "0" || b[1] != "x") revert BadLabel();
        for (uint256 i = 2; i < FREE_LABEL_LEN; i++) {
            bytes1 c = b[i];
            bool isHex = (c >= "0" && c <= "9") || (c >= "a" && c <= "f");
            if (!isHex) revert BadLabel();
        }
    }

    receive() external payable {}
}
