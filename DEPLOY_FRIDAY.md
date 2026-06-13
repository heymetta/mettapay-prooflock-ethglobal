# MettaPay — Friday 2026-06-12 Deployment Runbook

Nothing is live yet. This deploys **all four** MettaPay contracts to
**Base mainnet** (chainId 8453). An optional Base Sepolia dry-run is
described at the bottom; run it the day before if you want a clean rehearsal.

| # | Contract                       | Toolchain | Notes                                     |
| - | ------------------------------ | --------- | ----------------------------------------- |
| 1 | `ProofLockVerifier`            | Hardhat   | Chainlink Functions consumer              |
| 2 | `EscrowFactory` (+ `ProofLockEscrow` template) | Hardhat | Uses #1 as `DEFAULT_VERIFIER`     |
| 3 | Durin L2 Registry (`mettapay.eth`) | Durin UI | Web flow, not in this repo            |
| 4 | `MettaPaySubnameRegistrar`     | Foundry   | Uses #3's address                         |

---

## 0. Pre-flight (do this Thursday night)

Deployer wallet needs **~0.05 Base ETH** for all 4 txs + buffer.

Gather these values into a sticky note — you'll paste them several times:

```sh
# Wallets / keys
export PRIVATE_KEY=0x...                  # deployer EOA (Base ETH for gas)
export BASESCAN_API_KEY=...

# RPCs
export BASE_MAINNET_RPC_URL=https://mainnet.base.org
export BASE_SEPOLIA_RPC_URL=https://sepolia.base.org   # only for dry-run

# Multisigs / EOAs (CONFIRM with team before running)
export DEFAULT_ARBITRATOR=0x...           # arbitration multisig
export FEE_COLLECTOR=0x...                # treasury multisig (same as TREASURY)
export TREASURY=$FEE_COLLECTOR
export COMPLIANCE_OFFICER=0x...           # release/forfeit seller consolation
export BACKEND_SIGNER=0x...               # EOA the MettaPay backend already holds

# Chainlink Functions (Base mainnet)
export ROUTER=0xf9B8fc078197181C841c296C876945aaa425B278
export DON_ID=0x66756e2d626173652d6d61696e6e65742d310000000000000000000000000000
export SUB_ID=<your funded mainnet Functions subscription id>
```

Install once:

```sh
cd contracts
bun install
npx hardhat compile
forge install foundry-rs/forge-std --no-commit
```

---

## Step 1 — Deploy `ProofLockVerifier` (Hardhat)

```sh
npx hardhat run scripts/deploy-verifier.ts --network base
```

Capture the printed address:

```sh
export VERIFIER_ADDR=0x...   # ProofLockVerifier
```

Then add `$VERIFIER_ADDR` as a **Consumer** on your Functions subscription at
https://functions.chain.link → Base mainnet → subscription `$SUB_ID`.

---

## Step 2 — Deploy `EscrowFactory` (Hardhat)

Default fees (locked in unless team says otherwise):

| Trigger                          | bps | %     |
| -------------------------------- | --- | ----- |
| Deposit (funding)                | 290 | 2.90% |
| Settle (release to seller)       | 190 | 1.90% |
| Deadline refund (seller no-show) | 300 | 3.00% |
| Disputed buyer-award refund      | 900 | 9.00% |
| Seller consolation slice         | 300 | 3.00% |

```sh
export NETWORK_MODE=0                      # 0 = Base mainnet
export DEFAULT_VERIFIER=$VERIFIER_ADDR

npx hardhat run scripts/deploy.ts --network base
```

Capture:

```sh
export FACTORY_ADDR=0x...    # EscrowFactory
```

---

## Step 3 — Deploy Durin L2 Registry for `mettapay.eth`

