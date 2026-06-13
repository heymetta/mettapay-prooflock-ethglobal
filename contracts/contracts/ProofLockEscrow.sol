// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ProofLockEscrow
/// @notice Base ETH and Base USDC escrow contract for MettaPays ProofLock.
/// @dev Each escrow is deployed by EscrowFactory. Implements Chainlink
///      AutomationCompatibleInterface so the Chainlink Automation network can
///      auto-refund the buyer once the deadline passes without approval.
///      Optionally references a ProofLockVerifier (Chainlink Functions
///      consumer) so the UI can surface a verified flag — buyer still signs
///      approveAndRelease.
///
///      Protocol fees (snapshotted at creation time, in basis points):
///        - depositFeeBps         charged once on funding, sent to feeCollector
///        - settleFeeBps          charged on every payout to the seller
///        - deadlineRefundFeeBps  charged on refundAfterDeadline / refundIfExpired
///                                (seller no-show, smaller flat fee to feeCollector)
///        - disputeRefundFeeBps   charged on resolveDispute buyer-award
///                                (split between feeCollector and a seller
///                                 consolation balance held in-contract until
///                                 complianceOfficer releases or forfeits it)
///        - sellerConsolationBps  portion of the disputeRefundFeeBps redirected
///                                to the seller (held pending compliance review).
///        sellerCancelAndRefund() is fee-free (goodwill).

interface IERC20ProofLock {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
}

interface AutomationCompatibleInterface {
    function checkUpkeep(bytes calldata checkData)
        external
        returns (bool upkeepNeeded, bytes memory performData);
    function performUpkeep(bytes calldata performData) external;
}

interface IProofLockVerifier {
    struct VerificationResult {
        bool exists;
        bool verified;
        string message;
        uint256 checkedAt;
        bytes32 lastRequestId;
        address escrow;
    }
    function getResult(address escrow) external view returns (VerificationResult memory);
}

