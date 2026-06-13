// Constructor args for EscrowFactory 0xb2ea821A185AF28f85aFCD0B71A8053D77208F8B
// (single DeployArgs struct, in declared field order).
module.exports = [
  [
    "0x7CC8F5E12d0b371971E9983EC45175303eF2394B", // defaultArbitrator
    1, // networkMode (BaseSepolia)
    "0x0000000000000000000000000000000000000000", // defaultVerifier
    "0xFA4269275689EbFFE9299c0EE106C37a709B164B", // feeCollector
    "0x33c4223319015BFDb38CA144d8cE201ecd482871", // complianceOfficer
    290, // depositFeeBps
    190, // settleFeeBps
    300, // deadlineRefundFeeBps
    900, // disputeRefundFeeBps
    300, // sellerConsolationBps
    "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // usdc (real Circle USDC)
  ],
];
