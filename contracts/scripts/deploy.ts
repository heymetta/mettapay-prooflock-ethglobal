import { ethers } from "hardhat";
import { saveDeployment } from "./utils/deployments";

/**
 * Deploys EscrowFactory to Base Sepolia (NetworkMode = 1).
 *
 * Env vars:
 *   DEFAULT_ARBITRATOR        default = deployer
 *   NETWORK_MODE              0 = mainnet, 1 = sepolia (default)
 *   DEFAULT_VERIFIER          Chainlink Functions verifier (optional)
 *   FEE_COLLECTOR             protocol fee wallet (0x0 disables fees)
 *   COMPLIANCE_OFFICER        wallet allowed to release/forfeit seller
 *                             consolation balances (0x0 disables compliance flow)
 *   USDC                      optional USDC token override (0x0 = canonical
 *                             Circle USDC for the networkMode). Set this to a
 *                             mintable mock token for easy testnet smoke tests.
 *   DEPOSIT_FEE_BPS           default 290  (2.90%)
 *   SETTLE_FEE_BPS            default 190  (1.90%)
 *   DEADLINE_REFUND_FEE_BPS   default 300  (3.00% — seller no-show refund)
 *   DISPUTE_REFUND_FEE_BPS    default 900  (9.00% — disputed buyer-award refund)
 *   SELLER_CONSOLATION_BPS    default 300  (3.00% redirected to seller, held
 *                             pending compliance officer review)
 *
 * Run: npx hardhat run scripts/deploy.ts --network baseSepolia
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const zero = "0x0000000000000000000000000000000000000000";
  const isAddr = (v?: string) => !!v && /^0x[0-9a-fA-F]{40}$/.test(v);
  const addrOr = (v: string | undefined, fallback: string) => (isAddr(v) ? (v as string) : fallback);

  const args = {
    defaultArbitrator: addrOr(process.env.DEFAULT_ARBITRATOR, deployer.address),
    networkMode: Number(process.env.NETWORK_MODE ?? 1),
    defaultVerifier: addrOr(process.env.DEFAULT_VERIFIER, zero),
    feeCollector: addrOr(process.env.FEE_COLLECTOR, zero),
    complianceOfficer: addrOr(process.env.COMPLIANCE_OFFICER, zero),
    depositFeeBps: Number(process.env.DEPOSIT_FEE_BPS ?? 290),
    settleFeeBps: Number(process.env.SETTLE_FEE_BPS ?? 190),
    deadlineRefundFeeBps: Number(process.env.DEADLINE_REFUND_FEE_BPS ?? 300),
    disputeRefundFeeBps: Number(process.env.DISPUTE_REFUND_FEE_BPS ?? 900),
    sellerConsolationBps: Number(process.env.SELLER_CONSOLATION_BPS ?? 300),
    usdc: addrOr(process.env.USDC, zero),
  };

  console.log("Fee collector     :", args.feeCollector);
  console.log("Compliance officer:", args.complianceOfficer);
  console.log("USDC override     :", args.usdc === zero ? "(canonical for network)" : args.usdc);
  console.log(
    `Fee schedule: deposit=${args.depositFeeBps}bps settle=${args.settleFeeBps}bps ` +
      `deadlineRefund=${args.deadlineRefundFeeBps}bps disputeRefund=${args.disputeRefundFeeBps}bps ` +
      `sellerConsolation=${args.sellerConsolationBps}bps`
  );

  const Factory = await ethers.getContractFactory("EscrowFactory");
  const factory = await Factory.deploy(args);
  await factory.waitForDeployment();

  const addr = await factory.getAddress();

  await saveDeployment("EscrowFactory", addr, {
    constructorArgs: [args],
    feeCollector: args.feeCollector,
    complianceOfficer: args.complianceOfficer,
    usdc: args.usdc,
    note: "ProofLock escrow factory",
  });

  console.log("EscrowFactory:", addr);
  console.log(
    "\nUpdate app .env:\n" +
      `  VITE_PROOFLOCK_FACTORY_ADDRESS=${addr}\n` +
      `  VITE_PROOFLOCK_FEE_COLLECTOR=${args.feeCollector}\n` +
      `  VITE_PROOFLOCK_COMPLIANCE_OFFICER=${args.complianceOfficer}\n`
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