contract ProofLockEscrow is AutomationCompatibleInterface {
    enum AssetType { ETH, USDC }

    enum Status {
        Created,
        Funded,
        ProofSubmitted,
        Approved,
        Released,
        Disputed,
        Refunded
    }

    uint16 public constant BPS_DENOMINATOR = 10_000;

    address public immutable factory;
    address public immutable buyer;
    address public immutable seller;
    address public immutable arbitrator;

    AssetType public immutable assetType;
    address public immutable paymentToken;

    /// @notice Gross amount originally deposited by the buyer.
    uint256 public immutable amount;
    uint256 public immutable deadline;
    bytes32 public immutable termsHash;

    /// @notice Optional Chainlink Functions verifier. Zero address = none.
    address public immutable verifier;

    /// @notice Protocol fee collector wallet (may be zero = fees disabled).
    address public immutable feeCollector;
    /// @notice Wallet allowed to release/forfeit the seller consolation balance.
    address public immutable complianceOfficer;

    uint16 public immutable depositFeeBps;
    uint16 public immutable settleFeeBps;
    uint16 public immutable deadlineRefundFeeBps;
    uint16 public immutable disputeRefundFeeBps;
    uint16 public immutable sellerConsolationBps;

    /// @notice Net principal after the deposit fee was taken. All later
    ///         payouts (release / refund / dispute) are computed against this.
    uint256 public netAmount;

    /// @notice Seller consolation balance accrued from disputed buyer-award
    ///         refunds, held inside this contract until the compliance officer
    ///         calls releaseSellerConsolation() or forfeitSellerConsolation().
    uint256 public sellerConsolationAccrued;
    /// @notice One-shot flag flipped when the compliance officer acts.
    bool public sellerConsolationResolved;

    Status public status;

    bytes32 public proofHash;
    string public proofURI;

    bool private locked;

    event EscrowCreated(
        address indexed escrow,
        address indexed buyer,
        address indexed seller,
        address arbitrator,
        AssetType assetType,
        address paymentToken,
        uint256 amount,
        uint256 deadline,
        bytes32 termsHash,
        address verifier,
        address feeCollector,
        address complianceOfficer
    );
    event EscrowFeeSchedule(
        address indexed escrow,
        uint16 depositFeeBps,
        uint16 settleFeeBps,
        uint16 deadlineRefundFeeBps,
        uint16 disputeRefundFeeBps,
        uint16 sellerConsolationBps
    );
    event EscrowFunded(address indexed escrow, AssetType assetType, uint256 grossAmount, uint256 netAmount);

    event DepositFeeCharged(address indexed escrow, address indexed feeCollector, AssetType assetType, uint256 fee);
    event SettleFeeCharged(address indexed escrow, address indexed feeCollector, AssetType assetType, uint256 fee);
    event DeadlineRefundFeeCharged(
        address indexed escrow,
        address indexed feeCollector,
        AssetType assetType,
        uint256 fee,
        uint256 buyerNetRefund
    );
    event DisputeRefundFeeCharged(
        address indexed escrow,
        address indexed feeCollector,
        address indexed seller,
        AssetType assetType,
        uint256 platformFee,
        uint256 sellerConsolation,
        uint256 buyerNetRefund
    );
    event SellerConsolationAccrued(
        address indexed escrow,
        address indexed seller,
        AssetType assetType,
        uint256 amount,
        uint256 totalAccrued
    );
    event SellerConsolationReleased(
        address indexed escrow,
        address indexed complianceOfficer,
        address indexed seller,
        AssetType assetType,
        uint256 amount
    );
    event SellerConsolationForfeited(
        address indexed escrow,
        address indexed complianceOfficer,
        address indexed feeCollector,
        AssetType assetType,
        uint256 amount
    );

    event ProofSubmitted(address indexed escrow, address indexed seller, bytes32 proofHash, string proofURI);
    event Approved(address indexed escrow, address indexed buyer);
    event Released(address indexed escrow, address indexed seller, AssetType assetType, uint256 amount);
    event Disputed(address indexed escrow, address indexed buyer, string reason);
    event DisputeResolved(address indexed escrow, address indexed arbitrator, uint256 buyerAward, uint256 sellerAward);
    event Refunded(address indexed escrow, address indexed buyer, AssetType assetType, uint256 amount);
    event AutoRefundTriggered(address indexed escrow, address indexed caller, AssetType assetType, uint256 amount);

    error NotFactory();
    error NotBuyer();
    error NotSeller();
    error NotArbitrator();
    error NotComplianceOfficer();
    error InvalidAddress();
    error InvalidAmount();
    error InvalidDeadline();
    error InvalidStatus();
    error DeadlinePassed();
    error DeadlineNotPassed();
    error NativeTransferFailed();
    error ERC20TransferFailed();
    error ReentrancyDetected();
    error InvalidResolution();
    error InvalidFeeBps();
    error NothingToResolve();
    error AlreadyResolved();

    modifier onlyFactory() { if (msg.sender != factory) revert NotFactory(); _; }
    modifier onlyBuyer() { if (msg.sender != buyer) revert NotBuyer(); _; }
    modifier onlySeller() { if (msg.sender != seller) revert NotSeller(); _; }
    modifier onlyArbitrator() { if (msg.sender != arbitrator) revert NotArbitrator(); _; }
    modifier onlyCompliance() {
        if (msg.sender != complianceOfficer || complianceOfficer == address(0)) {
            revert NotComplianceOfficer();
        }
        _;
    }
    modifier nonReentrant() {
        if (locked) revert ReentrancyDetected();
        locked = true; _; locked = false;
    }

    struct ConstructorArgs {
        address buyer;
        address seller;
        address arbitrator;
        AssetType assetType;
        address paymentToken;
        uint256 amount;
        uint256 deadline;
        bytes32 termsHash;
        address verifier;
        address feeCollector;
        address complianceOfficer;
        uint16 depositFeeBps;
        uint16 settleFeeBps;
        uint16 deadlineRefundFeeBps;
        uint16 disputeRefundFeeBps;
        uint16 sellerConsolationBps;
    }

    constructor(ConstructorArgs memory a) payable {
        if (a.buyer == address(0)) revert InvalidAddress();
        if (a.seller == address(0)) revert InvalidAddress();
        if (a.arbitrator == address(0)) revert InvalidAddress();
        if (a.buyer == a.seller) revert InvalidAddress();
        if (a.amount == 0) revert InvalidAmount();
        if (a.deadline <= block.timestamp) revert InvalidDeadline();
        if (a.depositFeeBps > BPS_DENOMINATOR) revert InvalidFeeBps();
        if (a.settleFeeBps > BPS_DENOMINATOR) revert InvalidFeeBps();
        if (a.deadlineRefundFeeBps > BPS_DENOMINATOR) revert InvalidFeeBps();
        if (a.disputeRefundFeeBps > BPS_DENOMINATOR) revert InvalidFeeBps();
        if (a.sellerConsolationBps > a.disputeRefundFeeBps) revert InvalidFeeBps();

        factory = msg.sender;
        buyer = a.buyer;
        seller = a.seller;
        arbitrator = a.arbitrator;
        assetType = a.assetType;
        paymentToken = a.paymentToken;
        amount = a.amount;
        deadline = a.deadline;
        termsHash = a.termsHash;
        verifier = a.verifier;
        feeCollector = a.feeCollector;
        complianceOfficer = a.complianceOfficer;
        depositFeeBps = a.depositFeeBps;
        settleFeeBps = a.settleFeeBps;
        deadlineRefundFeeBps = a.deadlineRefundFeeBps;
        disputeRefundFeeBps = a.disputeRefundFeeBps;
        sellerConsolationBps = a.sellerConsolationBps;

        if (a.assetType == AssetType.ETH) {
            if (a.paymentToken != address(0)) revert InvalidAddress();
            if (msg.value != a.amount) revert InvalidAmount();
            uint256 fee = _takeDepositFee(a.amount);
            netAmount = a.amount - fee;
            status = Status.Funded;
        } else {
            if (a.paymentToken == address(0)) revert InvalidAddress();
            if (msg.value != 0) revert InvalidAmount();
            status = Status.Created;
        }

        emit EscrowCreated(
            address(this), a.buyer, a.seller, a.arbitrator,
            a.assetType, a.paymentToken, a.amount, a.deadline, a.termsHash,
            a.verifier, a.feeCollector, a.complianceOfficer
        );
        emit EscrowFeeSchedule(
            address(this),
            a.depositFeeBps, a.settleFeeBps,
            a.deadlineRefundFeeBps, a.disputeRefundFeeBps, a.sellerConsolationBps
        );
        if (a.assetType == AssetType.ETH) {
            emit EscrowFunded(address(this), a.assetType, a.amount, netAmount);
        }
    }

    function markFunded() external onlyFactory {
        if (assetType != AssetType.USDC) revert InvalidStatus();
        if (status != Status.Created) revert InvalidStatus();
        uint256 bal = IERC20ProofLock(paymentToken).balanceOf(address(this));
        if (bal < amount) revert InvalidAmount();
        uint256 fee = _takeDepositFee(amount);
        netAmount = amount - fee;
        status = Status.Funded;
        emit EscrowFunded(address(this), assetType, amount, netAmount);
    }

    function submitProof(bytes32 _proofHash, string calldata _proofURI) external onlySeller {
        if (status != Status.Funded) revert InvalidStatus();
        if (block.timestamp > deadline) revert DeadlinePassed();
        if (_proofHash == bytes32(0)) revert InvalidAmount();
        proofHash = _proofHash;
        proofURI = _proofURI;
        status = Status.ProofSubmitted;
        emit ProofSubmitted(address(this), seller, _proofHash, _proofURI);
    }

    function approveAndRelease() external onlyBuyer nonReentrant {
        if (status != Status.ProofSubmitted) revert InvalidStatus();
        status = Status.Approved;
        emit Approved(address(this), buyer);
        status = Status.Released;
        uint256 payout = _paySellerWithFee(netAmount);
        emit Released(address(this), seller, assetType, payout);
    }

    function dispute(string calldata reason) external onlyBuyer {
        if (status != Status.ProofSubmitted) revert InvalidStatus();
        status = Status.Disputed;
        emit Disputed(address(this), buyer, reason);
    }

    function resolveDispute(uint256 buyerAward, uint256 sellerAward) external onlyArbitrator nonReentrant {
        if (status != Status.Disputed) revert InvalidStatus();
        if (buyerAward + sellerAward != netAmount) revert InvalidResolution();
        status = Status.Released;
        if (buyerAward > 0) _payBuyerDisputed(buyerAward);
        if (sellerAward > 0) _paySellerWithFee(sellerAward);
        emit DisputeResolved(address(this), arbitrator, buyerAward, sellerAward);
    }

    function refundAfterDeadline() external onlyBuyer nonReentrant {
        if (status != Status.Funded) revert InvalidStatus();
        if (block.timestamp <= deadline) revert DeadlineNotPassed();
        status = Status.Refunded;
        uint256 payout = _payBuyerFlat(netAmount, deadlineRefundFeeBps, true);
        emit Refunded(address(this), buyer, assetType, payout);
    }

    function sellerCancelAndRefund() external onlySeller nonReentrant {
        if (status != Status.Funded) revert InvalidStatus();
        status = Status.Refunded;
        // Goodwill refund — no extra fee. Deposit fee already taken and non-refundable.
        _pay(buyer, netAmount);
        emit Refunded(address(this), buyer, assetType, netAmount);
    }

    // ---------------------------------------------------------------------
    // Compliance — release / forfeit the in-contract seller consolation balance
    // ---------------------------------------------------------------------

    function releaseSellerConsolation() external onlyCompliance nonReentrant {
        if (sellerConsolationResolved) revert AlreadyResolved();
        uint256 bal = sellerConsolationAccrued;
        if (bal == 0) revert NothingToResolve();
        sellerConsolationAccrued = 0;
        sellerConsolationResolved = true;
        _pay(seller, bal);
        emit SellerConsolationReleased(address(this), msg.sender, seller, assetType, bal);
    }

    function forfeitSellerConsolation() external onlyCompliance nonReentrant {
        if (sellerConsolationResolved) revert AlreadyResolved();
        uint256 bal = sellerConsolationAccrued;
        if (bal == 0) revert NothingToResolve();
        if (feeCollector == address(0)) revert InvalidAddress();
        sellerConsolationAccrued = 0;
        sellerConsolationResolved = true;
        _pay(feeCollector, bal);
        emit SellerConsolationForfeited(address(this), msg.sender, feeCollector, assetType, bal);
    }

    // ---------------------------------------------------------------------
    // Chainlink Functions — read-only verifier flag (informational)
    // ---------------------------------------------------------------------

    function isVerifierApproved() external view returns (bool) {
        if (verifier == address(0)) return false;
        try IProofLockVerifier(verifier).getResult(address(this)) returns (
            IProofLockVerifier.VerificationResult memory r
        ) {
            return r.verified;
        } catch {
            return false;
        }
    }

    // ---------------------------------------------------------------------
    // Chainlink Automation — auto-refund after deadline
    // ---------------------------------------------------------------------

    function refundIfExpired() public nonReentrant {
        if (status != Status.Funded) revert InvalidStatus();
        if (block.timestamp <= deadline) revert DeadlineNotPassed();
        status = Status.Refunded;
        uint256 payout = _payBuyerFlat(netAmount, deadlineRefundFeeBps, true);
        emit Refunded(address(this), buyer, assetType, payout);
        emit AutoRefundTriggered(address(this), msg.sender, assetType, payout);
    }

    function checkUpkeep(bytes calldata /* checkData */)
        external
        view
        returns (bool upkeepNeeded, bytes memory performData)
    {
        upkeepNeeded = (status == Status.Funded) && (block.timestamp > deadline);
        performData = bytes("");
    }

    function performUpkeep(bytes calldata /* performData */) external override {
        refundIfExpired();
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    function _takeDepositFee(uint256 gross) internal returns (uint256 fee) {
        if (feeCollector == address(0) || depositFeeBps == 0) return 0;
        fee = (gross * depositFeeBps) / BPS_DENOMINATOR;
        if (fee == 0) return 0;
        _pay(feeCollector, fee);
        emit DepositFeeCharged(address(this), feeCollector, assetType, fee);
    }

    function _paySellerWithFee(uint256 gross) internal returns (uint256 payout) {
        uint256 fee = 0;
        if (feeCollector != address(0) && settleFeeBps > 0) {
            fee = (gross * settleFeeBps) / BPS_DENOMINATOR;
            if (fee > 0) {
                _pay(feeCollector, fee);
                emit SettleFeeCharged(address(this), feeCollector, assetType, fee);
            }
        }
        payout = gross - fee;
        if (payout > 0) _pay(seller, payout);
    }

    /// @dev Flat-fee buyer refund used by deadline paths. Whole fee → feeCollector.
    function _payBuyerFlat(uint256 gross, uint16 feeBps, bool emitDeadlineEvent)
        internal
        returns (uint256 payout)
    {
        uint256 fee = 0;
        if (feeCollector != address(0) && feeBps > 0) {
            fee = (gross * feeBps) / BPS_DENOMINATOR;
            if (fee > 0) _pay(feeCollector, fee);
        }
        payout = gross - fee;
        if (payout > 0) _pay(buyer, payout);
        if (emitDeadlineEvent) {
            emit DeadlineRefundFeeCharged(address(this), feeCollector, assetType, fee, payout);
        }
    }

    /// @dev Disputed buyer-award refund. disputeRefundFeeBps is split:
    ///        platformBps = disputeRefundFeeBps - sellerConsolationBps → feeCollector
    ///        sellerConsolationBps → in-contract `sellerConsolationAccrued`
    ///                                (released or forfeited later by compliance)
    function _payBuyerDisputed(uint256 gross) internal returns (uint256 payout) {
        uint256 totalFee = 0;
        uint256 consolation = 0;
        uint256 platformFee = 0;
        if (disputeRefundFeeBps > 0) {
            totalFee = (gross * disputeRefundFeeBps) / BPS_DENOMINATOR;
            if (sellerConsolationBps > 0) {
                consolation = (gross * sellerConsolationBps) / BPS_DENOMINATOR;
                if (consolation > totalFee) consolation = totalFee;
            }
            platformFee = totalFee - consolation;
        }
        if (platformFee > 0 && feeCollector != address(0)) {
            _pay(feeCollector, platformFee);
        } else {
            // No fee collector → fold the platform portion back into buyer payout.
            // Consolation still accrues inside this contract for compliance review.
            platformFee = 0;
        }
        if (consolation > 0) {
            sellerConsolationAccrued += consolation;
            emit SellerConsolationAccrued(
                address(this), seller, assetType, consolation, sellerConsolationAccrued
            );
        }
        payout = gross - platformFee - consolation;
        if (payout > 0) _pay(buyer, payout);
        emit DisputeRefundFeeCharged(
            address(this), feeCollector, seller, assetType, platformFee, consolation, payout
        );
    }

    function _pay(address to, uint256 value) internal {
        if (assetType == AssetType.ETH) {
            (bool success, ) = payable(to).call{value: value}("");
            if (!success) revert NativeTransferFailed();
        } else {
            bool success = IERC20ProofLock(paymentToken).transfer(to, value);
            if (!success) revert ERC20TransferFailed();
        }
    }

    receive() external payable { revert InvalidStatus(); }
}
