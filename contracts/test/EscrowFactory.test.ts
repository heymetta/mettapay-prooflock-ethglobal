import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import {
  ZERO,
  DAY,
  TERMS,
  DEFAULT_FEES,
  NET_BASE_MAINNET,
  NET_BASE_SEPOLIA,
} from "./helpers";

describe("EscrowFactory", () => {
  async function deployFixture() {
    const [deployer, buyer, seller, arbitrator, feeCollector, compliance, other] =
      await ethers.getSigners();
    const USDC = await ethers.getContractFactory("MockERC20");
    const usdc = await USDC.deploy("Mock USDC", "USDC", 6);
    await usdc.waitForDeployment();

    const baseArgs = {
      defaultArbitrator: arbitrator.address,
      networkMode: NET_BASE_SEPOLIA,
      defaultVerifier: ZERO,
      feeCollector: feeCollector.address,
      complianceOfficer: compliance.address,
      ...DEFAULT_FEES,
      usdc: await usdc.getAddress(),
    };

    const Factory = await ethers.getContractFactory("EscrowFactory");
    const factory = await Factory.deploy(baseArgs);
    await factory.waitForDeployment();

    return { Factory, deployer, buyer, seller, arbitrator, feeCollector, compliance, other, usdc, baseArgs, factory };
  }

  const future = async () => (await time.latest()) + 7 * DAY;
  const ONE_ETH = ethers.parseEther("1");

  // ─── Construction ────────────────────────────────────────────────────────
  describe("construction", () => {
    it("stores the schedule, owner, and wallets", async () => {
      const { factory, deployer, arbitrator, feeCollector, compliance } = await loadFixture(deployFixture);
      expect(await factory.owner()).to.equal(deployer.address);
      expect(await factory.defaultArbitrator()).to.equal(arbitrator.address);
      expect(await factory.feeCollector()).to.equal(feeCollector.address);
      expect(await factory.complianceOfficer()).to.equal(compliance.address);
      expect(await factory.depositFeeBps()).to.equal(DEFAULT_FEES.depositFeeBps);
      expect(await factory.disputeRefundFeeBps()).to.equal(DEFAULT_FEES.disputeRefundFeeBps);
    });

    it("USDC override wins; zero falls back to the canonical address per networkMode", async () => {
      const { Factory, baseArgs, usdc } = await loadFixture(deployFixture);

      const overridden = await Factory.deploy(baseArgs);
      expect(await overridden.usdc()).to.equal(await usdc.getAddress());

      const sepolia = await Factory.deploy({ ...baseArgs, usdc: ZERO, networkMode: NET_BASE_SEPOLIA });
      expect(await sepolia.usdc()).to.equal(await sepolia.BASE_SEPOLIA_USDC());

      const mainnet = await Factory.deploy({ ...baseArgs, usdc: ZERO, networkMode: NET_BASE_MAINNET });
      expect(await mainnet.usdc()).to.equal(await mainnet.BASE_MAINNET_USDC());
    });

    it("rejects zero arbitrator and invalid fee schedules", async () => {
      const { Factory, baseArgs } = await loadFixture(deployFixture);
      await expect(Factory.deploy({ ...baseArgs, defaultArbitrator: ZERO })).to.be.revertedWithCustomError(
        Factory,
        "InvalidAddress"
      );
      await expect(Factory.deploy({ ...baseArgs, depositFeeBps: 10_001 })).to.be.revertedWithCustomError(
        Factory,
        "InvalidFeeBps"
      );
      // sellerConsolationBps must not exceed disputeRefundFeeBps.
      await expect(
        Factory.deploy({ ...baseArgs, disputeRefundFeeBps: 200, sellerConsolationBps: 300 })
      ).to.be.revertedWithCustomError(Factory, "InvalidFeeBps");
    });
  });

  // ─── createBaseEthEscrow ─────────────────────────────────────────────────
  describe("createBaseEthEscrow", () => {
    it("creates, registers, and indexes the escrow for both parties", async () => {
      const { factory, buyer, seller } = await loadFixture(deployFixture);
      await expect(
        factory.connect(buyer).createBaseEthEscrow(seller.address, await future(), TERMS, ZERO, { value: ONE_ETH })
      ).to.emit(factory, "BaseEthEscrowCreated");

      expect(await factory.totalEscrows()).to.equal(1);
      const addr = await factory.escrowsById(1);
      expect(await factory.getEscrowsByUser(buyer.address)).to.deep.equal([addr]);
      expect(await factory.getEscrowsByUser(seller.address)).to.deep.equal([addr]);
    });

    it("validates seller, self-deal, amount, and deadline", async () => {
      const { factory, buyer, seller } = await loadFixture(deployFixture);
      await expect(
        factory.connect(buyer).createBaseEthEscrow(ZERO, await future(), TERMS, ZERO, { value: ONE_ETH })
      ).to.be.revertedWithCustomError(factory, "InvalidAddress");
      await expect(
        factory.connect(buyer).createBaseEthEscrow(buyer.address, await future(), TERMS, ZERO, { value: ONE_ETH })
      ).to.be.revertedWithCustomError(factory, "InvalidAddress");
      await expect(
        factory.connect(buyer).createBaseEthEscrow(seller.address, await future(), TERMS, ZERO, { value: 0 })
      ).to.be.revertedWithCustomError(factory, "InvalidAmount");
      await expect(
        factory.connect(buyer).createBaseEthEscrow(seller.address, (await time.latest()) - 1, TERMS, ZERO, {
          value: ONE_ETH,
        })
      ).to.be.revertedWithCustomError(factory, "InvalidDeadline");
    });

    it("verifierOverride is stamped into the escrow; zero uses defaultVerifier", async () => {
      const { Factory, baseArgs, buyer, seller, other } = await loadFixture(deployFixture);
      const factory = await Factory.deploy({ ...baseArgs, defaultVerifier: other.address });
      await factory.waitForDeployment();

      await factory.connect(buyer).createBaseEthEscrow(seller.address, await future(), TERMS, ZERO, { value: ONE_ETH });
      const e1 = await ethers.getContractAt("ProofLockEscrow", await factory.escrowsById(1));
      expect(await e1.verifier()).to.equal(other.address); // default used

      const override = ethers.Wallet.createRandom().address;
      await factory.connect(buyer).createBaseEthEscrow(seller.address, await future(), TERMS, override, { value: ONE_ETH });
      const e2 = await ethers.getContractAt("ProofLockEscrow", await factory.escrowsById(2));
      expect(await e2.verifier()).to.equal(override);
    });
  });

  // ─── createBaseUsdcEscrow ────────────────────────────────────────────────
  describe("createBaseUsdcEscrow", () => {
    const AMT = 500_000_000n; // 500 USDC

    it("pulls approved tokens and funds the escrow", async () => {
      const { factory, usdc, buyer, seller } = await loadFixture(deployFixture);
      await usdc.mint(buyer.address, AMT);
      await usdc.connect(buyer).approve(await factory.getAddress(), AMT);
      await expect(
        factory.connect(buyer).createBaseUsdcEscrow(seller.address, AMT, await future(), TERMS, ZERO)
      ).to.emit(factory, "BaseUsdcEscrowCreated");
      const escrow = await ethers.getContractAt("ProofLockEscrow", await factory.escrowsById(1));
      expect(await escrow.assetType()).to.equal(1);
    });

    it("reverts ERC20TransferFromFailed when the token returns false", async () => {
      const { Factory, baseArgs, buyer, seller } = await loadFixture(deployFixture);
      const Bad = await ethers.getContractFactory("MockERC20ReturnsFalse");
      const bad = await Bad.deploy();
      await bad.waitForDeployment();
      const factory = await Factory.deploy({ ...baseArgs, usdc: await bad.getAddress() });
      await factory.waitForDeployment();

      await bad.mint(buyer.address, AMT);
      await expect(
        factory.connect(buyer).createBaseUsdcEscrow(seller.address, AMT, await future(), TERMS, ZERO)
      ).to.be.revertedWithCustomError(factory, "ERC20TransferFromFailed");
    });
  });

  // ─── Owner administration ────────────────────────────────────────────────
  describe("owner administration", () => {
    it("updates owner / arbitrator / verifier / wallets with events, owner-gated", async () => {
      const { factory, deployer, other } = await loadFixture(deployFixture);

      await expect(factory.connect(other).updateOwner(other.address)).to.be.revertedWithCustomError(
        factory,
        "NotOwner"
      );
      await expect(factory.updateOwner(other.address)).to.emit(factory, "FactoryOwnerUpdated");
      expect(await factory.owner()).to.equal(other.address);

      // deployer is no longer owner.
      await expect(factory.connect(deployer).updateFeeCollector(other.address)).to.be.revertedWithCustomError(
        factory,
        "NotOwner"
      );
      await expect(factory.connect(other).updateDefaultVerifier(deployer.address)).to.emit(
        factory,
        "DefaultVerifierUpdated"
      );
    });

    it("rejects zero owner / zero arbitrator updates", async () => {
      const { factory } = await loadFixture(deployFixture);
      await expect(factory.updateOwner(ZERO)).to.be.revertedWithCustomError(factory, "InvalidAddress");
      await expect(factory.updateDefaultArbitrator(ZERO)).to.be.revertedWithCustomError(factory, "InvalidAddress");
    });

    it("updateFeeSchedule validates bounds and persists", async () => {
      const { factory } = await loadFixture(deployFixture);
      await expect(factory.updateFeeSchedule(10_001, 1, 1, 1, 1)).to.be.revertedWithCustomError(
        factory,
        "InvalidFeeBps"
      );
      await expect(factory.updateFeeSchedule(100, 100, 100, 100, 200)).to.be.revertedWithCustomError(
        factory,
        "InvalidFeeBps"
      );
      await expect(factory.updateFeeSchedule(100, 110, 120, 900, 200))
        .to.emit(factory, "FeeScheduleUpdated")
        .withArgs(100, 110, 120, 900, 200);
      expect(await factory.settleFeeBps()).to.equal(110);
      expect(await factory.sellerConsolationBps()).to.equal(200);
    });
  });
});
