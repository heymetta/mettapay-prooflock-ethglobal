import { ethers } from "hardhat";
import { deployedAddress } from "./utils/deployments";

/** Reads the live owner of each deployed contract. Run:
 *  npx hardhat run scripts/check-ownership.ts --network baseSepolia */
const NEW_OWNER = "0x7CC8F5E12d0b371971E9983EC45175303eF2394B".toLowerCase();
const DEPLOYER = "0x666aD10e4e95550A00DD2E298D3fb056b34cb9db".toLowerCase();

async function ownerOf(name: string): Promise<string> {
  const c = await ethers.getContractAt(["function owner() view returns (address)"], deployedAddress(name));
  return c.getFunction("owner").staticCall();
}

function tag(o: string): string {
  const l = o.toLowerCase();
  if (l === NEW_OWNER) return "NEW OWNER (client) ✓";
  if (l === DEPLOYER) return "still DEPLOYER";
  return "other";
}

async function main() {
  for (const name of ["EscrowFactory", "MettaPaySubnameRegistrar", "ProofLockVerifier"]) {
    try {
      const o = await ownerOf(name);
      console.log(`${name.padEnd(26)} owner = ${o}  [${tag(o)}]`);
    } catch (e: any) {
      console.log(`${name.padEnd(26)} (no owner / read failed: ${e.shortMessage || e.message})`);
    }
  }
  console.log("\nMockERC20_USDC             no owner (public mint) — N/A");
}

main().catch((e) => { console.error(e); process.exit(1); });
