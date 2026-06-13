import { ethers } from "hardhat";
import { saveDeployment } from "./utils/deployments";

/**
 * Back-fills deployments/<network>.json from already-deployed contracts by
 * reading their on-chain state (so constructor args are exact, for verify).
 * Pass addresses via env; unset ones are skipped.
 *
 * Env: MOCK_USDC, FACTORY, REGISTRY, REGISTRAR
 * Run: MOCK_USDC=0x.. FACTORY=0x.. REGISTRY=0x.. REGISTRAR=0x.. \
 *        npx hardhat run scripts/save-deployments.ts --network baseSepolia
 */
async function main() {
  const { MOCK_USDC, FACTORY, REGISTRY, REGISTRAR } = process.env;

  if (MOCK_USDC) {
    const t = await ethers.getContractAt("MockERC20", MOCK_USDC);
    await saveDeployment("MockERC20_USDC", MOCK_USDC, {
      constructorArgs: [await t.name(), await t.symbol(), Number(await t.decimals())],
      note: "mintable test USDC (6 dec)",
    });
  }

  if (REGISTRY) {
    await saveDeployment("MockDurinRegistry", REGISTRY, {
      constructorArgs: [],
      note: "test stand-in for Durin L2 Registry (no real ENS/CCIP)",
    });
  }

  if (FACTORY) {
    const f = await ethers.getContractAt("EscrowFactory", FACTORY);
    const deployArgs = {
      defaultArbitrator: await f.defaultArbitrator(),
      networkMode: Number(await f.networkMode()),
      defaultVerifier: await f.defaultVerifier(),
      feeCollector: await f.feeCollector(),
      complianceOfficer: await f.complianceOfficer(),
      depositFeeBps: Number(await f.depositFeeBps()),
      settleFeeBps: Number(await f.settleFeeBps()),
      deadlineRefundFeeBps: Number(await f.deadlineRefundFeeBps()),
      disputeRefundFeeBps: Number(await f.disputeRefundFeeBps()),
      sellerConsolationBps: Number(await f.sellerConsolationBps()),
      usdc: await f.usdc(),
    };
    await saveDeployment("EscrowFactory", FACTORY, {
      constructorArgs: [deployArgs],
      feeCollector: deployArgs.feeCollector,
      complianceOfficer: deployArgs.complianceOfficer,
      usdc: deployArgs.usdc,
      note: "ProofLock escrow factory",
    });
  }

  if (REGISTRAR) {
    const r = await ethers.getContractAt("MettaPaySubnameRegistrar", REGISTRAR);
    const registry = await r.registry();
    const usdc = await r.USDC();
    const feed = await r.ETH_USD_FEED();
    const treasury = await r.treasury();
    const signer = await r.signer();
    await saveDeployment("MettaPaySubnameRegistrar", REGISTRAR, {
      constructorArgs: [registry, usdc, feed, treasury, signer],
      registry,
      usdc,
      ethUsdFeed: feed,
      treasury,
      signer,
      note: "registry = MockDurinRegistry (not real ENS); treasury/signer = deployer",
    });
  }

  console.log("\nDone.");
}

main().catch((e) => { console.error(e); process.exit(1); });
