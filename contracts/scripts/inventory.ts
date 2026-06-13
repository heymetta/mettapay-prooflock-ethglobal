import { ethers } from "hardhat";

/**
 * Lists contracts recently deployed by the configured deployer (by walking
 * its last nonces and computing CREATE addresses) and labels each by probing
 * a distinctive function. Retries reads to ride out public-RPC propagation lag.
 *
 * Run: npx hardhat run scripts/inventory.ts --network baseSepolia
 */
async function code(addr: string): Promise<string> {
  for (let i = 0; i < 8; i++) {
    const c = await ethers.provider.getCode(addr);
    if (c !== "0x") return c;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return "0x";
}

async function label(addr: string): Promise<string> {
  try {
    const c = await ethers.getContractAt("MockERC20", addr);
    if ((await c.decimals()) === 6n && (await c.symbol()) === "USDC") return "MockERC20 (USDC, 6 dec)";
  } catch {}
  try {
    const c = await ethers.getContractAt("EscrowFactory", addr);
    const fc = await c.feeCollector();
    const u = await c.usdc();
    return `EscrowFactory (feeCollector=${fc}, usdc=${u})`;
  } catch {}
  try {
    const c = await ethers.getContractAt("MettaPaySubnameRegistrar", addr);
    if ((await c.priceUsdc(1)) === 7_000_000n) return `MettaPaySubnameRegistrar (signer=${await c.signer()})`;
  } catch {}
  try {
    const c = await ethers.getContractAt("MockDurinRegistry", addr);
    await c.registerCalls();
    return "MockDurinRegistry";
  } catch {}
  return "unknown";
}

async function main() {
  const [d] = await ethers.getSigners();
  const nonce = await ethers.provider.getTransactionCount(d.address);
  console.log("Deployer:", d.address, " current nonce:", nonce, "\n");
  for (let n = Math.max(0, nonce - 8); n < nonce; n++) {
    const addr = ethers.getCreateAddress({ from: d.address, nonce: n });
    const c = await code(addr);
    if (c === "0x") continue; // that nonce was a value tx (e.g. mint), not a deploy
    console.log(`nonce ${n}: ${addr}  ->  ${await label(addr)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
