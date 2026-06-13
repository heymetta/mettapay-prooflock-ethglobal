// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MockV3Aggregator
/// @notice Minimal Chainlink ETH/USD-style price feed for tests. Lets a test
///         set the answer and freely move `updatedAt` to exercise the
///         registrar's staleness guard (MAX_PRICE_AGE).
contract MockV3Aggregator {
    uint8 public decimals;
    int256 public answer;
    uint256 public updatedAt;
    uint80 public roundId;

    constructor(uint8 _decimals, int256 _initialAnswer) {
        decimals = _decimals;
        answer = _initialAnswer;
        updatedAt = block.timestamp;
        roundId = 1;
    }

    /// Update the answer and stamp `updatedAt` to now.
    function updateAnswer(int256 _answer) external {
        answer = _answer;
        updatedAt = block.timestamp;
        roundId += 1;
    }

    /// Force a specific `updatedAt` (e.g. far in the past) to simulate a stale
    /// feed without changing the answer.
    function setUpdatedAt(uint256 _updatedAt) external {
        updatedAt = _updatedAt;
    }

    function setDecimals(uint8 _decimals) external {
        decimals = _decimals;
    }

    function latestRoundData()
        external
        view
        returns (uint80, int256, uint256, uint256, uint80)
    {
        return (roundId, answer, updatedAt, updatedAt, roundId);
    }
}
