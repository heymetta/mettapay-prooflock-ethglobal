import { ethers } from "hardhat";

export const ZERO = "0x0000000000000000000000000000000000000000";
export const DAY = 24 * 60 * 60;
export const BPS_DENOMINATOR = 10_000n;
export const TERMS = ethers.keccak256(ethers.toUtf8Bytes("terms-v1"));

/// basis-points helper mirroring the contracts' `(x * bps) / 10_000`.
export function bps(amount: bigint, b: number | bigint): bigint {
  return (amount * BigInt(b)) / BPS_DENOMINATOR;
}

export const DEFAULT_FEES = {
  depositFeeBps: 290, // 2.90%
  settleFeeBps: 190, // 1.90%
  deadlineRefundFeeBps: 300, // 3.00%
  disputeRefundFeeBps: 900, // 9.00%
  sellerConsolationBps: 300, // 3.00%
};

// AssetType enum
export const ASSET_ETH = 0;
export const ASSET_USDC = 1;

// Status enum
export const Status = {
  Created: 0,
  Funded: 1,
  ProofSubmitted: 2,
  Approved: 3,
  Released: 4,
  Disputed: 5,
  Refunded: 6,
} as const;

// NetworkMode enum
export const NET_BASE_MAINNET = 0;
export const NET_BASE_SEPOLIA = 1;
