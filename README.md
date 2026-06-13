# MettaPay Subname Registrar — Foundry workspace

This directory holds the Solidity contract and deploy script for
`MettaPaySubnameRegistrar`. It plugs into a Durin L2 Registry to issue and
renew `*.mettapay.eth` subnames, and is portable across Base mainnet and
Base Sepolia via constructor immutables.

## Layout

```
contracts/
├── foundry.toml
├── src/
│   └── MettaPaySubnameRegistrar.sol
└── script/
    └── DeployMettaPaySubnameRegistrar.s.sol
```

## Install

```sh
cd contracts
forge install foundry-rs/forge-std --no-commit
```

## Networks

The contract reads USDC and the Chainlink ETH/USD feed from constructor
immutables, so the same source code deploys to either Base network.

| Network         | chainId | USDC                                       | Chainlink ETH/USD                          |
| --------------- | ------- | ------------------------------------------ | ------------------------------------------ |
| Base mainnet    | 8453    | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | `0x71041dDDad3595F9CEd3DcCFBe3D1F4b0a16Bb70` |
| Base Sepolia    | 84532   | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | `0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1` |

The two `--sig` entrypoints in the deploy script pin those addresses for you.

## Deploy

### Common env

```sh
export PRIVATE_KEY=0x...           # deployer (Base ETH for gas)
export DURIN_L2_REGISTRY=0x...     # Durin L2 Registry on the target chain
export TREASURY=0x...              # multisig that receives fees
export BACKEND_SIGNER=0x...        # backend EOA that mints free names
export BASESCAN_API_KEY=...
```

### Base Sepolia (recommended for first end-to-end test)

```sh
export BASE_SEPOLIA_RPC_URL=https://sepolia.base.org

forge script script/DeployMettaPaySubnameRegistrar.s.sol:Deploy \
  --sig "runSepolia()" \
  --rpc-url $BASE_SEPOLIA_RPC_URL \
  --broadcast \
  --verify
```

### Base mainnet (production)

```sh
export BASE_RPC_URL=https://mainnet.base.org

forge script script/DeployMettaPaySubnameRegistrar.s.sol:Deploy \
  --sig "runMainnet()" \
  --rpc-url $BASE_RPC_URL \
  --broadcast \
  --verify
```

### Custom network / mock feeds

If you need a non-canonical USDC or feed (mock, fork, dev chain), use the
default `run()` entrypoint and pass them via env:

```sh
export USDC=0x...
export ETH_USD_FEED=0x...

forge script script/DeployMettaPaySubnameRegistrar.s.sol:Deploy \
  --rpc-url $YOUR_RPC \
  --broadcast
```

## After deploy

1. Authorize the new contract as a controller on the Durin L2 Registry so
   it can call `register(labelhash, owner, resolved)` and `setAddr(...)`.
2. Set `VITE_MP_SUBNAME_REGISTRAR=<deployed address>` in the app's `.env`
   so the `/settings/username` UI can call `claimPaidUsdc` / `claimPaidEth`.
3. Smoke-test the live quote:

   ```sh
   REGISTRAR=0x... \
   forge script script/DeployMettaPaySubnameRegistrar.s.sol:Quote \
     --sig "quote(uint8)" 1 \
     --rpc-url $BASE_RPC_URL
   ```

## Pricing (set in the contract, not the deploy script)

| Years | USDC (6-dec) | USD  |
| ----- | ------------ | ---- |
| 1     | 7_000_000    | $7   |
| 3     | 17_000_000   | $17  |
| 5     | 30_000_000   | $30  |

ETH price is computed live from the Chainlink ETH/USD feed wired in at
deploy time. Stale answers (>1h) revert `claimPaidEth` / `renewEth`.

## Tier rules enforced on-chain

- **Free (`claimFree`)**: signer-only; label MUST be `0x` + 5 lowercase hex
  chars (7 chars total); no expiry.
- **Paid (`claimPaidUsdc` / `claimPaidEth`)**: anyone; label 3–32 chars,
  `[a-z0-9-]`, no leading/trailing hyphen, cannot be a short `0x[hex]`
  string (reserved for free tier); 1/3/5 year terms only.
- **Renew**: paid labels only; extends from current expiry (or `now` if
  already expired) — free labels never expire and never need renewal.
- **setAddr**: holder-only; reverts on expired paid labels.

## Safety

- ReentrancyGuard on every state-changing external call (`nonReentrant`).
- `setPaused(true)` halts all claims/renewals (owner-only).
- ETH overpayment refunded to caller in the same transaction.
- `withdraw(token, amount)` routes to `treasury` only — set the treasury to
  a multisig before going live.

## App integration

The TypeScript side lives in `../src/lib/ens.functions.ts` and
`../src/routes/_authenticated/settings_.username.tsx`. The server function
`claimCustomSubname` verifies the on-chain transaction receipt
(`from == buyer wallet`, `status == 0x1`) before mirroring the row into
`public.ens_subnames`. See `../docs/ens-durin-setup.md` for the L1
(`mettapay.eth`) wiring.
