import { ethers } from "hardhat";

/**
 * Read-only recon of the real Durin L2Registry: confirms the interface matches,
 * the deployer is the admin (so it can addRegistrar), and prints baseNode.
 *
 * Env: REGISTRY (the Durin L2 Registry address)
 * Run: REGISTRY=0x... npx hardhat run scripts/recon-registry.ts --network baseSepolia
 */
const ABI = [
  "function baseNode() view returns (bytes32)",
  "function owner() view returns (address)",
  "function owner(bytes32) view returns (address)",
  "function makeNode(bytes32,string) view returns (bytes32)",
  "function registrars(address) view returns (bool)",
  "function name() view returns (string)",
];

async function main() {
  const [me] = await ethers.getSigners();
  const addr = process.env.REGISTRY;
  if (!addr) throw new Error("REGISTRY env var required");
  const code = await ethers.provider.getCode(addr);
  console.log("Registry :", addr, code === "0x" ? "(NO CODE!)" : `(code ${code.length} bytes)`);
  if (code === "0x") return;

  const r = new ethers.Contract(addr, ABI, me);
  const out = async (label: string, fn: () => Promise<any>) => {
    try {
      console.log(`  ${label.padEnd(22)} ${await fn()}`);
    } catch (e: any) {
      console.log(`  ${label.padEnd(22)} <fail: ${e.shortMessage || e.message}>`);
    }
  };

  await out("name()", () => r.name());
  await out("baseNode()", () => r.baseNode());
  let admin = "";
  await out("owner() [admin]", async () => (admin = await r["owner()"]()));
  await out("deployer is admin?", async () => (await r["owner()"]()) === me.address);
  await out("registrars(deployer)", () => r.registrars(me.address));
  await out("makeNode(base,'0xtest')", async () => r.makeNode(await r.baseNode(), "0xtest"));
  console.log("\nDeployer:", me.address);
}

main().catch((e) => { console.error(e); process.exit(1); });
