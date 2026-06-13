import type { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config();

// Etherscan V2: a SINGLE etherscan.io API key works across all chains (Base,
// Base Sepolia, Arbitrum, OP, …) via https://api.etherscan.io/v2/api?chainid=…
// hardhat-verify treats a string apiKey as a V2 key and an object as legacy V1
// per-explorer keys. Prefer ETHERSCAN_API_KEY; fall back to the old BASESCAN one.
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY ?? process.env.BASESCAN_API_KEY ?? "";

// Only use the deployer key if it's a real 32-byte hex key. This keeps
// `hardhat compile` / `hardhat test` working when .env still holds the
// placeholder, and only wires a live account once a valid key is provided.
// Accepts the key with or without the 0x prefix.
const RAW_KEY = (process.env.PRIVATE_KEY ?? "").trim();
const NORM_KEY = RAW_KEY.startsWith("0x") ? RAW_KEY : RAW_KEY ? `0x${RAW_KEY}` : "";
const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/.test(NORM_KEY) ? NORM_KEY : "";
const accounts = PRIVATE_KEY ? [PRIVATE_KEY] : [];

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 } },
  },
  networks: {
    baseSepolia: {
      url: process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org",
      chainId: 84532,
      accounts,
    },
    base: {
      url: process.env.BASE_MAINNET_RPC_URL ?? "https://mainnet.base.org",
      chainId: 8453,
      accounts,
    },
  },
  etherscan: {
    // Single string => Etherscan v2 multichain. base (8453) and baseSepolia
    // (84532) are built into hardhat-verify, so no customChains are needed.
    apiKey: ETHERSCAN_API_KEY,
  },
};

export default config;
