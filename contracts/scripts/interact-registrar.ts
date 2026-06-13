import { ethers } from "hardhat";
import { deployedAddress } from "./utils/deployments";

/**
 * Live function test of the deployed MettaPaySubnameRegistrar, driven by the
 * deployer key (who is owner + signer + treasury on this deployment). Exercises:
 * pricing, claimFree, claimPaidUsdc, claimPaidEth (+ overpay refund), renew,
 * setAddr, isAvailable, withdraw, and pause. Labels are block-unique so it's
 * re-runnable. Reads use a small retry to ride out public-RPC lag.
 *
 * Run: npx hardhat run scripts/interact-registrar.ts --network baseSepolia
 */
async function retry<T>(fn: () => Promise<T>, pred: (v: T) => boolean, tries = 8): Promise<T> {
  let last!: T;
  for (let i = 0; i < tries; i++) {
    last = await fn();
    if (pred(last)) return last;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return last;
}

let pass = 0;
let fail = 0;
async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    pass++;
  } catch (e: any) {
    console.log(`  ✗ ${name}\n      ${e.shortMessage || e.message}`);
    fail++;
  }
}

async function main() {
  const [me] = await ethers.getSigners();
  const r = await ethers.getContractAt("MettaPaySubnameRegistrar", deployedAddress("MettaPaySubnameRegistrar"));
  const usdc = await ethers.getContractAt("MockERC20", await r.USDC());
  const registry = await ethers.getContractAt("MockDurinRegistry", await r.registry());
  const block = await ethers.provider.getBlockNumber();
  const hex5 = block.toString(16).padStart(5, "0").slice(-5);
  const freeLabel = `0x${hex5}`;
  const paidLabel = `live-usdc-${block}`;
  const ethLabel = `live-eth-${block}`;

  console.log("Registrar:", await r.getAddress());
  console.log("Caller   :", me.address, "(owner/signer/treasury)\n");

  await step("priceUsdc 1/3/5 = 7e6/17e6/30e6", async () => {
    if ((await r.priceUsdc(1)) !== 7_000_000n) throw new Error("1y");
    if ((await r.priceUsdc(3)) !== 17_000_000n) throw new Error("3y");
    if ((await r.priceUsdc(5)) !== 30_000_000n) throw new Error("5y");
  });
  await step("priceEth(1) > 0 (live Chainlink)", async () => {
    if ((await r.priceEth(1)) <= 0n) throw new Error("zero");
  });

  await step(`claimFree("${freeLabel}")`, async () => {
    await (await r.claimFree(freeLabel, me.address)).wait();
    const rec = await retry(() => r.recordOf(freeLabel), (x) => x.holder === me.address);
    if (rec.holder !== me.address) throw new Error("holder not set");
    if (rec.expiresAt !== 0n) throw new Error("free should not expire");
    const node = await registry.makeNode(await registry.baseNode(), freeLabel);
    if ((await retry(() => registry.owner(node), (x) => x === me.address)) !== me.address)
      throw new Error("registry subnode not created");
  });

  await step(`claimPaidUsdc("${paidLabel}", 1)`, async () => {
    const price = await r.priceUsdc(1);
    await (await usdc.approve(await r.getAddress(), price)).wait();
    await (await r.claimPaidUsdc(paidLabel, 1)).wait();
    const rec = await retry(() => r.recordOf(paidLabel), (x) => x.paid === true);
    if (!rec.paid || rec.expiresAt === 0n) throw new Error("not paid/expiry unset");
  });

  await step(`claimPaidEth("${ethLabel}", 1) refunds overpay`, async () => {
    const quote = await r.priceEth(1);
    const before = await ethers.provider.getBalance(me.address);
    const tx = await r.claimPaidEth(ethLabel, 1, { value: quote * 2n });
    const rc = await tx.wait();
    const after = await ethers.provider.getBalance(me.address);
    const gas = rc!.gasUsed * (rc!.gasPrice ?? 0n);
    const spent = before - after; // should be ~quote + gas, NOT 2*quote
    if (spent > quote + gas + ethers.parseEther("0.0001")) throw new Error("overpay not refunded");
    const rec = await retry(() => r.recordOf(ethLabel), (x) => x.paid === true);
    if (!rec.paid) throw new Error("not recorded");
  });

  await step(`renewUsdc("${paidLabel}", 1) extends expiry`, async () => {
    const before = (await r.recordOf(paidLabel)).expiresAt;
    await (await usdc.approve(await r.getAddress(), await r.priceUsdc(1))).wait();
    await (await r.renewUsdc(paidLabel, 1)).wait();
    const after = await retry(() => r.recordOf(paidLabel), (x) => x.expiresAt > before);
    if (after.expiresAt <= before) throw new Error("not extended");
  });

  await step(`setAddr("${paidLabel}") repoints`, async () => {
    const target = ethers.Wallet.createRandom().address;
    await (await r.setAddr(paidLabel, target)).wait();
    const node = await registry.makeNode(await registry.baseNode(), paidLabel);
    const want = target.toLowerCase();
    if ((await retry(() => registry.addrOf(node, 60n), (x) => x.toLowerCase() === want)).toLowerCase() !== want)
      throw new Error("registry addr record not updated");
  });

  await step("isAvailable reflects taken/free", async () => {
    if (await r.isAvailable(paidLabel)) throw new Error("taken label shows available");
    if (!(await r.isAvailable(`free-${block}-xyz`))) throw new Error("fresh label shows taken");
  });

  await step("withdraw USDC + ETH to treasury", async () => {
    const ra = await r.getAddress();
    const usdcBal = await usdc.balanceOf(ra);
    if (usdcBal > 0n) {
      await (await r.withdraw(await usdc.getAddress(), usdcBal)).wait();
      if ((await retry(() => usdc.balanceOf(ra), (x) => x === 0n)) !== 0n) throw new Error("usdc not withdrawn");
    }
    const ethBal = await ethers.provider.getBalance(ra);
    if (ethBal > 0n) {
      await (await r.withdraw(ethers.ZeroAddress, ethBal)).wait();
    }
  });

  await step("pause blocks claims, then unpause", async () => {
    await (await r.setPaused(true)).wait();
    await retry(() => r.paused(), (v) => v === true); // wait for the pause to propagate to read nodes
    let reverted = false;
    try {
      await r.claimFree.staticCall(`0x${(block + 7).toString(16).padStart(5, "0").slice(-5)}`, me.address);
    } catch {
      reverted = true;
    }
    await (await r.setPaused(false)).wait();
    if (!reverted) throw new Error("claim did not revert while paused");
  });

  console.log(`\nRegistrar live test: ${pass} passed, ${fail} failed.`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
