// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// The registrar lives under the Foundry source dir (`src/`). Importing it from
// inside Hardhat's sources dir pulls it into Hardhat's compilation graph so the
// TypeScript test suite can deploy it via getContractFactory(), without moving
// the file or disturbing the Foundry layout.
import "../src/MettaPaySubnameRegistrar.sol";
