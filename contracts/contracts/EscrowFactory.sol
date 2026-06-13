// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./ProofLockEscrow.sol";

interface IERC20Factory {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

/// @title EscrowFactory
/// @notice Factory for Base ETH and Base USDC ProofLock escrows. Snapshots
///         protocol fee schedule, optional Chainlink Functions verifier, and
///         the compliance officer into every new escrow at creation time.
contract EscrowFactory {
    address public constant BASE_MAINNET_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address public constant BASE_SEPOLIA_USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    uint16 public constant BPS_DENOMINATOR = 10_000;

    enum NetworkMode { BaseMainnet, BaseSepolia }

    address public owner;
    address public defaultArbitrator;
    address public defaultVerifier;

    /// @notice Protocol fee wallet snapshotted into new escrows.
    address public feeCollector;
    /// @notice Wallet allowed to release/forfeit each escrow's consolation balance.
    address public complianceOfficer;

    uint16 public depositFeeBps;         // default 290 = 2.90%
    uint16 public settleFeeBps;          // default 190 = 1.90%
    uint16 public deadlineRefundFeeBps;  // default 300 = 3.00% (seller no-show)
    uint16 public disputeRefundFeeBps;   // default 900 = 9.00% (buyer-award split)
    uint16 public sellerConsolationBps;  // default 300 = 3.00% redirected to seller

    address public immutable usdc;
    NetworkMode public immutable networkMode;

    uint256 public totalEscrows;
    mapping(uint256 => address) public escrowsById;
    mapping(address => address[]) public escrowsByUser;

    event FactoryOwnerUpdated(address indexed previousOwner, address indexed newOwner);
    event DefaultArbitratorUpdated(address indexed previousArbitrator, address indexed newArbitrator);
    event DefaultVerifierUpdated(address indexed previousVerifier, address indexed newVerifier);
    event FeeCollectorUpdated(address indexed previousCollector, address indexed newCollector);
    event ComplianceOfficerUpdated(address indexed previousOfficer, address indexed newOfficer);
    event FeeScheduleUpdated(
        uint16 depositFeeBps,
        uint16 settleFeeBps,
        uint16 deadlineRefundFeeBps,
        uint16 disputeRefundFeeBps,
        uint16 sellerConsolationBps
    );
    event BaseEthEscrowCreated(
        uint256 indexed escrowId,
        address indexed escrow,
        address indexed buyer,
        address seller,
        uint256 amount,
        uint256 deadline,
        bytes32 termsHash,
        address verifier,
        address feeCollector,
        address complianceOfficer
    );
    event BaseUsdcEscrowCreated(
        uint256 indexed escrowId,
        address indexed escrow,
        address indexed buyer,
        address seller,
        address usdc,
        uint256 amount,
        uint256 deadline,
        bytes32 termsHash,
        address verifier,
        address feeCollector,
        address complianceOfficer
    );

    error NotOwner();
    error InvalidAddress();
    error InvalidAmount();
    error InvalidDeadline();
    error InvalidFeeBps();
    error ERC20TransferFromFailed();

    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }

    struct DeployArgs {
        address defaultArbitrator;
        NetworkMode networkMode;
        address defaultVerifier;
        address feeCollector;
        address complianceOfficer;
        uint16 depositFeeBps;
        uint16 settleFeeBps;
        uint16 deadlineRefundFeeBps;
        uint16 disputeRefundFeeBps;
        uint16 sellerConsolationBps;
        /// @notice Optional explicit USDC token. Zero = derive from networkMode
        ///         (canonical Circle USDC). Set this to point escrows at a
        ///         mintable mock token on a testnet, or a non-canonical token.
        address usdc;
    }

    constructor(DeployArgs memory a) {
        if (a.defaultArbitrator == address(0)) revert InvalidAddress();
        if (a.depositFeeBps > BPS_DENOMINATOR) revert InvalidFeeBps();
        if (a.settleFeeBps > BPS_DENOMINATOR) revert InvalidFeeBps();
        if (a.deadlineRefundFeeBps > BPS_DENOMINATOR) revert InvalidFeeBps();
        if (a.disputeRefundFeeBps > BPS_DENOMINATOR) revert InvalidFeeBps();
        if (a.sellerConsolationBps > a.disputeRefundFeeBps) revert InvalidFeeBps();
        owner = msg.sender;
        defaultArbitrator = a.defaultArbitrator;
        defaultVerifier = a.defaultVerifier;       // may be zero
        feeCollector = a.feeCollector;             // may be zero = fees disabled
        complianceOfficer = a.complianceOfficer;   // may be zero = consolation paths revert
        depositFeeBps = a.depositFeeBps;
        settleFeeBps = a.settleFeeBps;
        deadlineRefundFeeBps = a.deadlineRefundFeeBps;
        disputeRefundFeeBps = a.disputeRefundFeeBps;
        sellerConsolationBps = a.sellerConsolationBps;
        networkMode = a.networkMode;
        usdc = a.usdc != address(0)
            ? a.usdc
            : (a.networkMode == NetworkMode.BaseMainnet ? BASE_MAINNET_USDC : BASE_SEPOLIA_USDC);
    }

    function _resolveVerifier(address override_) internal view returns (address) {
        return override_ == address(0) ? defaultVerifier : override_;
    }

