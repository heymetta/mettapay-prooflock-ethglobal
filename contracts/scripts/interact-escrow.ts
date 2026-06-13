import { ethers } from "hardhat";
import { deployedAddress } from "./utils/deployments";

/**
 * Live function test of the deployed EscrowFactory + ProofLockEscrow, driven by
 * the deployer key as BUYER and ARBITRATOR. A throwaway SELLER is generated and
 * funded so it can call submitProof. Scenarios:
 *   1. ETH happy path     : fund -> submitProof -> approveAndRelease
 *   2. ETH dispute         : fund -> submitProof -> dispute -> resolveDispute(50/50)
 *   3. USDC happy path     : fund -> submitProof -> approveAndRelease
 *   4. ETH deadline refund : short deadline -> wait -> refundAfterDeadline
 *
 * Assertions are status/drainage based and polled (until) to tolerate RPC lag.
 * Every key transaction hash is printed as a Basescan link for the demo.
 *
 * Run: npx hardhat run scripts/interact-escrow.ts --network baseSepolia
 */
const Status = { Created: 0n, Funded: 1n, ProofSubmitted: 2n, Released: 4n, Disputed: 5n, Refunded: 6n };
const txs: { label: string; hash: string }[] = [];

async function send(label: string, p: Promise<any>) {
  const tx = await p;
  await tx.wait();
  txs.push({ label, hash: tx.hash });
  return tx;
}

async function until<T>(fn: () => Promise<T>, pred: (v: T) => boolean, tries = 20, delay = 2000): Promise<T> {
  let last!: T;
  for (let i = 0; i < tries; i++) {
    try {
      last = await fn();
      if (pred(last)) return last;
    } catch {
      /* transient RPC error, retry */
    }
    await new Promise((r) => setTimeout(r, delay));
  }
  throw new Error(`condition not met; last=${String(last)}`);
}

function escrowFromReceipt(factory: any, rc: any, eventName: string): string {
  for (const log of rc.logs) {
    try {
      const p = factory.interface.parseLog(log);
      if (p && p.name === eventName) return p.args.escrow;
    } catch {
      /* not a factory event */
    }
  }
  throw new Error(`${eventName} not found in receipt`);
}

