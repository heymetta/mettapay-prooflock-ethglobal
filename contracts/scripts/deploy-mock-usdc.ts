import { ethers } from "hardhat";
import { saveDeployment } from "./utils/deployments";

/**
 * Deploys a 6-decimal mock USDC for testnet smoke-testing and mints a balance
 * to the deployer. Base Sepolia has a canonical Circle USDC
 * (0x036CbD53842c5426634e7929541eC2318f3dCF7e), but it's faucet-gated; a mock
 * lets you mint freely and exercise the USDC escrow + paid-subname paths end to
 * end. Feed the printed address into the factory deploy via `USDC=0x...`.
 *
 * Env:
 *   MINT_TO      address to mint to (default: deployer)
 *   MINT_AMOUNT  human USDC units to mint (default: 1_000_000 → 1,000,000 USDC)
 *
 * Run: npx hardhat run scripts/deploy-mock-usdc.ts --network baseSepolia
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  const mintTo = process.env.MINT_TO ?? deployer.address;
  const amount = ethers.parseUnits(process.env.MINT_AMOUNT ?? "1000000", 6);

  const USDC = await ethers.getContractFactory("MockERC20");
  const usdc = await USDC.deploy("Mock USDC", "USDC", 6);
  await usdc.waitForDeployment();
  const addr = await usdc.getAddress();

  await (await usdc.mint(mintTo, amount)).wait();

  await saveDeployment("MockERC20_USDC", addr, {
    args: ["Mock USDC", "USDC", 6],
    note: "mintable test USDC (6 dec)",
  });

  console.log("MockERC20 (USDC, 6 dec):", addr);
  console.log(`Minted ${process.env.MINT_AMOUNT ?? "1000000"} USDC to ${mintTo}`);
  console.log(
    "\nWire it into the factory deploy:\n" +
      `  USDC=${addr} npx hardhat run scripts/deploy.ts --network baseSepolia\n` +
      `Or point the app at it:\n  (treat ${addr} as USDC for Base Sepolia testing)\n`
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