    function _buildArgs(
        address buyer_,
        address seller,
        ProofLockEscrow.AssetType assetType_,
        address token,
        uint256 amount,
        uint256 deadline,
        bytes32 termsHash,
        address verifier_
    ) internal view returns (ProofLockEscrow.ConstructorArgs memory) {
        return ProofLockEscrow.ConstructorArgs({
            buyer: buyer_,
            seller: seller,
            arbitrator: defaultArbitrator,
            assetType: assetType_,
            paymentToken: token,
            amount: amount,
            deadline: deadline,
            termsHash: termsHash,
            verifier: verifier_,
            feeCollector: feeCollector,
            complianceOfficer: complianceOfficer,
            depositFeeBps: depositFeeBps,
            settleFeeBps: settleFeeBps,
            deadlineRefundFeeBps: deadlineRefundFeeBps,
            disputeRefundFeeBps: disputeRefundFeeBps,
            sellerConsolationBps: sellerConsolationBps
        });
    }

    function createBaseEthEscrow(
        address seller,
        uint256 deadline,
        bytes32 termsHash,
        address verifierOverride
    ) external payable returns (address escrow) {
        if (seller == address(0)) revert InvalidAddress();
        if (seller == msg.sender) revert InvalidAddress();
        if (msg.value == 0) revert InvalidAmount();
        if (deadline <= block.timestamp) revert InvalidDeadline();

        address v = _resolveVerifier(verifierOverride);
        ProofLockEscrow.ConstructorArgs memory a = _buildArgs(
            msg.sender, seller, ProofLockEscrow.AssetType.ETH, address(0),
            msg.value, deadline, termsHash, v
        );
        escrow = address(new ProofLockEscrow{value: msg.value}(a));
        _registerEscrow(escrow, msg.sender, seller);
        emit BaseEthEscrowCreated(
            totalEscrows, escrow, msg.sender, seller, msg.value, deadline, termsHash,
            v, feeCollector, complianceOfficer
        );
    }

    function createBaseUsdcEscrow(
        address seller,
        uint256 amount,
        uint256 deadline,
        bytes32 termsHash,
        address verifierOverride
    ) external returns (address escrow) {
        if (seller == address(0)) revert InvalidAddress();
        if (seller == msg.sender) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
        if (deadline <= block.timestamp) revert InvalidDeadline();

        address v = _resolveVerifier(verifierOverride);
        ProofLockEscrow.ConstructorArgs memory a = _buildArgs(
            msg.sender, seller, ProofLockEscrow.AssetType.USDC, usdc,
            amount, deadline, termsHash, v
        );
        escrow = address(new ProofLockEscrow(a));
        bool ok = IERC20Factory(usdc).transferFrom(msg.sender, escrow, amount);
        if (!ok) revert ERC20TransferFromFailed();
        ProofLockEscrow(payable(escrow)).markFunded();
        _registerEscrow(escrow, msg.sender, seller);
        emit BaseUsdcEscrowCreated(
            totalEscrows, escrow, msg.sender, seller, usdc, amount, deadline, termsHash,
            v, feeCollector, complianceOfficer
        );
    }

    function updateOwner(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        address prev = owner; owner = newOwner;
        emit FactoryOwnerUpdated(prev, newOwner);
    }

    function updateDefaultArbitrator(address newArbitrator) external onlyOwner {
        if (newArbitrator == address(0)) revert InvalidAddress();
        address prev = defaultArbitrator; defaultArbitrator = newArbitrator;
        emit DefaultArbitratorUpdated(prev, newArbitrator);
    }

    function updateDefaultVerifier(address newVerifier) external onlyOwner {
        address prev = defaultVerifier; defaultVerifier = newVerifier;
        emit DefaultVerifierUpdated(prev, newVerifier);
    }

    function updateFeeCollector(address newCollector) external onlyOwner {
        address prev = feeCollector; feeCollector = newCollector;
        emit FeeCollectorUpdated(prev, newCollector);
    }

    function updateComplianceOfficer(address newOfficer) external onlyOwner {
        address prev = complianceOfficer; complianceOfficer = newOfficer;
        emit ComplianceOfficerUpdated(prev, newOfficer);
    }

    function updateFeeSchedule(
        uint16 _depositFeeBps,
        uint16 _settleFeeBps,
        uint16 _deadlineRefundFeeBps,
        uint16 _disputeRefundFeeBps,
        uint16 _sellerConsolationBps
    ) external onlyOwner {
        if (_depositFeeBps > BPS_DENOMINATOR) revert InvalidFeeBps();
        if (_settleFeeBps > BPS_DENOMINATOR) revert InvalidFeeBps();
        if (_deadlineRefundFeeBps > BPS_DENOMINATOR) revert InvalidFeeBps();
        if (_disputeRefundFeeBps > BPS_DENOMINATOR) revert InvalidFeeBps();
        if (_sellerConsolationBps > _disputeRefundFeeBps) revert InvalidFeeBps();
        depositFeeBps = _depositFeeBps;
        settleFeeBps = _settleFeeBps;
        deadlineRefundFeeBps = _deadlineRefundFeeBps;
        disputeRefundFeeBps = _disputeRefundFeeBps;
        sellerConsolationBps = _sellerConsolationBps;
        emit FeeScheduleUpdated(
            _depositFeeBps, _settleFeeBps,
            _deadlineRefundFeeBps, _disputeRefundFeeBps, _sellerConsolationBps
        );
    }

    function getEscrowsByUser(address user) external view returns (address[] memory) {
        return escrowsByUser[user];
    }

    function _registerEscrow(address escrow, address buyer_, address seller) internal {
        totalEscrows += 1;
        escrowsById[totalEscrows] = escrow;
        escrowsByUser[buyer_].push(escrow);
        escrowsByUser[seller].push(escrow);
    }
}
