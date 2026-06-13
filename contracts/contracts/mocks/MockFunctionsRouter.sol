// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/// @title MockFunctionsRouter
/// @notice Minimal stand-in for the Chainlink Functions Router so
///         ProofLockVerifier can be tested without a live DON. It satisfies the
///         single call FunctionsClient makes (`sendRequest`) by returning a
///         deterministic requestId, and exposes `fulfill()` so a test can drive
///         the consumer's `handleOracleFulfillment` callback (success or error).
interface IFunctionsClientLike {
    function handleOracleFulfillment(bytes32 requestId, bytes memory response, bytes memory err) external;
}

contract MockFunctionsRouter {
    uint256 public nonce;
    bytes32 public lastRequestId;
    uint64 public lastSubscriptionId;
    bytes32 public lastDonId;
    uint32 public lastCallbackGasLimit;

    /// Matches IFunctionsRouter.sendRequest used by FunctionsClient._sendRequest.
    function sendRequest(
        uint64 subscriptionId,
        bytes calldata /* data */,
        uint16 /* dataVersion */,
        uint32 callbackGasLimit,
        bytes32 donId
    ) external returns (bytes32 requestId) {
        nonce += 1;
        requestId = keccak256(abi.encodePacked(msg.sender, subscriptionId, donId, nonce));
        lastRequestId = requestId;
        lastSubscriptionId = subscriptionId;
        lastDonId = donId;
        lastCallbackGasLimit = callbackGasLimit;
    }

    /// Simulate the DON returning a successful response (err empty) or an error.
    function fulfill(
        address client,
        bytes32 requestId,
        bytes calldata response,
        bytes calldata err
    ) external {
        IFunctionsClientLike(client).handleOracleFulfillment(requestId, response, err);
    }
}
