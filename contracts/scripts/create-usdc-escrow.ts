import { ethers } from "hardhat";
import { deployedAddress } from "./utils/deployments";

/**
 * Creates a real USDC escrow from the EscrowFactory, as the deployer (buyer).
 * Requires the deployer to hold >= AMOUNT real Circle USDC.
 *
 * Env: AMOUNT (USDC, default "5"), SELLER (default: a throwaway wallet)
 * Run: npx hardhat run scripts/create-usdc-escrow.ts --network baseSepolia
 */
async function rc<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 0; i < 8; i++) { try { return await fn(); } catch { await new Promise(r => setTimeout(r, 2500)); } }
  return fn();
}

async function main() {
  const [buyer] = await ethers.getSigners();
  const factory = await ethers.getContractAt("EscrowFactory", deployedAddress("EscrowFactory"));
  const factoryAddr = await factory.getAddress();
  const usdcAddr = await rc(() => factory.getFunction("usdc").staticCall());
  const usdc = await ethers.getContractAt("MockERC20", usdcAddr); // ERC20 ABI overlaps

  const bal: bigint = await rc(() => usdc.balanceOf(buyer.address));
  const amount = ethers.parseUnits(process.env.AMOUNT ?? "5", 6);
  console.log("Factory :", factoryAddr);
  console.log("Buyer   :", buyer.address);
  console.log("USDC    :", usdcAddr, `(balance ${ethers.formatUnits(bal, 6)})`);
  console.log("Amount  :", ethers.formatUnits(amount, 6), "USDC");

  if (bal < amount) {
    console.log(`\n✗ Insufficient USDC in the deployer wallet (${buyer.address}).`);
    console.log(`  Send >= ${ethers.formatUnits(amount, 6)} Circle USDC (${usdcAddr}) to ${buyer.address} ,`);
    console.log(`  OR create the escrow yourself from a funded wallet via the factory's Write tab.`);
    process.exit(2);
  }

  const seller = process.env.SELLER && /^0x[0-9a-fA-F]{40}$/.test(process.env.SELLER)
    ? ethers.getAddress(process.env.SELLER)
    : ethers.Wallet.createRandom().address;
  const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 7 * 24 * 3600;
  const terms = ethers.keccak256(ethers.toUtf8Bytes("mettapay-usdc-escrow-demo"));

  console.log("Seller  :", seller);
  console.log("Deadline:", new Date(deadline * 1000).toISOString());

  const aTx = await rc(() => usdc.approve(factoryAddr, amount));
  await aTx.wait();
  console.log("approve tx :", aTx.hash);

  const cTx = await factory.createBaseUsdcEscrow(seller, amount, deadline, terms, ethers.ZeroAddress);
  const rcpt = await cTx.wait();
  console.log("create  tx :", cTx.hash);

  // parse the escrow address from the BaseUsdcEscrowCreated event
  let escrow = "";
  for (const log of rcpt!.logs) {
    try { const p = factory.interface.parseLog(log); if (p?.name === "BaseUsdcEscrowCreated") escrow = p.args.escrow; } catch {}
  }
  console.log("\n✓ Escrow created:", escrow);
  if (escrow) {
    try {
      const e = await ethers.getContractAt("ProofLockEscrow", escrow);
      console.log("  status   :", (await rc(() => e.getFunction("status").staticCall())).toString(), "(1 = Funded)");
      console.log("  amount   :", ethers.formatUnits(await rc(() => e.getFunction("amount").staticCall()), 6), "USDC");
      console.log("  escrow USDC bal:", ethers.formatUnits(await rc(() => usdc.balanceOf(escrow)), 6));
    } catch { console.log("  (post-create reads lagged; escrow is deployed)"); }
    console.log("  explorer :", `https://sepolia.basescan.org/address/${escrow}`);
  }
  console.log("  create tx:", `https://sepolia.basescan.org/tx/${cTx.hash}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
