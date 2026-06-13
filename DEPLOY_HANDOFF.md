# ProofLock — Deploy Handoff

Quickstart for deploying the MettaPays ProofLock contracts to **Base Sepolia**.
Full reference lives in `README.md`.

## Prerequisites

- Node.js 20+ and either `bun` or `npm`
- A funded Base Sepolia deployer wallet (get test ETH from
  https://www.alchemy.com/faucets/base-sepolia)
- (Optional, for the Chainlink Functions verifier) a Functions subscription on
  https://functions.chain.link/base-sepolia funded with test LINK

## 1. Install + configure

```bash
cd prooflock-contracts
cp .env.example .env
# Edit .env and fill PRIVATE_KEY. FEE_COLLECTOR and COMPLIANCE_OFFICER
# are pre-filled with the prod wallets — confirm with the team before
# changing them.

bun install        # or: npm install
npx hardhat compile
```

## 2. Deploy the EscrowFactory

```bash
npx hardhat run scripts/deploy.ts --network baseSepolia
```

The script prints the new factory address and the lines to paste into the
app's `.env`:

```
VITE_PROOFLOCK_FACTORY_ADDRESS=0x...
VITE_PROOFLOCK_FEE_COLLECTOR=0xFA4269275689EbFFE9299c0EE106C37a709B164B
VITE_PROOFLOCK_COMPLIANCE_OFFICER=0x33c4223319015BFDb38CA144d8cE201ecd482871
```

### Default fee schedule (already in `.env.example`)

| Trigger | Default | Notes |
|---|---|---|
| Deposit (funding) | 2.90% | platform |
| Release to seller | 1.90% | platform |
| Deadline refund (seller no-show) | 3.00% | platform only |
| Disputed buyer-award refund | 9.00% | 6% platform + 3% seller consolation held in-contract |
| Seller cancels | 0% | goodwill |

## 3. (Optional) Deploy the Chainlink Functions verifier

Needed only if the app should run on-chain proof verification through the
Chainlink DON. Skip on a first pass — the app falls back to a server-side
fetch when `VITE_PROOFLOCK_VERIFIER_ADDRESS` is unset.

1. Create a Functions subscription at
   https://functions.chain.link/base-sepolia and fund it with LINK.
2. Put the subscription id in `.env` as `SUB_ID=...`.
3. Run:

   ```bash
   npx hardhat run scripts/deploy-verifier.ts --network baseSepolia
   ```

4. Add the printed verifier address as a **Consumer** on the subscription.
5. Recommended: redeploy the factory with `DEFAULT_VERIFIER=<verifier>` so
   every new escrow stamps the verifier in its constructor (enables the
   on-chain "Chainlink-verified" badge).

## 4. What to send back

Please reply with:

- EscrowFactory address + deploy tx hash
- (If deployed) ProofLockVerifier address + deploy tx hash + Functions
  subscription id
- The deployer wallet address used (for the audit trail)

## Verify on Basescan (optional but recommended)

With `BASESCAN_API_KEY` set in `.env`:

```bash
npx hardhat verify --network baseSepolia <factory-address> \
  "(<defaultArbitrator>,1,<defaultVerifier>,<feeCollector>,<complianceOfficer>,290,190,300,900,300,<usdc-or-0x0>)"
```

(The constructor takes a single `DeployArgs` tuple — see
`contracts/EscrowFactory.sol`. The trailing field is the optional `usdc`
override: pass `0x0000000000000000000000000000000000000000` to use the canonical
Circle USDC for the network, or a mock-USDC address for testnet smoke tests.)
