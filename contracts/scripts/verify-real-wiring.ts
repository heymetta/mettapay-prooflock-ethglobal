import { ethers } from "hardhat";

const REGISTRAR = "0x563D6F6f089013693315eD17F02D67a27A80c2C3";
const REGISTRY = "0xd9dc8056f4c517fcbd93a7f90b490721e2909d6e";

async function main() {
  const [me] = await ethers.getSigners();
  const r = await ethers.getContractAt("MettaPaySubnameRegistrar", REGISTRAR);
  const reg = new ethers.Contract(
    REGISTRY,
    [
      "function registrars(address) view returns (bool)",
      "function baseNode() view returns (bytes32)",
      "function owner() view returns (address)",
      "function makeNode(bytes32,string) view returns (bytes32)",
    ],
    ethers.provider
  );

  console.log("Registrar:", REGISTRAR);
  console.log("  registry()    =", await r.registry(), (await r.registry()).toLowerCase() === REGISTRY ? "✓ real registry" : "");
  console.log("  signer()      =", await r.signer());
  console.log("  priceUsdc(1)  =", (await r.priceUsdc(1)).toString());
  try {
    console.log("  priceEth(1)   =", (await r.priceEth(1)).toString(), "wei");
  } catch {
    console.log("  priceEth(1)   = (feed read deferred)");
  }

  console.log("\nReal Durin registry:", REGISTRY);
  console.log("  name          = mettapay.eth");
  console.log("  admin owner() =", await reg.owner(), "(client wallet)");
  console.log("  registrars(ourRegistrar) =", await reg.registrars(REGISTRAR), "  <-- must become true");

  // Prove the only blocker is authorization: claimFree should revert at the
  // registry (not authorized), nothing else.
  const label = "0x" + me.address.slice(2, 7).toLowerCase();
  process.stdout.write(`\nclaimFree("${label}") staticCall (as signer): `);
  try {
    await r.claimFree.staticCall(label, me.address);
    console.log("SUCCEEDS — already authorized!");
  } catch (e: any) {
    console.log("reverts (expected until addRegistrar)\n   reason:", e.shortMessage || e.message);
  }

  console.log("\n>>> CLIENT ACTION (from admin wallet " + (await reg.owner()) + "):");
  console.log(`    ${REGISTRY}.addRegistrar(${REGISTRAR})`);
}
main().catch((e) => { console.error(e); process.exit(1); });
