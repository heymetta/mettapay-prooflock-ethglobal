import { ethers, network } from "hardhat";

/**
 * Preflight: prints the deployer address, network, balance, and which deploy
 * env vars are set. Never prints the private key.
 *
 * Run: npx hardhat run scripts/preflight.ts --network baseSepolia
 */
async function main() {
  const signers = await ethers.getSigners();
  if (signers.length === 0) {
    console.error(
      "No signer configured. Set a valid PRIVATE_KEY (64 hex chars, with or without 0x) in .env."
    );
    process.exit(1);
  }
  const deployer = signers[0];
  const net = await ethers.provider.getNetwork();
  const bal = await ethers.provider.getBalance(deployer.address);

  console.log("Network :", network.name, `(chainId ${net.chainId})`);
  console.log("Deployer:", deployer.address);
  console.log("Balance :", ethers.formatEther(bal), "ETH");
  console.log("");
  console.log("Configured deploy params:");
  for (const k of [
    "DEFAULT_ARBITRATOR",
    "FEE_COLLECTOR",
    "COMPLIANCE_OFFICER",
    "DEFAULT_VERIFIER",
    "USDC",
    "DURIN_L2_REGISTRY",
    "TREASURY",
    "BACKEND_SIGNER",
  ]) {
    const v = process.env[k];
    const valid = v && /^0x[0-9a-fA-F]{40}$/.test(v);
    console.log(`  ${k.padEnd(20)} ${v ?? "(unset)"}${v && !valid ? "   <-- not a valid address" : ""}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
