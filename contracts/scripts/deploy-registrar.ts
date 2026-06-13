import { ethers } from "hardhat";
import { saveDeployment } from "./utils/deployments";

/**
 * Deploys MettaPaySubnameRegistrar to Base Sepolia via Hardhat (parity with the
 * Foundry script, for machines without forge).
 *
 * Registry handling:
 *   - If DURIN_L2_REGISTRY is a valid address, the registrar points at it.
 *     NOTE: the real Durin L2Registry exposes createSubnode/addRegistrar/owner,
 *     NOT register/setAddr/ownerOf — so a real Durin registry needs the
 *     registrar's IDurinL2Registry interface adapted first, or claims revert.
 *   - Otherwise this script deploys a MockDurinRegistry (matches the registrar's
 *     current interface) so the registrar is immediately callable for testing.
 *
 * Env (all optional on testnet — sensible defaults shown):
 *   DURIN_L2_REGISTRY   registry address (default: deploy a MockDurinRegistry)
 *   USDC                USDC token       (default: Base Sepolia Circle USDC)
 *   ETH_USD_FEED        Chainlink feed   (default: Base Sepolia ETH/USD)
 *   TREASURY            withdraw() sink  (default: deployer)
 *   BACKEND_SIGNER      free-name minter (default: deployer)
 *
 * Run: npx hardhat run scripts/deploy-registrar.ts --network baseSepolia
 */
const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const BASE_SEPOLIA_ETH_USD = "0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1";

async function main() {
  const [deployer] = await ethers.getSigners();
  const isAddr = (v?: string) => !!v && /^0x[0-9a-fA-F]{40}$/.test(v);

  let registry = process.env.DURIN_L2_REGISTRY;
  let registryNote = "provided Durin registry";
  if (!isAddr(registry)) {
    const Mock = await ethers.getContractFactory("MockDurinRegistry");
    const mock = await Mock.deploy();
    await mock.waitForDeployment();
    registry = await mock.getAddress();
    registryNote = "MockDurinRegistry (test-only, no real ENS resolution)";
    await saveDeployment("MockDurinRegistry", registry, {
      note: "test stand-in for Durin L2 Registry (no real ENS/CCIP)",
    });
  }

  const usdc = isAddr(process.env.USDC) ? (process.env.USDC as string) : BASE_SEPOLIA_USDC;
  const feed = isAddr(process.env.ETH_USD_FEED) ? (process.env.ETH_USD_FEED as string) : BASE_SEPOLIA_ETH_USD;
  const treasury = isAddr(process.env.TREASURY) ? (process.env.TREASURY as string) : deployer.address;
  const signer = isAddr(process.env.BACKEND_SIGNER) ? (process.env.BACKEND_SIGNER as string) : deployer.address;

  console.log("Deployer :", deployer.address);
  console.log("Registry :", registry, `(${registryNote})`);
  console.log("USDC     :", usdc);
  console.log("ETH/USD  :", feed);
  console.log("Treasury :", treasury);
  console.log("Signer   :", signer);

  const Registrar = await ethers.getContractFactory("MettaPaySubnameRegistrar");
  const registrar = await Registrar.deploy(registry, usdc, feed, treasury, signer);
  await registrar.waitForDeployment();
  const addr = await registrar.getAddress();
  // Print the address immediately — public RPCs can lag on read-after-write, so
  // never let a post-deploy view call hide the deployed address.
  console.log("\nMettaPaySubnameRegistrar:", addr);

  await saveDeployment("MettaPaySubnameRegistrar", addr, {
    constructorArgs: [registry, usdc, feed, treasury, signer],
    registry,
    usdc,
    ethUsdFeed: feed,
    treasury,
    signer,
    note: registryNote,
  });

  // Sanity: the live price oracle should answer. priceEth reverts on a stale
  // feed; priceUsdc can 0x-read on RPC lag — both are non-fatal here.
  try {
    console.log(`  priceUsdc(1) = ${await registrar.priceUsdc(1)}  (expect 7000000)`);
    console.log(`  priceEth(1)  = ${await registrar.priceEth(1)} wei`);
  } catch {
    console.log("  (price read deferred — RPC lag or stale feed; re-check shortly)");
  }
  console.log("\nUpdate app .env:");
  console.log(`  VITE_MP_SUBNAME_REGISTRAR=${addr}`);
  console.log(`  VITE_DURIN_L2_REGISTRY=${registry}`);
  console.log(
    "\nReminder: on a REAL Durin registry, authorize this registrar " +
      "(addRegistrar) and adapt IDurinL2Registry to createSubnode/owner first."
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
