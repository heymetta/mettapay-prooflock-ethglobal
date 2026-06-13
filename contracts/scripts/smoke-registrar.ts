import { ethers } from "hardhat";

/**
 * Read the live registrar's wiring + run a functional smoke test on Base
 * Sepolia: claimFree (signer path) and claimPaidUsdc (paid path) using the
 * mock USDC. Proves the registrar + registry + feed are correctly wired.
 *
 * Env:
 *   REGISTRAR  deployed MettaPaySubnameRegistrar address (required)
 *
 * Run: REGISTRAR=0x... npx hardhat run scripts/smoke-registrar.ts --network baseSepolia
 */
async function main() {
  const [me] = await ethers.getSigners();
  const addr = process.env.REGISTRAR;
  if (!addr) throw new Error("REGISTRAR env var is required");
  const r = await ethers.getContractAt("MettaPaySubnameRegistrar", addr);

  const registryAddr = await r.registry();
  const usdcAddr = await r.USDC();
  console.log("Registrar:", addr);
  console.log("  registry:", registryAddr);
  console.log("  USDC    :", usdcAddr);
  console.log("  treasury:", await r.treasury());
  console.log("  signer  :", await r.signer(), me.address === (await r.signer()) ? "(= me)" : "");
  console.log("  paused  :", await r.paused());
  console.log("  priceUsdc(1):", (await r.priceUsdc(1)).toString());
  console.log("  priceEth(1) :", (await r.priceEth(1)).toString(), "wei");

  // 1) Free tier (deployer is the signer).
  const freeLabel = "0x" + me.address.slice(2, 7).toLowerCase(); // 0x + 5 hex, deterministic per wallet
  if ((await r.recordOf(freeLabel)).holder === ethers.ZeroAddress) {
    console.log(`\nclaimFree("${freeLabel}") ...`);
    await (await r.claimFree(freeLabel, me.address)).wait();
  } else {
    console.log(`\n${freeLabel} already claimed, skipping`);
  }
  const freeRec = await r.recordOf(freeLabel);
  console.log(`  holder=${freeRec.holder} expiresAt=${freeRec.expiresAt} paid=${freeRec.paid}`);
  const registry = await ethers.getContractAt("MockDurinRegistry", registryAddr);
  console.log(`  registry.ownerOf = ${await registry.ownerOf(ethers.keccak256(ethers.toUtf8Bytes(freeLabel)))}`);

  // 2) Paid tier (USDC) — approve then claim a unique label.
  const usdc = await ethers.getContractAt("MockERC20", usdcAddr);
  const price = await r.priceUsdc(1);
  const label = "smoke" + (await ethers.provider.getBlockNumber());
  console.log(`\nclaimPaidUsdc("${label}", 1) for ${price} ...`);
  await (await usdc.approve(addr, price)).wait();
  await (await r.claimPaidUsdc(label, 1)).wait();
  const paidRec = await r.recordOf(label);
  console.log(`  holder=${paidRec.holder} expiresAt=${paidRec.expiresAt} paid=${paidRec.paid}`);
  console.log(`  registrar USDC balance: ${await usdc.balanceOf(addr)}`);
  console.log("\nSmoke test OK ✓");
}

main().catch((e) => { console.error(e); process.exit(1); });
