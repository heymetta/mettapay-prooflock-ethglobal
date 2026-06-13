// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@chainlink/contracts/src/v0.8/functions/v1_0_0/FunctionsClient.sol";
import "@chainlink/contracts/src/v0.8/functions/v1_0_0/libraries/FunctionsRequest.sol";
import "@chainlink/contracts/src/v0.8/shared/access/ConfirmedOwner.sol";

/// @title ProofLockVerifier
/// @notice Chainlink Functions consumer for MettaPays ProofLock. Buyer or
///         seller submits a verification request pointing at one of the
///         supported off-chain sources (GitHub PR, generic webhook, Shopify
///         order); the Chainlink DON executes the matching JS source from
///         contracts/functions/ and returns a boolean + message. Result is
///         stored per escrow as a flag the UI surfaces; the buyer still
///         clicks Approve & Release on the escrow itself.
contract ProofLockVerifier is FunctionsClient, ConfirmedOwner {
    using FunctionsRequest for FunctionsRequest.Request;

    struct VerificationResult {
        bool exists;
        bool verified;
        string message;
        uint256 checkedAt;
        bytes32 lastRequestId;
        address escrow;
    }

    /// @dev mapping(escrow => result)
    mapping(address => VerificationResult) public results;
    /// @dev mapping(requestId => escrow) so fulfillRequest can route back
    mapping(bytes32 => address) public requestEscrow;

    /// @notice Subscription ID for Chainlink Functions billing (owner-set).
    uint64 public subscriptionId;
    /// @notice DON ID for the Functions request (e.g. base-sepolia DON).
    bytes32 public donId;
    /// @notice Default callback gas limit.
    uint32 public callbackGasLimit = 300_000;

    event VerificationRequested(address indexed escrow, bytes32 indexed requestId, address indexed requester, string source);
    event VerificationFulfilled(address indexed escrow, bytes32 indexed requestId, bool verified, string message);
    event VerificationFailed(address indexed escrow, bytes32 indexed requestId, string error);
    event ConfigUpdated(uint64 subscriptionId, bytes32 donId, uint32 callbackGasLimit);

    error EmptySource();
    error UnknownRequest();

    constructor(address router, uint64 _subscriptionId, bytes32 _donId)
        FunctionsClient(router)
        ConfirmedOwner(msg.sender)
    {
        subscriptionId = _subscriptionId;
        donId = _donId;
    }

    function setConfig(uint64 _subscriptionId, bytes32 _donId, uint32 _gas) external onlyOwner {
        subscriptionId = _subscriptionId;
        donId = _donId;
        callbackGasLimit = _gas;
        emit ConfigUpdated(_subscriptionId, _donId, _gas);
    }

    /// @notice Send a Chainlink Functions request for `escrow`.
    /// @param escrow   The ProofLockEscrow address this result is tied to.
    /// @param source   JS source the DON will execute (must return abi-encoded bool + string).
    /// @param args     Positional string args passed to the JS source.
    /// @param sourceTag Human-readable tag (e.g. "github", "webhook", "shopify") for events.
    function requestVerification(
        address escrow,
        string calldata source,
        string[] calldata args,
        string calldata sourceTag
    ) external returns (bytes32 requestId) {
        if (bytes(source).length == 0) revert EmptySource();

        FunctionsRequest.Request memory req;
        req.initializeRequestForInlineJavaScript(source);
        if (args.length > 0) req.setArgs(args);

        requestId = _sendRequest(req.encodeCBOR(), subscriptionId, callbackGasLimit, donId);
        requestEscrow[requestId] = escrow;
        results[escrow] = VerificationResult({
            exists: true,
            verified: false,
            message: "pending",
            checkedAt: block.timestamp,
            lastRequestId: requestId,
            escrow: escrow
        });
        emit VerificationRequested(escrow, requestId, msg.sender, sourceTag);
    }

    function fulfillRequest(bytes32 requestId, bytes memory response, bytes memory err) internal override {
        address escrow = requestEscrow[requestId];
        if (escrow == address(0)) revert UnknownRequest();

        if (err.length > 0) {
            results[escrow].verified = false;
            results[escrow].message = string(err);
            results[escrow].checkedAt = block.timestamp;
            emit VerificationFailed(escrow, requestId, string(err));
            return;
        }

        // Response format: abi.encode(bool verified, string message)
        (bool verified, string memory message) = abi.decode(response, (bool, string));
        results[escrow].verified = verified;
        results[escrow].message = message;
        results[escrow].checkedAt = block.timestamp;
        emit VerificationFulfilled(escrow, requestId, verified, message);
    }

    function getResult(address escrow) external view returns (VerificationResult memory) {
        return results[escrow];
    }
}
