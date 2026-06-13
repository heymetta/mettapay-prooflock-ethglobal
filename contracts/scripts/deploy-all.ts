import { ethers } from "hardhat";
import { saveDeployment, loadDeployments } from "./utils/deployments";

// Normalize to a valid EIP-55 checksum regardless of input casing.
const A = (s: string) => ethers.getAddress(s.toLowerCase());

/**
 * Clean, correct production-shaped deploy for Base Sepolia, consolidating every
 * client requirement:
 *   - EscrowFactory wired to REAL Circle USDC (not the mock)
 *   - MettaPaySubnameRegistrar wired to the REAL Durin registry + REAL USDC,
 *     with the client's backend signer and treasury baked into the constructor
 *   - Ownership of both handed to the client owner wallet immediately
 *
 * The inert ProofLockVerifier (0x364e9192...) is left as-is and NOT wired in
 * (Chainlink Functions retired on testnets), so escrows carry no dead verifier.
 *
 * Run: npx hardhat run scripts/deploy-all.ts --network baseSepolia
 */
const REAL_USDC = A("0x036cbd53842c5426634e7929541ec2318f3dcf7e"); // Circle USDC, Base Sepolia (6 dec)
const ETH_USD_FEED = A("0x4adc67696ba383f43dd60a9e78f2c97fbbfc7cb1"); // Chainlink ETH/USD, Base Sepolia
const DURIN_REGISTRY = A("0xd9dc8056f4c517fcbd93a7f90b490721e2909d6e"); // real mettapay.eth registry
const BACKEND_SIGNER = A("0x33c4223319015bfdb38ca144d8ce201ecd482871"); // client backend signer
const NEW_OWNER = A("0x7cc8f5e12d0b371971e9983ec45175303ef2394b"); // client owner
const TREASURY = A("0x7cc8f5e12d0b371971e9983ec45175303ef2394b"); // client treasury (owner can change)
const FEE_COLLECTOR = A("0xfa4269275689ebffe9299c0ee106c37a709b164b"); // client fee wallet
const COMPLIANCE_OFFICER = A("0x33c4223319015bfdb38ca144d8ce201ecd482871"); // client compliance wallet
const ARBITRATOR = A("0x7cc8f5e12d0b371971e9983ec45175303ef2394b"); // client resolves disputes
const ZERO = "0x0000000000000000000000000000000000000000";

async function main() {
  const [deployer] = await ethers.getSigners();
  const bal = await ethers.provider.getBalance(deployer.address);
  console.log("Deployer:", deployer.address, `(${ethers.formatEther(bal)} ETH)\n`);

  // ── EscrowFactory (real Circle USDC) ──────────────────────────────────────
  const args = {
    defaultArbitrator: ARBITRATOR,
    networkMode: 1, // BaseSepolia
    defaultVerifier: ZERO, // verifier inert on testnet; intentionally unwired
    feeCollector: FEE_COLLECTOR,
    complianceOfficer: COMPLIANCE_OFFICER,
    depositFeeBps: 290,
    settleFeeBps: 190,
    deadlineRefundFeeBps: 300,
    disputeRefundFeeBps: 900,
    sellerConsolationBps: 300,
    usdc: REAL_USDC,
  };
  // Reuse an already-deployed factory if it's wired to the real USDC (idempotent re-runs).
  let factoryAddr: string;
  let skipFactory = false;
  try {
    const existing = loadDeployments().contracts?.EscrowFactory;
    if (existing?.address && existing.usdc?.toLowerCase() === REAL_USDC.toLowerCase()) {
      factoryAddr = existing.address;
      skipFactory = true;
      console.log("EscrowFactory       :", factoryAddr, "(reusing existing — real USDC)");
    }
  } catch {
    /* no deployments yet */
  }

  if (!skipFactory) {
    const Factory = await ethers.getContractFactory("EscrowFactory");
    const factory = await Factory.deploy(args);
    await factory.waitForDeployment();
    factoryAddr = await factory.getAddress();
    console.log("EscrowFactory       :", factoryAddr);
    console.log("  factory.usdc()    :", await factory.getFunction("usdc").staticCall());
    await (await factory.updateOwner(NEW_OWNER)).wait();
    console.log("  owner -> ", NEW_OWNER);
    await saveDeployment("EscrowFactory", factoryAddr!, {
    constructorArgs: [args],
    owner: NEW_OWNER,
    usdc: REAL_USDC,
    feeCollector: FEE_COLLECTOR,
    complianceOfficer: COMPLIANCE_OFFICER,
    defaultArbitrator: ARBITRATOR,
    defaultVerifier: ZERO,
    verified: false,
    note: "ProofLock escrow factory wired to REAL Circle USDC. Owner = client.",
    });
  }

  // ── MettaPaySubnameRegistrar (real registry + real USDC) ──────────────────
  const Registrar = await ethers.getContractFactory("MettaPaySubnameRegistrar");
  const registrar = await Registrar.deploy(DURIN_REGISTRY, REAL_USDC, ETH_USD_FEED, TREASURY, BACKEND_SIGNER);
  await registrar.waitForDeployment();
  const registrarAddr = await registrar.getAddress();
  console.log("\nMettaPaySubnameRegistrar:", registrarAddr);
  // Critical writes first; cosmetic reads (subject to RPC read-after-write lag) must
  // never be able to abort before ownership transfer + recording.
  await (await registrar.transferOwnership(NEW_OWNER)).wait();
  console.log("  owner -> ", NEW_OWNER);
  try {
    console.log("  priceUsdc(1)      :", (await registrar.priceUsdc(1)).toString(), "(expect 7000000)");
    console.log("  signer            :", await registrar.getFunction("signer").staticCall());
    console.log("  treasury          :", await registrar.getFunction("treasury").staticCall());
  } catch {
    console.log("  (post-deploy reads lagged on this RPC — contract is deployed; verify separately)");
  }
  await saveDeployment("MettaPaySubnameRegistrar", registrarAddr, {
    constructorArgs: [DURIN_REGISTRY, REAL_USDC, ETH_USD_FEED, TREASURY, BACKEND_SIGNER],
    registry: DURIN_REGISTRY,
    usdc: REAL_USDC,
    ethUsdFeed: ETH_USD_FEED,
    treasury: TREASURY,
    signer: BACKEND_SIGNER,
    owner: NEW_OWNER,
    verified: false,
    note: "LIVE on real Durin mettapay.eth registry, REAL USDC, client signer+treasury+owner baked in. Needs registry.addRegistrar(this) before minting.",
  });

  console.log("\n── Verify ───────────────────────────────────────────────");
  console.log(`npx hardhat verify --network baseSepolia ${factoryAddr} '${JSON.stringify(args)}'`);
  console.log(
    `npx hardhat verify --network baseSepolia ${registrarAddr} ${DURIN_REGISTRY} ${REAL_USDC} ${ETH_USD_FEED} ${TREASURY} ${BACKEND_SIGNER}`
  );
  console.log("\nClient must run: registry.addRegistrar(" + registrarAddr + ") from " + "0x89d0d8cEE487346c2f00bAEA60d03d71E6aeAbA3");
}

main().catch((e) => { console.error(e); process.exit(1); });
