import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import {
  ZERO,
  DAY,
  TERMS,
  DEFAULT_FEES,
  bps,
  ASSET_ETH,
  ASSET_USDC,
  Status,
  NET_BASE_SEPOLIA,
} from "./helpers";

/**
 * ProofLockEscrow — every use case in the buyer/seller/arbitrator lifecycle,
 * for both the ETH and USDC asset paths, plus the compliance consolation flow,
 * Chainlink Automation auto-refund, access control, and fee math.
 *
 * Escrows can only be created through EscrowFactory (the escrow's constructor
 * pins `factory = msg.sender`), so every fixture goes through the factory.
 */
describe("ProofLockEscrow", () => {
  async function deployFixture() {
    const [deployer, buyer, seller, arbitrator, feeCollector, compliance, other] =
      await ethers.getSigners();

    const USDC = await ethers.getContractFactory("MockERC20");
    const usdc = await USDC.deploy("Mock USDC", "USDC", 6);
    await usdc.waitForDeployment();

    const Factory = await ethers.getContractFactory("EscrowFactory");
    const factory = await Factory.deploy({
      defaultArbitrator: arbitrator.address,
      networkMode: NET_BASE_SEPOLIA,
      defaultVerifier: ZERO,
      feeCollector: feeCollector.address,
      complianceOfficer: compliance.address,
      ...DEFAULT_FEES,
      usdc: await usdc.getAddress(),
    });
    await factory.waitForDeployment();

    return { deployer, buyer, seller, arbitrator, feeCollector, compliance, other, usdc, factory };
  }

  async function deadline() {
    return (await time.latest()) + 7 * DAY;
  }

  async function createEthEscrow(factory: any, buyer: any, seller: any, amount: bigint) {
    await factory.connect(buyer).createBaseEthEscrow(seller.address, await deadline(), TERMS, ZERO, {
      value: amount,
    });
    const id = await factory.totalEscrows();
    const addr = await factory.escrowsById(id);
    return ethers.getContractAt("ProofLockEscrow", addr);
  }

  async function createUsdcEscrow(factory: any, usdc: any, buyer: any, seller: any, amount: bigint) {
    await usdc.mint(buyer.address, amount);
    await usdc.connect(buyer).approve(await factory.getAddress(), amount);
    await factory.connect(buyer).createBaseUsdcEscrow(seller.address, amount, await deadline(), TERMS, ZERO);
    const id = await factory.totalEscrows();
    const addr = await factory.escrowsById(id);
    return ethers.getContractAt("ProofLockEscrow", addr);
  }

  const ONE_ETH = ethers.parseEther("1");
  const USDC_AMT = 1_000_000_000n; // 1,000 USDC (6 dec)

  // ─── Creation / funding ──────────────────────────────────────────────────
  describe("creation & funding", () => {
    it("ETH escrow funds immediately and charges the deposit fee at creation", async () => {
      const { factory, buyer, seller, feeCollector } = await loadFixture(deployFixture);
      const fee = bps(ONE_ETH, DEFAULT_FEES.depositFeeBps);

      // feeCollector receives the deposit fee during the creation tx.
      await expect(
        factory.connect(buyer).createBaseEthEscrow(seller.address, await deadline(), TERMS, ZERO, {
          value: ONE_ETH,
        })
      ).to.changeEtherBalances([feeCollector, buyer], [fee, -ONE_ETH]);

      const escrow = await ethers.getContractAt("ProofLockEscrow", await factory.escrowsById(1));
      expect(await escrow.status()).to.equal(Status.Funded);
      expect(await escrow.netAmount()).to.equal(ONE_ETH - fee);
      expect(await ethers.provider.getBalance(await escrow.getAddress())).to.equal(ONE_ETH - fee);
      expect(await escrow.assetType()).to.equal(ASSET_ETH);
    });

    it("USDC escrow pulls tokens via the factory and funds through markFunded", async () => {
      const { factory, usdc, buyer, seller, feeCollector } = await loadFixture(deployFixture);
      const fee = bps(USDC_AMT, DEFAULT_FEES.depositFeeBps);

      await usdc.mint(buyer.address, USDC_AMT);
      await usdc.connect(buyer).approve(await factory.getAddress(), USDC_AMT);

      const escrow = await createUsdcEscrowNoMint(factory, buyer, seller, USDC_AMT);
      expect(await escrow.status()).to.equal(Status.Funded);
      expect(await escrow.netAmount()).to.equal(USDC_AMT - fee);
      expect(await usdc.balanceOf(feeCollector.address)).to.equal(fee);
      expect(await usdc.balanceOf(await escrow.getAddress())).to.equal(USDC_AMT - fee);
    });

    async function createUsdcEscrowNoMint(factory: any, buyer: any, seller: any, amount: bigint) {
      await factory.connect(buyer).createBaseUsdcEscrow(seller.address, amount, await deadline(), TERMS, ZERO);
      return ethers.getContractAt("ProofLockEscrow", await factory.escrowsById(await factory.totalEscrows()));
    }

    it("markFunded is factory-only", async () => {
      const { factory, usdc, buyer, seller, other } = await loadFixture(deployFixture);
      const escrow = await createUsdcEscrow(factory, usdc, buyer, seller, USDC_AMT);
      await expect(escrow.connect(other).markFunded()).to.be.revertedWithCustomError(escrow, "NotFactory");
    });

    it("rejects a direct ETH transfer (receive reverts)", async () => {
      const { factory, buyer, seller, other } = await loadFixture(deployFixture);
      const escrow = await createEthEscrow(factory, buyer, seller, ONE_ETH);
      await expect(
        other.sendTransaction({ to: await escrow.getAddress(), value: 1n })
      ).to.be.revertedWithCustomError(escrow, "InvalidStatus");
    });
  });

  // ─── Happy path: proof → approve → release ───────────────────────────────
  describe("approve & release", () => {
    it("ETH: seller submits proof, buyer approves, seller paid net of settle fee", async () => {
      const { factory, buyer, seller, feeCollector } = await loadFixture(deployFixture);
      const escrow = await createEthEscrow(factory, buyer, seller, ONE_ETH);
      const net = await escrow.netAmount();

      const pHash = ethers.keccak256(ethers.toUtf8Bytes("proof"));
      await expect(escrow.connect(seller).submitProof(pHash, "ipfs://proof"))
        .to.emit(escrow, "ProofSubmitted")
        .withArgs(await escrow.getAddress(), seller.address, pHash, "ipfs://proof");
      expect(await escrow.status()).to.equal(Status.ProofSubmitted);

      const settle = bps(net, DEFAULT_FEES.settleFeeBps);
      await expect(escrow.connect(buyer).approveAndRelease()).to.changeEtherBalances(
        [seller, feeCollector, await escrow.getAddress()],
        [net - settle, settle, -net]
      );
      expect(await escrow.status()).to.equal(Status.Released);
    });

    it("USDC: full happy path settles in tokens", async () => {
      const { factory, usdc, buyer, seller, feeCollector } = await loadFixture(deployFixture);
      const escrow = await createUsdcEscrow(factory, usdc, buyer, seller, USDC_AMT);
      const net = await escrow.netAmount();
      const settle = bps(net, DEFAULT_FEES.settleFeeBps);

      await escrow.connect(seller).submitProof(ethers.keccak256(ethers.toUtf8Bytes("p")), "u");
      await expect(escrow.connect(buyer).approveAndRelease()).to.changeTokenBalances(
        usdc,
        [seller, feeCollector],
        [net - settle, settle]
      );
      expect(await escrow.status()).to.equal(Status.Released);
    });

    it("only the seller can submit proof, only before the deadline", async () => {
      const { factory, buyer, seller, other } = await loadFixture(deployFixture);
      const escrow = await createEthEscrow(factory, buyer, seller, ONE_ETH);
      const p = ethers.keccak256(ethers.toUtf8Bytes("p"));
      await expect(escrow.connect(other).submitProof(p, "u")).to.be.revertedWithCustomError(escrow, "NotSeller");
      await expect(escrow.connect(seller).submitProof(ethers.ZeroHash, "u")).to.be.revertedWithCustomError(
        escrow,
        "InvalidAmount"
      );
      await time.increase(8 * DAY);
      await expect(escrow.connect(seller).submitProof(p, "u")).to.be.revertedWithCustomError(escrow, "DeadlinePassed");
    });

    it("only the buyer can approve, and only from ProofSubmitted", async () => {
      const { factory, buyer, seller, other } = await loadFixture(deployFixture);
      const escrow = await createEthEscrow(factory, buyer, seller, ONE_ETH);
      await expect(escrow.connect(buyer).approveAndRelease()).to.be.revertedWithCustomError(escrow, "InvalidStatus");
      await escrow.connect(seller).submitProof(ethers.keccak256(ethers.toUtf8Bytes("p")), "u");
      await expect(escrow.connect(other).approveAndRelease()).to.be.revertedWithCustomError(escrow, "NotBuyer");
    });
  });

  // ─── Dispute → arbitration ───────────────────────────────────────────────
  describe("dispute & resolution", () => {
    it("buyer disputes; arbitrator splits; consolation accrues in-contract", async () => {
      const { factory, buyer, seller, arbitrator, feeCollector } = await loadFixture(deployFixture);
      const escrow = await createEthEscrow(factory, buyer, seller, ONE_ETH);
      const net = await escrow.netAmount();
      await escrow.connect(seller).submitProof(ethers.keccak256(ethers.toUtf8Bytes("p")), "u");
      await escrow.connect(buyer).dispute("item not as described");
      expect(await escrow.status()).to.equal(Status.Disputed);

      const buyerAward = net / 2n;
      const sellerAward = net - buyerAward;

      // buyer-award side: 9% total fee, 3% of which is seller consolation (held).
      const totalFee = bps(buyerAward, DEFAULT_FEES.disputeRefundFeeBps);
      const consolation = bps(buyerAward, DEFAULT_FEES.sellerConsolationBps);
      const platformFee = totalFee - consolation;
      const buyerNet = buyerAward - platformFee - consolation;
      // seller-award side: ordinary settle fee.
      const sellerSettle = bps(sellerAward, DEFAULT_FEES.settleFeeBps);
      const sellerNet = sellerAward - sellerSettle;

      await expect(escrow.connect(arbitrator).resolveDispute(buyerAward, sellerAward)).to.changeEtherBalances(
        [buyer, seller, feeCollector],
        [buyerNet, sellerNet, platformFee + sellerSettle]
      );
      expect(await escrow.status()).to.equal(Status.Released);
      expect(await escrow.sellerConsolationAccrued()).to.equal(consolation);
      // consolation stays inside the escrow pending compliance review.
      expect(await ethers.provider.getBalance(await escrow.getAddress())).to.equal(consolation);
    });

    it("resolveDispute requires buyerAward + sellerAward == netAmount", async () => {
      const { factory, buyer, seller, arbitrator } = await loadFixture(deployFixture);
      const escrow = await createEthEscrow(factory, buyer, seller, ONE_ETH);
      const net = await escrow.netAmount();
      await escrow.connect(seller).submitProof(ethers.keccak256(ethers.toUtf8Bytes("p")), "u");
      await escrow.connect(buyer).dispute("x");
      await expect(escrow.connect(arbitrator).resolveDispute(net, 1n)).to.be.revertedWithCustomError(
        escrow,
        "InvalidResolution"
      );
    });

    it("only the arbitrator resolves; only the buyer disputes; only from ProofSubmitted", async () => {
      const { factory, buyer, seller, arbitrator, other } = await loadFixture(deployFixture);
      const escrow = await createEthEscrow(factory, buyer, seller, ONE_ETH);
      await expect(escrow.connect(buyer).dispute("x")).to.be.revertedWithCustomError(escrow, "InvalidStatus");
      await escrow.connect(seller).submitProof(ethers.keccak256(ethers.toUtf8Bytes("p")), "u");
      await expect(escrow.connect(seller).dispute("x")).to.be.revertedWithCustomError(escrow, "NotBuyer");
      await escrow.connect(buyer).dispute("x");
      await expect(escrow.connect(other).resolveDispute(0, await escrow.netAmount())).to.be.revertedWithCustomError(
        escrow,
        "NotArbitrator"
      );
    });

    it("full buyer-award (sellerAward = 0) still accrues consolation and refunds buyer", async () => {
      const { factory, buyer, seller, arbitrator, feeCollector } = await loadFixture(deployFixture);
      const escrow = await createEthEscrow(factory, buyer, seller, ONE_ETH);
      const net = await escrow.netAmount();
      await escrow.connect(seller).submitProof(ethers.keccak256(ethers.toUtf8Bytes("p")), "u");
      await escrow.connect(buyer).dispute("x");

      const totalFee = bps(net, DEFAULT_FEES.disputeRefundFeeBps);
      const consolation = bps(net, DEFAULT_FEES.sellerConsolationBps);
      const platformFee = totalFee - consolation;
      await expect(escrow.connect(arbitrator).resolveDispute(net, 0)).to.changeEtherBalances(
        [buyer, feeCollector],
        [net - platformFee - consolation, platformFee]
      );
      expect(await escrow.sellerConsolationAccrued()).to.equal(consolation);
    });
  });

  // ─── Compliance: release / forfeit consolation ───────────────────────────
  describe("seller consolation (compliance)", () => {
    async function disputedFixture() {
      const f = await loadFixture(deployFixture);
      const escrow = await createEthEscrow(f.factory, f.buyer, f.seller, ONE_ETH);
      const net = await escrow.netAmount();
      await escrow.connect(f.seller).submitProof(ethers.keccak256(ethers.toUtf8Bytes("p")), "u");
      await escrow.connect(f.buyer).dispute("x");
      await escrow.connect(f.arbitrator).resolveDispute(net, 0);
      const consolation = bps(net, DEFAULT_FEES.sellerConsolationBps);
      return { ...f, escrow, consolation };
    }

    it("compliance officer releases consolation to the seller", async () => {
      const { escrow, compliance, seller, consolation } = await disputedFixture();
      await expect(escrow.connect(compliance).releaseSellerConsolation()).to.changeEtherBalances(
        [seller, await escrow.getAddress()],
        [consolation, -consolation]
      );
      expect(await escrow.sellerConsolationResolved()).to.equal(true);
      expect(await escrow.sellerConsolationAccrued()).to.equal(0);
    });

    it("compliance officer forfeits consolation to the fee collector", async () => {
      const { escrow, compliance, feeCollector, consolation } = await disputedFixture();
      await expect(escrow.connect(compliance).forfeitSellerConsolation()).to.changeEtherBalances(
        [feeCollector, await escrow.getAddress()],
        [consolation, -consolation]
      );
      expect(await escrow.sellerConsolationResolved()).to.equal(true);
    });

    it("consolation is one-shot and compliance-gated", async () => {
      const { escrow, compliance, other } = await disputedFixture();
      await expect(escrow.connect(other).releaseSellerConsolation()).to.be.revertedWithCustomError(
        escrow,
        "NotComplianceOfficer"
      );
      await escrow.connect(compliance).releaseSellerConsolation();
      await expect(escrow.connect(compliance).forfeitSellerConsolation()).to.be.revertedWithCustomError(
        escrow,
        "AlreadyResolved"
      );
    });
  });

  // ─── Deadline refunds ────────────────────────────────────────────────────
  describe("deadline refunds", () => {
    it("buyer refundAfterDeadline once the deadline passes (flat fee to collector)", async () => {
      const { factory, buyer, seller, feeCollector } = await loadFixture(deployFixture);
      const escrow = await createEthEscrow(factory, buyer, seller, ONE_ETH);
      const net = await escrow.netAmount();

      await expect(escrow.connect(buyer).refundAfterDeadline()).to.be.revertedWithCustomError(
        escrow,
        "DeadlineNotPassed"
      );
      await time.increase(8 * DAY);
      const fee = bps(net, DEFAULT_FEES.deadlineRefundFeeBps);
      await expect(escrow.connect(buyer).refundAfterDeadline()).to.changeEtherBalances(
        [buyer, feeCollector],
        [net - fee, fee]
      );
      expect(await escrow.status()).to.equal(Status.Refunded);
    });

    it("seller goodwill cancel refunds buyer the full net with no extra fee", async () => {
      const { factory, buyer, seller, feeCollector } = await loadFixture(deployFixture);
      const escrow = await createEthEscrow(factory, buyer, seller, ONE_ETH);
      const net = await escrow.netAmount();
      await expect(escrow.connect(seller).sellerCancelAndRefund()).to.changeEtherBalances(
        [buyer, feeCollector],
        [net, 0]
      );
      expect(await escrow.status()).to.equal(Status.Refunded);
    });
  });

  // ─── Chainlink Automation auto-refund ────────────────────────────────────
  describe("Chainlink Automation auto-refund", () => {
    it("checkUpkeep flips true only after the deadline while Funded", async () => {
      const { factory, buyer, seller } = await loadFixture(deployFixture);
      const escrow = await createEthEscrow(factory, buyer, seller, ONE_ETH);
      expect((await escrow.checkUpkeep("0x"))[0]).to.equal(false);
      await time.increase(8 * DAY);
      expect((await escrow.checkUpkeep("0x"))[0]).to.equal(true);
    });

    it("performUpkeep (anyone) auto-refunds the buyer after the deadline", async () => {
      const { factory, buyer, seller, other } = await loadFixture(deployFixture);
      const escrow = await createEthEscrow(factory, buyer, seller, ONE_ETH);
      const net = await escrow.netAmount();
      await time.increase(8 * DAY);
      const fee = bps(net, DEFAULT_FEES.deadlineRefundFeeBps);
      await expect(escrow.connect(other).performUpkeep("0x"))
        .to.emit(escrow, "AutoRefundTriggered")
        .withArgs(await escrow.getAddress(), other.address, ASSET_ETH, net - fee);
      expect(await escrow.status()).to.equal(Status.Refunded);
    });
  });

  // ─── Verifier flag (informational) ───────────────────────────────────────
  describe("isVerifierApproved flag", () => {
    it("returns false with no verifier, mirrors the verifier result, and is safe if it reverts", async () => {
      const { arbitrator, feeCollector, compliance, usdc, buyer, seller } = await loadFixture(deployFixture);

      const Verifier = await ethers.getContractFactory("MockProofLockVerifier");
      const verifier = await Verifier.deploy();
      await verifier.waitForDeployment();

      const Factory = await ethers.getContractFactory("EscrowFactory");
      const factory = await Factory.deploy({
        defaultArbitrator: arbitrator.address,
        networkMode: NET_BASE_SEPOLIA,
        defaultVerifier: await verifier.getAddress(),
        feeCollector: feeCollector.address,
        complianceOfficer: compliance.address,
        ...DEFAULT_FEES,
        usdc: await usdc.getAddress(),
      });
      await factory.waitForDeployment();
      const escrow = await createEthEscrow(factory, buyer, seller, ONE_ETH);

      expect(await escrow.isVerifierApproved()).to.equal(false);
      await verifier.setResult(await escrow.getAddress(), true, "ok");
      expect(await escrow.isVerifierApproved()).to.equal(true);
      await verifier.setReverts(true);
      expect(await escrow.isVerifierApproved()).to.equal(false); // try/catch swallows
    });
  });

  // ─── Fees disabled (zero feeCollector) ───────────────────────────────────
  describe("fees disabled", () => {
    it("no deposit/settle fee is taken when feeCollector is zero", async () => {
      const [, buyer, seller, arbitrator] = await ethers.getSigners();
      const Factory = await ethers.getContractFactory("EscrowFactory");
      const factory = await Factory.deploy({
        defaultArbitrator: arbitrator.address,
        networkMode: NET_BASE_SEPOLIA,
        defaultVerifier: ZERO,
        feeCollector: ZERO,
        complianceOfficer: ZERO,
        ...DEFAULT_FEES,
        usdc: ZERO,
      });
      await factory.waitForDeployment();
      const escrow = await createEthEscrow(factory, buyer, seller, ONE_ETH);
      expect(await escrow.netAmount()).to.equal(ONE_ETH); // no deposit fee
      await escrow.connect(seller).submitProof(ethers.keccak256(ethers.toUtf8Bytes("p")), "u");
      await expect(escrow.connect(buyer).approveAndRelease()).to.changeEtherBalances([seller], [ONE_ETH]);
    });
  });
});
