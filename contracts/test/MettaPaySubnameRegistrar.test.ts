import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { ZERO, DAY } from "./helpers";

/**
 * MettaPaySubnameRegistrar — free / paid / renew / setAddr tiers, the Chainlink
 * ETH/USD pricing + staleness guard, label validation rules, and admin/pause/
 * withdraw. Runs against a MockDurinRegistry (the registrar must be authorized
 * as a controller — the mock accepts calls unless `locked`), a 6-decimal mock
 * USDC, and a mock ETH/USD feed.
 */
describe("MettaPaySubnameRegistrar", () => {
  const YEAR = 365 * DAY;
  const PRICE = { 1: 7_000_000n, 3: 17_000_000n, 5: 30_000_000n } as const;
  const FEED_DECIMALS = 8;
  const ETH_USD = 2000n * 10n ** 8n; // $2000 / ETH

  // wei = usd6 * 10^(18 + feedDec - 6) / answer
  function ethPrice(years_: 1 | 3 | 5): bigint {
    const usd6 = PRICE[years_];
    return (usd6 * 10n ** (18n + BigInt(FEED_DECIMALS) - 6n)) / ETH_USD;
  }

  async function deployFixture() {
    const [owner, signer, treasury, alice, bob] = await ethers.getSigners();

    const Registry = await ethers.getContractFactory("MockDurinRegistry");
    const registry = await Registry.deploy();
    await registry.waitForDeployment();

    const USDC = await ethers.getContractFactory("MockERC20");
    const usdc = await USDC.deploy("Mock USDC", "USDC", 6);
    await usdc.waitForDeployment();

    const Feed = await ethers.getContractFactory("MockV3Aggregator");
    const feed = await Feed.deploy(FEED_DECIMALS, ETH_USD);
    await feed.waitForDeployment();

    const Registrar = await ethers.getContractFactory("MettaPaySubnameRegistrar");
    const registrar = await Registrar.deploy(
      await registry.getAddress(),
      await usdc.getAddress(),
      await feed.getAddress(),
      treasury.address,
      signer.address
    );
    await registrar.waitForDeployment();

    return { owner, signer, treasury, alice, bob, registry, usdc, feed, registrar };
  }

  const lh = (label: string) => ethers.keccak256(ethers.toUtf8Bytes(label));
  // Durin node = keccak256(parentNode, keccak256(label)); mock baseNode = keccak256("mettapay.eth").
  const BASE_NODE = ethers.keccak256(ethers.toUtf8Bytes("mettapay.eth"));
  const node = (label: string) =>
    ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32"], [BASE_NODE, lh(label)]));

  // ─── Pricing ─────────────────────────────────────────────────────────────
  describe("pricing", () => {
    it("USDC prices are fixed per term; bad term reverts", async () => {
      const { registrar } = await loadFixture(deployFixture);
      expect(await registrar.priceUsdc(1)).to.equal(PRICE[1]);
      expect(await registrar.priceUsdc(3)).to.equal(PRICE[3]);
      expect(await registrar.priceUsdc(5)).to.equal(PRICE[5]);
      await expect(registrar.priceUsdc(2)).to.be.revertedWithCustomError(registrar, "BadYears");
    });

    it("ETH price is derived from the Chainlink feed", async () => {
      const { registrar } = await loadFixture(deployFixture);
      expect(await registrar.priceEth(1)).to.equal(ethPrice(1));
      expect(await registrar.priceEth(5)).to.equal(ethPrice(5));
    });

    it("reverts on a stale or non-positive feed answer", async () => {
      const { registrar, feed } = await loadFixture(deployFixture);
      await feed.setUpdatedAt(1); // ancient
      await expect(registrar.priceEth(1)).to.be.revertedWithCustomError(registrar, "StalePrice");
      await feed.updateAnswer(0); // refreshes updatedAt but answer <= 0
      await expect(registrar.priceEth(1)).to.be.revertedWithCustomError(registrar, "StalePrice");
    });
  });

  // ─── Free tier ───────────────────────────────────────────────────────────
  describe("free tier (claimFree)", () => {
    const FREE = "0xabcde"; // 0x + 5 hex

    it("signer mints the deterministic free name; registry is updated", async () => {
      const { registrar, registry, signer, alice } = await loadFixture(deployFixture);
      await expect(registrar.connect(signer).claimFree(FREE, alice.address))
        .to.emit(registrar, "FreeClaimed")
        .withArgs(lh(FREE), FREE, alice.address);

      const rec = await registrar.recordOf(FREE);
      expect(rec.holder).to.equal(alice.address);
      expect(rec.expiresAt).to.equal(0);
      expect(rec.paid).to.equal(false);
      expect(await registry.owner(node(FREE))).to.equal(alice.address);
      expect(await registry.createSubnodeCalls()).to.equal(1);
    });

    it("only the backend signer can claim free names", async () => {
      const { registrar, alice } = await loadFixture(deployFixture);
      await expect(registrar.connect(alice).claimFree(FREE, alice.address)).to.be.revertedWithCustomError(
        registrar,
        "NotSigner"
      );
    });

    it("rejects malformed free labels and double-claims", async () => {
      const { registrar, signer, alice } = await loadFixture(deployFixture);
      await expect(registrar.connect(signer).claimFree("0xabc", alice.address)).to.be.revertedWithCustomError(
        registrar,
        "BadLabel"
      ); // too short
      await expect(registrar.connect(signer).claimFree("0xabcdg", alice.address)).to.be.revertedWithCustomError(
        registrar,
        "BadLabel"
      ); // 'g' not hex
      await registrar.connect(signer).claimFree(FREE, alice.address);
      await expect(registrar.connect(signer).claimFree(FREE, alice.address)).to.be.revertedWithCustomError(
        registrar,
        "LabelTaken"
      );
    });
  });

  // ─── Paid tier (USDC) ────────────────────────────────────────────────────
  describe("paid tier — USDC", () => {
    async function fundedAlice() {
      const f = await loadFixture(deployFixture);
      await f.usdc.mint(f.alice.address, 1_000_000_000n);
      await f.usdc.connect(f.alice).approve(await f.registrar.getAddress(), 1_000_000_000n);
      return f;
    }

    it("claims a custom label, charges USDC, sets expiry, updates registry", async () => {
      const { registrar, registry, usdc, alice } = await fundedAlice();
      const label = "alice";
      await expect(registrar.connect(alice).claimPaidUsdc(label, 1)).to.changeTokenBalances(
        usdc,
        [alice, registrar],
        [-PRICE[1], PRICE[1]]
      );
      const rec = await registrar.recordOf(label);
      expect(rec.holder).to.equal(alice.address);
      expect(rec.paid).to.equal(true);
      expect(rec.expiresAt).to.equal(BigInt(await time.latest()) + BigInt(YEAR));
      expect(await registry.owner(node(label))).to.equal(alice.address);
    });

    it("charges the 3y/5y tiers correctly", async () => {
      const { registrar, usdc, alice } = await fundedAlice();
      await expect(registrar.connect(alice).claimPaidUsdc("three", 3)).to.changeTokenBalance(
        usdc,
        registrar,
        PRICE[3]
      );
      await expect(registrar.connect(alice).claimPaidUsdc("five", 5)).to.changeTokenBalance(
        usdc,
        registrar,
        PRICE[5]
      );
    });

    it("reverts TransferFailed when the token returns false", async () => {
      const { owner, signer, treasury, alice } = await loadFixture(deployFixture);
      const Registry = await ethers.getContractFactory("MockDurinRegistry");
      const registry = await Registry.deploy();
      const Feed = await ethers.getContractFactory("MockV3Aggregator");
      const feed = await Feed.deploy(FEED_DECIMALS, ETH_USD);
      const Bad = await ethers.getContractFactory("MockERC20ReturnsFalse");
      const bad = await Bad.deploy();
      const Registrar = await ethers.getContractFactory("MettaPaySubnameRegistrar");
      const registrar = await Registrar.deploy(
        await registry.getAddress(),
        await bad.getAddress(),
        await feed.getAddress(),
        treasury.address,
        signer.address
      );
      await bad.mint(alice.address, PRICE[1]);
      await bad.connect(alice).approve(await registrar.getAddress(), PRICE[1]);
      await expect(registrar.connect(alice).claimPaidUsdc("alice", 1)).to.be.revertedWithCustomError(
        registrar,
        "TransferFailed"
      );
    });
  });

  // ─── Paid tier (ETH) ─────────────────────────────────────────────────────
  describe("paid tier — ETH", () => {
    it("claims with exact ETH and refunds overpayment", async () => {
      const { registrar, alice } = await loadFixture(deployFixture);
      const quote = await registrar.priceEth(1);

      // underpay reverts
      await expect(registrar.connect(alice).claimPaidEth("aliceeth", 1, { value: quote - 1n }))
        .to.be.revertedWithCustomError(registrar, "WrongValue");

      // overpay by 1 ETH → only `quote` is kept, the rest is refunded.
      await expect(
        registrar.connect(alice).claimPaidEth("aliceeth", 1, { value: quote + ethers.parseEther("1") })
      ).to.changeEtherBalance(registrar, quote);

      const rec = await registrar.recordOf("aliceeth");
      expect(rec.paid).to.equal(true);
      expect(rec.expiresAt).to.equal(BigInt(await time.latest()) + BigInt(YEAR));
    });
  });

  // ─── Renewals ────────────────────────────────────────────────────────────
  describe("renewals", () => {
    async function paid() {
      const f = await loadFixture(deployFixture);
      await f.usdc.mint(f.alice.address, 1_000_000_000n);
      await f.usdc.connect(f.alice).approve(await f.registrar.getAddress(), 1_000_000_000n);
      await f.registrar.connect(f.alice).claimPaidUsdc("alice", 1);
      return f;
    }

    it("extends from the current expiry while still active", async () => {
      const { registrar, alice } = await paid();
      const before = (await registrar.recordOf("alice")).expiresAt;
      await registrar.connect(alice).renewUsdc("alice", 1);
      expect((await registrar.recordOf("alice")).expiresAt).to.equal(before + BigInt(YEAR));
    });

    it("extends from now once expired", async () => {
      const { registrar, alice } = await paid();
      await time.increase(2 * YEAR); // let it lapse
      await registrar.connect(alice).renewUsdc("alice", 1);
      expect((await registrar.recordOf("alice")).expiresAt).to.equal(BigInt(await time.latest()) + BigInt(YEAR));
    });

    it("free / unknown labels cannot be renewed", async () => {
      const { registrar, signer, alice } = await loadFixture(deployFixture);
      await registrar.connect(signer).claimFree("0xabcde", alice.address);
      await expect(registrar.connect(alice).renewUsdc("0xabcde", 1)).to.be.revertedWithCustomError(
        registrar,
        "NotHolder"
      );
      await expect(registrar.connect(alice).renewUsdc("ghost", 1)).to.be.revertedWithCustomError(
        registrar,
        "NotHolder"
      );
    });
  });

  // ─── setAddr (holder controls) ───────────────────────────────────────────
  describe("setAddr", () => {
    it("holder re-points the label; others cannot; expired paid reverts", async () => {
      const { registrar, registry, usdc, alice, bob } = await loadFixture(deployFixture);
      await usdc.mint(alice.address, 1_000_000_000n);
      await usdc.connect(alice).approve(await registrar.getAddress(), 1_000_000_000n);
      await registrar.connect(alice).claimPaidUsdc("alice", 1);

      await expect(registrar.connect(bob).setAddr("alice", bob.address)).to.be.revertedWithCustomError(
        registrar,
        "NotHolder"
      );
      await expect(registrar.connect(alice).setAddr("alice", bob.address))
        .to.emit(registrar, "AddrChanged")
        .withArgs(lh("alice"), alice.address, bob.address);
      // mock stores abi.encodePacked(addr) (20 bytes) under coinType 60.
      expect((await registry.addrOf(node("alice"), 60n)).toLowerCase()).to.equal(bob.address.toLowerCase());

      await time.increase(2 * YEAR);
      await expect(registrar.connect(alice).setAddr("alice", alice.address)).to.be.revertedWithCustomError(
        registrar,
        "LabelExpired"
      );
    });

    it("free label holder can always re-point (never expires)", async () => {
      const { registrar, signer, alice, bob } = await loadFixture(deployFixture);
      await registrar.connect(signer).claimFree("0xabcde", alice.address);
      await time.increase(10 * YEAR);
      await expect(registrar.connect(alice).setAddr("0xabcde", bob.address)).to.emit(registrar, "AddrChanged");
    });
  });

  // ─── Label validation ────────────────────────────────────────────────────
  describe("paid label validation", () => {
    async function funded() {
      const f = await loadFixture(deployFixture);
      await f.usdc.mint(f.alice.address, 1_000_000_000n);
      await f.usdc.connect(f.alice).approve(await f.registrar.getAddress(), 1_000_000_000n);
      return f;
    }
    const bad = ["ab", "a".repeat(33), "-alice", "alice-", "Alice", "ali_ce", "0x123", "0xabcde"];
    bad.forEach((label) => {
      it(`rejects "${label}"`, async () => {
        const { registrar, alice } = await funded();
        await expect(registrar.connect(alice).claimPaidUsdc(label, 1)).to.be.revertedWithCustomError(
          registrar,
          "BadLabel"
        );
      });
    });

    it("accepts a long 0x-hex (>7 chars) and hyphenated mids", async () => {
      const { registrar, alice } = await funded();
      await expect(registrar.connect(alice).claimPaidUsdc("0xabcdef0", 1)).to.not.be.reverted; // 9 chars
      await expect(registrar.connect(alice).claimPaidUsdc("a-b-c", 1)).to.not.be.reverted;
    });

    it("isAvailable reflects taken / expired state", async () => {
      const { registrar, alice } = await funded();
      expect(await registrar.isAvailable("alice")).to.equal(true);
      await registrar.connect(alice).claimPaidUsdc("alice", 1);
      expect(await registrar.isAvailable("alice")).to.equal(false);
      await time.increase(2 * YEAR);
      expect(await registrar.isAvailable("alice")).to.equal(true); // expired → reclaimable
    });
  });

  // ─── Admin / pause / withdraw ────────────────────────────────────────────
  describe("admin", () => {
    it("pause halts claims", async () => {
      const { registrar, signer, alice } = await loadFixture(deployFixture);
      await registrar.setPaused(true);
      await expect(registrar.connect(signer).claimFree("0xabcde", alice.address)).to.be.revertedWithCustomError(
        registrar,
        "Paused"
      );
    });

    it("owner-only setters are gated and emit", async () => {
      const { registrar, alice, bob } = await loadFixture(deployFixture);
      await expect(registrar.connect(alice).setSigner(bob.address)).to.be.revertedWithCustomError(
        registrar,
        "NotOwner"
      );
      await expect(registrar.setSigner(bob.address)).to.emit(registrar, "SignerUpdated").withArgs(bob.address);
      await expect(registrar.setTreasury(bob.address)).to.emit(registrar, "TreasuryUpdated").withArgs(bob.address);
      await registrar.transferOwnership(alice.address);
      expect(await registrar.owner()).to.equal(alice.address);
    });

    it("withdraw routes USDC and ETH to the treasury only", async () => {
      const { registrar, usdc, treasury, alice } = await loadFixture(deployFixture);
      // collect some USDC + ETH via claims
      await usdc.mint(alice.address, 1_000_000_000n);
      await usdc.connect(alice).approve(await registrar.getAddress(), 1_000_000_000n);
      await registrar.connect(alice).claimPaidUsdc("alice", 1);
      const ethQuote = await registrar.priceEth(1);
      await registrar.connect(alice).claimPaidEth("aliceeth", 1, { value: ethQuote });

      await expect(registrar.withdraw(await usdc.getAddress(), PRICE[1])).to.changeTokenBalance(
        usdc,
        treasury,
        PRICE[1]
      );
      await expect(registrar.withdraw(ZERO, ethQuote)).to.changeEtherBalance(treasury, ethQuote);
    });

    it("withdraw is owner-only", async () => {
      const { registrar, usdc, alice } = await loadFixture(deployFixture);
      await expect(registrar.connect(alice).withdraw(await usdc.getAddress(), 1)).to.be.revertedWithCustomError(
        registrar,
        "NotOwner"
      );
    });
  });
});
