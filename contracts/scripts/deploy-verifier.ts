import { ethers } from "hardhat";
import { saveDeployment } from "./utils/deployments";

/**
 * Deploys ProofLockVerifier (Chainlink Functions consumer) to Base Sepolia.
 *
 * Prereq: create a Functions subscription at
 *   https://functions.chain.link/base-sepolia
 * and fund it with LINK. After this script prints the verifier address,
 * add it as a Consumer on your subscription.
 *
 * Env vars (Base Sepolia defaults shown):
 *   ROUTER   0xf9B8fc078197181C841c296C876945aaa425B278
 *   DON_ID   0x66756e2d626173652d7365706f6c69612d310000000000000000000000000000
 *   SUB_ID   <your Functions subscription id>
 *
 * Run: npx hardhat run scripts/deploy-verifier.ts --network baseSepolia
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const router = process.env.ROUTER;
  const donId = process.env.DON_ID;
  const subId = process.env.SUB_ID;

  if (!router) throw new Error("ROUTER env var is required");
  if (!donId) throw new Error("DON_ID env var is required");
  if (!subId) throw new Error("SUB_ID env var is required");

  console.log("Router:", router);
  console.log("DON ID:", donId);
  console.log("Sub ID:", subId);

  const Verifier = await ethers.getContractFactory("ProofLockVerifier");
  // Constructor order is (router, subscriptionId, donId) — subId is uint64, donId is bytes32.
  const verifier = await Verifier.deploy(router, BigInt(subId), donId);
  await verifier.waitForDeployment();

  const addr = await verifier.getAddress();
  console.log("\nProofLockVerifier:", addr);

  await saveDeployment("ProofLockVerifier", addr, {
    constructorArgs: [router, subId.toString(), donId],
    router,
    subscriptionId: subId.toString(),
    donId,
    note: "Chainlink Functions consumer. INERT on testnet: Chainlink Functions sunset on testnets 2026-06-02 (mainnet 2026-09-01), so requests are never fulfilled here. subId is a placeholder; owner can setConfig later.",
  });

  // Optional: propose ownership to the client (ConfirmedOwner is 2-step).
  const isAddr = (v?: string) => !!v && /^0x[0-9a-fA-F]{40}$/.test(v);
  if (isAddr(process.env.NEW_OWNER)) {
    await (await verifier.transferOwnership(process.env.NEW_OWNER as string)).wait();
    console.log(`  ↳ ownership PROPOSED to ${process.env.NEW_OWNER} — new owner must call acceptOwnership()`);
  }

  console.log(
    "\nNext steps:\n" +
      `  1) Add ${addr} as a Consumer on your Functions subscription (${subId}).\n` +
      `  2) Update app .env:\n` +
      `       VITE_PROOFLOCK_VERIFIER_ADDRESS=${addr}\n` +
      `  3) (Recommended) Redeploy EscrowFactory with DEFAULT_VERIFIER=${addr}\n` +
      `     so every new escrow stamps the verifier into its constructor.\n`
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
