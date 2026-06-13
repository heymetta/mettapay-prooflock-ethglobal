// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MockProofLockVerifier
/// @notice Minimal stand-in for ProofLockVerifier so ProofLockEscrow's
///         informational `isVerifierApproved()` flag can be tested without the
///         Chainlink Functions DON. Shape matches ProofLockEscrow's
///         IProofLockVerifier interface exactly.
contract MockProofLockVerifier {
    struct VerificationResult {
        bool exists;
        bool verified;
        string message;
        uint256 checkedAt;
        bytes32 lastRequestId;
        address escrow;
    }

    mapping(address => VerificationResult) public results;

    /// When true, getResult reverts — proves the escrow's try/catch returns false.
    bool public reverts;

    function setReverts(bool v) external {
        reverts = v;
    }

    function setResult(address escrow, bool verified, string calldata message) external {
        results[escrow] = VerificationResult({
            exists: true,
            verified: verified,
            message: message,
            checkedAt: block.timestamp,
            lastRequestId: bytes32(0),
            escrow: escrow
        });
    }

    function getResult(address escrow) external view returns (VerificationResult memory) {
        require(!reverts, "verifier reverts");
        return results[escrow];
    }
}
