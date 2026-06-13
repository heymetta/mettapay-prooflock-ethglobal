// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {MettaPaySubnameRegistrar, IDurinL2Registry} from "../src/MettaPaySubnameRegistrar.sol";

/// @notice Deploys MettaPaySubnameRegistrar to Base mainnet or Base Sepolia.
///
/// Required env (always):
///   PRIVATE_KEY            — deployer EOA (Base ETH for gas)
///   DURIN_L2_REGISTRY      — Durin L2 Registry on the target chain
///   TREASURY               — receives withdraw() payouts
///   BACKEND_SIGNER         — EOA the MettaPay backend uses to mint free names
///
/// Required env for `run()` only (set per network):
///   USDC                   — USDC token address on the target chain
///   ETH_USD_FEED           — Chainlink ETH/USD aggregator on the target chain
///
/// Convenience entrypoints fill in the canonical Base addresses for you:
///   forge script ... --sig "runMainnet()"   → Base mainnet (chainId 8453)
///   forge script ... --sig "runSepolia()"   → Base Sepolia (chainId 84532)
///
/// Optional env (for the Quote script):
///   REGISTRAR              — deployed MettaPaySubnameRegistrar address
contract Deploy is Script {
    // Canonical addresses — pinned here so judges / ops can audit deploys.
    address public constant USDC_BASE_MAINNET = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address public constant FEED_BASE_MAINNET = 0x71041dDDad3595F9CEd3DcCFBe3D1F4b0a16Bb70;

    // Native USDC on Base Sepolia (Circle, 6 decimals).
    address public constant USDC_BASE_SEPOLIA = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    // Chainlink ETH/USD on Base Sepolia.
    address public constant FEED_BASE_SEPOLIA = 0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1;

    function run() external returns (MettaPaySubnameRegistrar registrar) {
        address usdc = vm.envAddress("USDC");
        address feed = vm.envAddress("ETH_USD_FEED");
        registrar = _deploy(usdc, feed);
    }

    function runMainnet() external returns (MettaPaySubnameRegistrar registrar) {
        registrar = _deploy(USDC_BASE_MAINNET, FEED_BASE_MAINNET);
    }

    function runSepolia() external returns (MettaPaySubnameRegistrar registrar) {
        registrar = _deploy(USDC_BASE_SEPOLIA, FEED_BASE_SEPOLIA);
    }

    function _deploy(address usdc, address feed) internal returns (MettaPaySubnameRegistrar registrar) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address registry = vm.envAddress("DURIN_L2_REGISTRY");
        address treasury = vm.envAddress("TREASURY");
        address signer = vm.envAddress("BACKEND_SIGNER");

        require(registry != address(0), "DURIN_L2_REGISTRY required");
        require(treasury != address(0), "TREASURY required");
        require(signer != address(0), "BACKEND_SIGNER required");
        require(usdc != address(0), "USDC required");
        require(feed != address(0), "ETH_USD_FEED required");

        vm.startBroadcast(pk);
        registrar = new MettaPaySubnameRegistrar(
            IDurinL2Registry(registry),
            usdc,
            feed,
            treasury,
            signer
        );
        vm.stopBroadcast();

        console2.log("MettaPaySubnameRegistrar deployed at:", address(registrar));
        console2.log("  registry =", registry);
        console2.log("  usdc     =", usdc);
        console2.log("  feed     =", feed);
        console2.log("  treasury =", treasury);
        console2.log("  signer   =", signer);
        console2.log("");
        console2.log("Next steps:");
        console2.log("1. On Durin L2 Registry, authorize this contract as a controller for");
        console2.log("   mettapay.eth so it can call register()/setAddr() on labels.");
        console2.log("2. Set VITE_MP_SUBNAME_REGISTRAR=<deployed address> in the app .env.");
        console2.log("3. Verify on Basescan: forge verify-contract <addr> MettaPaySubnameRegistrar");
    }
}

/// @notice Smoke-test the deployed contract by reading both quote functions.
///         Run after deploy: `forge script ... --sig "quote(uint8)" 1`
contract Quote is Script {
    function quote(uint8 years_) external view {
        address reg = vm.envAddress("REGISTRAR");
        MettaPaySubnameRegistrar r = MettaPaySubnameRegistrar(payable(reg));
        console2.log("years:", years_);
        console2.log("USDC (6 dec):", r.priceUsdc(years_));
        console2.log("ETH (wei):  ", r.priceEth(years_));
    }
}
