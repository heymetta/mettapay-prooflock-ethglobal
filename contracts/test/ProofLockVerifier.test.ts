import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

/**
 * ProofLockVerifier — the Chainlink Functions consumer. Driven through a
 * MockFunctionsRouter so the request → fulfil round-trip can be tested without
 * a live DON. (On a real testnet the DON calls handleOracleFulfillment; here the
 * mock router does.)
 */
describe("ProofLockVerifier", () => {
  const DON_ID = ethers.encodeBytes32String("fun-base-sepolia-1");
  const SUB_ID = 42n;
  const SOURCE = "return Functions.encodeString('ok')";

  function encodeResult(verified: boolean, message: string) {
    return ethers.AbiCoder.defaultAbiCoder().encode(["bool", "string"], [verified, message]);
  }

  async function deployFixture() {
    const [owner, requester, other] = await ethers.getSigners();
    const Router = await ethers.getContractFactory("MockFunctionsRouter");
    const router = await Router.deploy();
    await router.waitForDeployment();

    const Verifier = await ethers.getContractFactory("ProofLockVerifier");
    const verifier = await Verifier.deploy(await router.getAddress(), SUB_ID, DON_ID);
    await verifier.waitForDeployment();

    const escrow = ethers.Wallet.createRandom().address;
    return { owner, requester, other, router, verifier, escrow };
  }

  it("constructor wires subscription, DON id, and default gas", async () => {
    const { verifier } = await loadFixture(deployFixture);
    expect(await verifier.subscriptionId()).to.equal(SUB_ID);
    expect(await verifier.donId()).to.equal(DON_ID);
    expect(await verifier.callbackGasLimit()).to.equal(300_000);
  });

  it("setConfig is owner-only and emits", async () => {
    const { verifier, other } = await loadFixture(deployFixture);
    await expect(verifier.connect(other).setConfig(1, DON_ID, 1)).to.be.revertedWith("Only callable by owner");
    await expect(verifier.setConfig(7, DON_ID, 500_000))
      .to.emit(verifier, "ConfigUpdated")
      .withArgs(7, DON_ID, 500_000);
    expect(await verifier.subscriptionId()).to.equal(7);
    expect(await verifier.callbackGasLimit()).to.equal(500_000);
  });

  it("requestVerification stores a pending result, maps the id, and emits", async () => {
    const { verifier, requester, escrow } = await loadFixture(deployFixture);
    await expect(verifier.connect(requester).requestVerification(escrow, SOURCE, [], "github"))
      .to.emit(verifier, "VerificationRequested");

    const rec = await verifier.results(escrow);
    expect(rec.exists).to.equal(true);
    expect(rec.verified).to.equal(false);
    expect(rec.message).to.equal("pending");
    expect(await verifier.requestEscrow(rec.lastRequestId)).to.equal(escrow);
  });

  it("rejects an empty source", async () => {
    const { verifier, escrow } = await loadFixture(deployFixture);
    await expect(verifier.requestVerification(escrow, "", [], "x")).to.be.revertedWithCustomError(
      verifier,
      "EmptySource"
    );
  });

  it("DON success fulfilment marks the escrow verified", async () => {
    const { verifier, router, escrow, requester } = await loadFixture(deployFixture);
    await verifier.connect(requester).requestVerification(escrow, SOURCE, ["https://x"], "webhook");
    const reqId = (await verifier.results(escrow)).lastRequestId;

    await expect(router.fulfill(await verifier.getAddress(), reqId, encodeResult(true, "PR #1 merged"), "0x"))
      .to.emit(verifier, "VerificationFulfilled")
      .withArgs(escrow, reqId, true, "PR #1 merged");

    const rec = await verifier.results(escrow);
    expect(rec.verified).to.equal(true);
    expect(rec.message).to.equal("PR #1 merged");
  });

  it("DON error fulfilment records the error and keeps verified=false", async () => {
    const { verifier, router, escrow } = await loadFixture(deployFixture);
    await verifier.requestVerification(escrow, SOURCE, [], "shopify");
    const reqId = (await verifier.results(escrow)).lastRequestId;
    const err = ethers.toUtf8Bytes("ERR:no-token");

    await expect(router.fulfill(await verifier.getAddress(), reqId, "0x", err)).to.emit(
      verifier,
      "VerificationFailed"
    );
    const rec = await verifier.results(escrow);
    expect(rec.verified).to.equal(false);
    expect(rec.message).to.equal("ERR:no-token");
  });

  it("only the router can fulfil", async () => {
    const { verifier, escrow, other } = await loadFixture(deployFixture);
    await verifier.requestVerification(escrow, SOURCE, [], "x");
    const reqId = (await verifier.results(escrow)).lastRequestId;
    await expect(
      verifier.connect(other).handleOracleFulfillment(reqId, encodeResult(true, "y"), "0x")
    ).to.be.revertedWithCustomError(verifier, "OnlyRouterCanFulfill");
  });

  it("an unknown requestId reverts on fulfilment", async () => {
    const { verifier, router } = await loadFixture(deployFixture);
    const bogus = ethers.keccak256(ethers.toUtf8Bytes("bogus"));
    await expect(
      router.fulfill(await verifier.getAddress(), bogus, encodeResult(true, "y"), "0x")
    ).to.be.revertedWithCustomError(verifier, "UnknownRequest");
  });

  it("getResult on an unseen escrow returns an empty record", async () => {
    const { verifier } = await loadFixture(deployFixture);
    const rec = await verifier.getResult(ethers.Wallet.createRandom().address);
    expect(rec.exists).to.equal(false);
  });
});
