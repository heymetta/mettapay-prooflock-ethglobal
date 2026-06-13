// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MockDurinRegistry
/// @notice Test double for the real Durin L2Registry. Implements the surface
///         MettaPaySubnameRegistrar relies on (baseNode / makeNode /
///         createSubnode / setAddr(node,coinType,addr) / owner / registrars) and
///         records calls so tests can assert the registrar forwarded correctly.
///         `setLocked(true)` simulates "registrar not authorized".
contract MockDurinRegistry {
    bytes32 public baseNode = keccak256("mettapay.eth");

    mapping(bytes32 => address) public nodeOwner; // subnode => owner
    mapping(bytes32 => mapping(uint256 => bytes)) public addrOf; // node => coinType => addr
    mapping(address => bool) public registrars;

    uint256 public createSubnodeCalls;
    uint256 public setAddrCalls;
    bool public locked;

    error NotAuthorized();

    function setLocked(bool v) external {
        locked = v;
    }

    function addRegistrar(address r) external {
        registrars[r] = true;
    }

    function makeNode(bytes32 parentNode, string calldata label) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(parentNode, keccak256(bytes(label))));
    }

    function createSubnode(bytes32 node, string calldata label, address owner_, bytes[] calldata)
        external
        returns (bytes32 sub)
    {
        if (locked) revert NotAuthorized();
        sub = makeNode(node, label);
        nodeOwner[sub] = owner_;
        createSubnodeCalls += 1;
    }

    function setAddr(bytes32 node, uint256 coinType, bytes calldata a) external {
        if (locked) revert NotAuthorized();
        addrOf[node][coinType] = a;
        setAddrCalls += 1;
    }

    /// Durin's safe owner lookup: returns address(0) for a non-existent node.
    function owner(bytes32 node) external view returns (address) {
        return nodeOwner[node];
    }
}