const bps = (x: bigint, b: bigint) => (x * b) / 10_000n;

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
  const [buyer] = await ethers.getSigners();
  const factory = await ethers.getContractAt("EscrowFactory", deployedAddress("EscrowFactory"));
  const usdc = await ethers.getContractAt("MockERC20", await factory.usdc());
  const terms = ethers.keccak256(ethers.toUtf8Bytes("live-terms"));
  const proof = ethers.keccak256(ethers.toUtf8Bytes("live-proof"));
  const seller = ethers.Wallet.createRandom().connect(ethers.provider);

  console.log("Factory  :", await factory.getAddress());
  console.log("Buyer    :", buyer.address, "(also arbitrator)");
  console.log("Seller   :", seller.address, "(throwaway)\n");
  await send("fund seller gas", buyer.sendTransaction({ to: seller.address, value: ethers.parseEther("0.0015") }));

  const ONE = ethers.parseEther("0.001");
  const at = async (rc: any, ev: string) => ethers.getContractAt("ProofLockEscrow", escrowFromReceipt(factory, rc, ev));
  const future = async () => (await ethers.provider.getBlock("latest"))!.timestamp + 3600;

  // 1) ETH happy path
  await step("ETH: fund -> submitProof -> approveAndRelease -> Released + drained", async () => {
    const rc = await (await send("create ETH escrow",
      factory.createBaseEthEscrow(seller.address, await future(), terms, ethers.ZeroAddress, { value: ONE }))).wait();
    const e = await at(rc, "BaseEthEscrowCreated");
    await send("seller submitProof", e.connect(seller).submitProof(proof, "ipfs://x"));
    await until(() => e.status(), (s) => s === Status.ProofSubmitted);
    const net = await e.netAmount();
    await send("buyer approveAndRelease", e.connect(buyer).approveAndRelease());
    await until(() => e.status(), (s) => s === Status.Released);
    await until(() => ethers.provider.getBalance(e.target as string), (b) => b === 0n);
    console.log(`      seller paid ${net - bps(net, await e.settleFeeBps())} wei (net - 1.9% settle)`);
  });

  // 2) ETH dispute -> arbitrator split
  await step("ETH: dispute -> resolveDispute(50/50) -> Released + consolation accrued", async () => {
    const arb: string = await factory.getFunction("defaultArbitrator").staticCall();
    if (arb.toLowerCase() !== buyer.address.toLowerCase()) {
      console.log(`      skipped — arbitrator is ${arb} (client); resolveDispute must be called from that wallet`);
      return;
    }
    const rc = await (await send("create ETH escrow (dispute)",
      factory.createBaseEthEscrow(seller.address, await future(), terms, ethers.ZeroAddress, { value: ONE }))).wait();
    const e = await at(rc, "BaseEthEscrowCreated");
    await send("seller submitProof", e.connect(seller).submitProof(proof, "ipfs://x"));
    await until(() => e.status(), (s) => s === Status.ProofSubmitted);
    await send("buyer dispute", e.connect(buyer).dispute("not as described"));
    await until(() => e.status(), (s) => s === Status.Disputed);
    const net = await e.netAmount();
    const buyerAward = net / 2n;
    await send("arbitrator resolveDispute", e.connect(buyer).resolveDispute(buyerAward, net - buyerAward));
    await until(() => e.status(), (s) => s === Status.Released);
    const consolation = bps(buyerAward, await e.sellerConsolationBps());
    await until(() => e.sellerConsolationAccrued(), (v) => v === consolation);
    console.log(`      consolation held in-contract = ${consolation} wei (pending compliance)`);
  });

  // 3) USDC happy path
  await step("USDC: fund -> submitProof -> approveAndRelease -> Released + drained", async () => {
    const amount = 5_000_000n; // 5 USDC
    const bal = await usdc.balanceOf(buyer.address);
    if (bal < amount) {
      console.log(`      skipped — buyer has ${ethers.formatUnits(bal, 6)} USDC at ${await factory.usdc()}; fund ${buyer.address} to run`);
      return;
    }
    await send("approve USDC", usdc.approve(await factory.getAddress(), amount));
    const rc = await (await send("create USDC escrow",
      factory.createBaseUsdcEscrow(seller.address, amount, await future(), terms, ethers.ZeroAddress))).wait();
    const e = await at(rc, "BaseUsdcEscrowCreated");
    await until(() => e.status(), (s) => s === Status.Funded);
    await send("seller submitProof", e.connect(seller).submitProof(proof, "ipfs://x"));
    await until(() => e.status(), (s) => s === Status.ProofSubmitted);
    await send("buyer approveAndRelease", e.connect(buyer).approveAndRelease());
    await until(() => e.status(), (s) => s === Status.Released);
    await until(() => usdc.balanceOf(e.target as string), (b) => b === 0n);
  });

  // 4) ETH deadline refund
  await step("ETH: deadline passes -> refundAfterDeadline -> Refunded + drained", async () => {
    const dl = (await ethers.provider.getBlock("latest"))!.timestamp + 25;
    const rc = await (await send("create ETH escrow (deadline)",
      factory.createBaseEthEscrow(seller.address, dl, terms, ethers.ZeroAddress, { value: ONE }))).wait();
    const e = await at(rc, "BaseEthEscrowCreated");
    console.log("      waiting ~35s for the deadline to pass...");
    await new Promise((r) => setTimeout(r, 35_000));
    await send("buyer refundAfterDeadline", e.connect(buyer).refundAfterDeadline());
    await until(() => e.status(), (s) => s === Status.Refunded);
    await until(() => ethers.provider.getBalance(e.target as string), (b) => b === 0n);
  });

  // sweep leftover seller gas back to buyer
  try {
    const bal = await ethers.provider.getBalance(seller.address);
    const keep = ethers.parseEther("0.00006");
    if (bal > keep) await (await seller.sendTransaction({ to: buyer.address, value: bal - keep })).wait();
  } catch {
    /* dust */
  }

  console.log(`\nEscrow live test: ${pass} passed, ${fail} failed.`);
  console.log("\nTransactions (Basescan):");
  for (const t of txs) console.log(`  ${t.label.padEnd(26)} https://sepolia.basescan.org/tx/${t.hash}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
