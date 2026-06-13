import { ethers } from "hardhat";
import { deployedAddress } from "./utils/deployments";

/**
 * One-time admin handoff requested by the client (run from the deployer wallet,
 * which is the current owner of both contracts). Order matters: setSigner needs
 * owner rights, so it runs BEFORE ownership is transferred away.
 *
 *   1. registrar.setSigner(NEW_SIGNER)        <- enables the client's backend to mint
 *   2. registrar.transferOwnership(NEW_OWNER)
 *   3. factory.updateOwner(NEW_OWNER)
 *
 * After this the deployer has NO admin control over either contract.
 *
 * Run: npx hardhat run scripts/admin-handoff.ts --network baseSepolia
 */
const NEW_SIGNER = ethers.getAddress("0x33c4223319015BFDb38CA144d8cE201ecd482871"); // backend signer
const NEW_OWNER = ethers.getAddress("0x7CC8F5E12d0b371971E9983EC45175303eF2394B"); // new owner

async function main() {
  const [deployer] = await ethers.getSigners();
  const registrar = await ethers.getContractAt("MettaPaySubnameRegistrar", deployedAddress("MettaPaySubnameRegistrar"));
  const factory = await ethers.getContractAt("EscrowFactory", deployedAddress("EscrowFactory"));

  const read = (c: any, fn: string) => c.getFunction(fn).staticCall();
  const regOwner0 = await read(registrar, "owner");
  const facOwner0 = await read(factory, "owner");
  console.log("Deployer        :", deployer.address);
  console.log("Registrar       :", await registrar.getAddress(), " owner:", regOwner0);
  console.log("Factory         :", await factory.getAddress(), " owner:", facOwner0);
  console.log("New signer      :", NEW_SIGNER);
  console.log("New owner       :", NEW_OWNER, "\n");

  if (regOwner0.toLowerCase() !== deployer.address.toLowerCase())
    throw new Error("deployer is not the registrar owner — aborting (already handed off?)");
  if (facOwner0.toLowerCase() !== deployer.address.toLowerCase())
    throw new Error("deployer is not the factory owner — aborting (already handed off?)");

  const txs: { label: string; hash: string }[] = [];
  const send = async (label: string, p: Promise<any>) => {
    const tx = await p;
    await tx.wait();
    txs.push({ label, hash: tx.hash });
    console.log(`  ✓ ${label}`);
  };

  await send("registrar.setSigner(backend)", registrar.setSigner(NEW_SIGNER));
  await send("registrar.transferOwnership(newOwner)", registrar.transferOwnership(NEW_OWNER));
  await send("factory.updateOwner(newOwner)", factory.updateOwner(NEW_OWNER));

  const signer = await read(registrar, "signer");
  const regOwner = await read(registrar, "owner");
  const facOwner = await read(factory, "owner");
  const ok = (a: string, b: string) => (a.toLowerCase() === b.toLowerCase() ? "✓" : "✗ MISMATCH");
  console.log("\nFinal on-chain state:");
  console.log("  registrar.signer :", signer, ok(signer, NEW_SIGNER));
  console.log("  registrar.owner  :", regOwner, ok(regOwner, NEW_OWNER));
  console.log("  factory.owner    :", facOwner, ok(facOwner, NEW_OWNER));

  console.log("\nTransactions (Basescan):");
  for (const t of txs) console.log(`  ${t.label.padEnd(38)} https://sepolia.basescan.org/tx/${t.hash}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
