// Constructor args for the deployed EscrowFactory (single DeployArgs tuple).
// Used by: npx hardhat verify --constructor-args scripts/args/escrow-factory.js <addr>
module.exports = [
  {
    defaultArbitrator: "0x666aD10e4e95550A00DD2E298D3fb056b34cb9db",
    networkMode: 1,
    defaultVerifier: "0x0000000000000000000000000000000000000000",
    feeCollector: "0xFA4269275689EbFFE9299c0EE106C37a709B164B",
    complianceOfficer: "0x33c4223319015BFDb38CA144d8cE201ecd482871",
    depositFeeBps: 290,
    settleFeeBps: 190,
    deadlineRefundFeeBps: 300,
    disputeRefundFeeBps: 900,
    sellerConsolationBps: 300,
    usdc: "0x7D6A9C0F49936F58e62BF1B92ca2CA079d845137",
  },
];