In the Durin web app (https://durin.dev):

1. Connect the wallet that owns `mettapay.eth` on L1 mainnet.
2. Choose target chain **Base mainnet**.
3. Deploy the L2 Registry. Save the address:

```sh
export DURIN_L2_REGISTRY=0x...
```

---

## Step 4 — Wire `mettapay.eth` on L1 → Durin's L1 Resolver

Etherscan tx on **Ethereum mainnet** (ENS):

- ENS Registry → `setResolver(node=mettapay.eth, resolver=<Durin L1 Resolver>)`

Durin shows the exact L1 Resolver address and a one-click flow in their UI —
follow it. After confirmation, ENS lookups for `*.mettapay.eth` will read
from `$DURIN_L2_REGISTRY` on Base.

---

## Step 5 — Deploy `MettaPaySubnameRegistrar` (Foundry)

```sh
cd contracts
forge script script/DeployMettaPaySubnameRegistrar.s.sol:Deploy \
  --sig "runMainnet()" \
  --rpc-url $BASE_MAINNET_RPC_URL \
  --broadcast \
  --verify
```

Capture:

```sh
export REGISTRAR_ADDR=0x...   # MettaPaySubnameRegistrar
```

Smoke-test the live price oracle:

```sh
REGISTRAR=$REGISTRAR_ADDR \
forge script script/DeployMettaPaySubnameRegistrar.s.sol:Quote \
  --sig "quote(uint8)" 1 \
  --rpc-url $BASE_MAINNET_RPC_URL
```

You should see `USDC (6 dec): 7000000` and a non-zero `ETH (wei)`.

---

## Step 6 — Authorize the registrar on the Durin L2 Registry

The registrar must be a **controller** on `$DURIN_L2_REGISTRY` or
`claimFree` / `claimPaidUsdc` / `claimPaidEth` will revert.

In the Durin UI (or via the registry's `addController(address)` if exposed):

- Registry: `$DURIN_L2_REGISTRY`
- Controller to add: `$REGISTRAR_ADDR`

---

## Step 7 — Paste addresses into the app `.env` and redeploy

```
VITE_PROOFLOCK_VERIFIER_ADDRESS=<VERIFIER_ADDR>
VITE_PROOFLOCK_FACTORY_ADDRESS=<FACTORY_ADDR>
VITE_PROOFLOCK_FEE_COLLECTOR=<FEE_COLLECTOR>
VITE_PROOFLOCK_COMPLIANCE_OFFICER=<COMPLIANCE_OFFICER>
VITE_MP_SUBNAME_REGISTRAR=<REGISTRAR_ADDR>
VITE_DURIN_L2_REGISTRY=<DURIN_L2_REGISTRY>
```

Redeploy the app so SSR picks up the new env.

---

## Step 8 — Smoke tests on production

1. **Free subname** — sign in, go to `/settings/username`, claim a 5-hex
   handle. Confirm row appears in `public.ens_subnames`.
2. **Paid subname (USDC)** — claim a 3+ char name with 1-year USDC. Verify
   tx on Basescan and confirm expiry in the UI.
3. **Paid subname (ETH)** — same, with ETH path. Confirm overpayment refund.
4. **ETH escrow** — `/prooflock/new`, fund a tiny ETH escrow against a
   second wallet. Verify `BaseEthEscrowCreated` event on Basescan.
5. **USDC escrow** — same with $1 USDC. Verify `markFunded` was called.

If any step fails, **do not proceed**. Pause and triage before authorizing
the registrar or publishing the env.

---

## Optional — Base Sepolia dry-run (Thursday)

Same flow, swap the network flags:

| Step | Command change                                                 |
| ---- | -------------------------------------------------------------- |
| 1    | `--network baseSepolia` + Sepolia Functions Router/DON/Sub     |
| 2    | `--network baseSepolia` + `NETWORK_MODE=1`                     |
| 3    | Use Durin UI on Base Sepolia                                   |
| 5    | `--sig "runSepolia()"` + `--rpc-url $BASE_SEPOLIA_RPC_URL`     |

Sepolia faucet: https://www.alchemy.com/faucets/base-sepolia
