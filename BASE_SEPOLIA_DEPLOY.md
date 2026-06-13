# MettaPay — Base Sepolia deploy & test guide

## Live deployment (Base Sepolia, chainId 84532 — deployed 2026-06-12)

Deployer: `0x666aD10e4e95550A00DD2E298D3fb056b34cb9db`

All four are **verified on Basescan** (via the Etherscan V2 API — click `#code`):

| Contract | Address | Notes |
| -------- | ------- | ----- |
| MockERC20 (USDC, 6 dec) | [`0x7D6A…5137`](https://sepolia.basescan.org/address/0x7D6A9C0F49936F58e62BF1B92ca2CA079d845137#code) | mintable test USDC; 1,000,000 minted to deployer |
| EscrowFactory | [`0xFbf1…432C`](https://sepolia.basescan.org/address/0xFbf178c4c491Fdf8108eE6E385217363f7A6432C#code) | wired to the mock USDC above |
| MockDurinRegistry | [`0x9570…A85d`](https://sepolia.basescan.org/address/0x9570142ccA5DFFea910CD874242151e5Eb04A85d#code) | **test stand-in**, not real Durin/ENS |
| MettaPaySubnameRegistrar | [`0x86Ca…84A0`](https://sepolia.basescan.org/address/0x86Ca3e140676ad9A977fC871559F6a23050E84A0#code) | registry+USDC = mocks above; treasury/signer = deployer |

Smoke-tested live: `claimFree` + `claimPaidUsdc` both succeed; `priceUsdc(1)=7000000`,
`priceEth(1)≈0.0042 ETH` (live Chainlink ETH/USD).

Verification used a single **Etherscan V2** key (`ETHERSCAN_API_KEY`, one key for all
chains). The factory's struct constructor arg is supplied via
`scripts/args/escrow-factory.js`:

```sh
# one key verifies on Base, Base Sepolia, Arbitrum, OP, … (api.etherscan.io/v2)
npx hardhat verify --network baseSepolia --constructor-args scripts/args/escrow-factory.js <factory>
npx hardhat verify --network baseSepolia <registrar> <registry> <usdc> <ethUsdFeed> <treasury> <signer>
```

(If `hardhat verify` throws `Connect Timeout Error`, prefix with
`NODE_OPTIONS=--dns-result-order=ipv4first` and retry — an IPv6 quirk, not a key issue.)

> ⚠️ The registrar points at a **MockDurinRegistry**, because the real Durin
> `L2Registry` ABI (`createSubnode`/`addRegistrar`/`owner`) does **not** match the
> registrar's `IDurinL2Registry` (`register`/`setAddr`/`ownerOf`). Names will NOT
> resolve via real ENS/CCIP until the registrar is adapted to Durin's interface
> and re-deployed against a real Durin registry for `mettapay.eth`. The mock is
> fine for exercising the claim/pay/renew flows and the app's quote/claim UI.

App `.env` for this deployment:

```
VITE_PROOFLOCK_FACTORY_ADDRESS=0xFbf178c4c491Fdf8108eE6E385217363f7A6432C
VITE_PROOFLOCK_FEE_COLLECTOR=0xFA4269275689EbFFE9299c0EE106C37a709B164B
VITE_PROOFLOCK_COMPLIANCE_OFFICER=0x33c4223319015BFDb38CA144d8cE201ecd482871
VITE_MP_SUBNAME_REGISTRAR=0x86Ca3e140676ad9A977fC871559F6a23050E84A0
VITE_DURIN_L2_REGISTRY=0x9570142ccA5DFFea910CD874242151e5Eb04A85d
# VITE_PROOFLOCK_VERIFIER_ADDRESS — not deployed (Functions sunset on testnets)
```

---


End-to-end guide to test and deploy **all four** MettaPay contracts to
**Base Sepolia (chainId 84532)** — the one testnet where every piece works
(escrow + Chainlink Functions verifier + Durin ENS L2 + the subname registrar).

| # | Contract | Toolchain | Notes |
| - | -------- | --------- | ----- |
| 1 | `ProofLockVerifier` | Hardhat | Chainlink Functions consumer |
| 2 | `EscrowFactory` (+ `ProofLockEscrow` template) | Hardhat | uses #1 as `DEFAULT_VERIFIER` |
| 3 | Durin L2 Registry (`mettapay.eth`) | durin.dev web flow | not in this repo |
| 4 | `MettaPaySubnameRegistrar` | Foundry | uses #3's address |

> **Chainlink Functions caveat (read first):** per Chainlink's docs, Functions
> **sunset on testnets on 2026-06-02**. `ProofLockVerifier` still deploys, but
> its requests won't be fulfilled by the DON on Base Sepolia anymore. That's
> fine for the rest of the system — the escrow treats the verifier as optional
> (`verifier == address(0)` → the "verified" badge is simply never shown).
> Deploy it only if you have a still-active subscription; otherwise skip #1 and
> deploy the factory with `DEFAULT_VERIFIER=0x0`.

---

## 0. Prerequisites

- Node 20+ (`npm`), and **Foundry** (`forge`) for contract #4 — install via
  https://getfoundry.sh (`foundryup`).
- A Base Sepolia deployer wallet with test ETH:
  https://www.alchemy.com/faucets/base-sepolia
- `cp contracts/.env.example contracts/.env` and fill `PRIVATE_KEY` +
  `BASESCAN_API_KEY`. The config ignores a placeholder key, so compile/test work
  before you set a real one.

```sh
cd contracts
npm install --ignore-scripts        # --ignore-scripts skips a noisy @chainlink postinstall
npx hardhat compile
forge install foundry-rs/forge-std --no-commit   # for contract #4
```

## 1. Run the test suite (do this before deploying)

```sh
npm test            # hardhat test — 70 passing
```

Covers every use case across the four contracts: ETH + USDC escrow lifecycles
(fund → proof → approve/release, dispute → arbitration split, deadline refund,
seller cancel, Chainlink Automation auto-refund, compliance consolation
release/forfeit, fee math, access control), the factory (creation, indexing,
USDC override, validations, owner admin), the verifier (request → DON
fulfil/error via a mock router, access control), and the registrar (free/paid
USDC+ETH tiers, Chainlink ETH/USD pricing + staleness, renewals, `setAddr`,
label validation, pause/withdraw).

---

## 2. (Optional) Deploy a mintable mock USDC

Base Sepolia's canonical Circle USDC (`0x036CbD…3dCF7e`) is faucet-gated. A mock
lets you mint freely for the USDC escrow + paid-subname paths:

```sh
npm run deploy:mockUsdc:baseSepolia
# → prints USDC=0x... ; export it for the factory step (and the registrar, if used)
```

Leave `USDC` unset to use real Circle USDC instead.

## 3. (Optional) Deploy `ProofLockVerifier`

Skip unless you have an active Base Sepolia Functions subscription (see caveat
above). Fund a subscription at https://functions.chain.link/base-sepolia, put
its id in `.env` as `SUB_ID`, then:

```sh
npm run deploy:verifier:baseSepolia
export DEFAULT_VERIFIER=0x...   # printed verifier address
```

Add the printed address as a **Consumer** on the subscription.

## 4. Deploy `EscrowFactory`

```sh
# .env already defaults NETWORK_MODE=1 (Base Sepolia) and the fee schedule.
# DEFAULT_VERIFIER and USDC are optional overrides.
npm run deploy:baseSepolia
export FACTORY_ADDR=0x...       # printed
```

Verify on Basescan (constructor is one `DeployArgs` tuple — note the trailing
`usdc` override field):

```sh
npx hardhat verify --network baseSepolia $FACTORY_ADDR \
  "(<arbitrator>,1,<verifier-or-0x0>,<feeCollector>,<complianceOfficer>,290,190,300,900,300,<usdc-or-0x0>)"
```

## 5. Deploy the Durin L2 Registry

In the Durin web app (https://durin.dev), connect the `mettapay.eth` owner
wallet, choose **Base Sepolia**, deploy the L2 Registry, and save the address:

```sh
export DURIN_L2_REGISTRY=0x...
```

## 6. Deploy `MettaPaySubnameRegistrar` (Foundry)

```sh
export TREASURY=0x...           # receives withdraw()
export BACKEND_SIGNER=0x...     # mints free 0x{first5} handles
# USDC + ETH/USD feed are pinned for Base Sepolia inside runSepolia().

forge script script/DeployMettaPaySubnameRegistrar.s.sol:Deploy \
  --sig "runSepolia()" \
  --rpc-url $BASE_SEPOLIA_RPC_URL \
  --broadcast --verify
export REGISTRAR_ADDR=0x...
```

Smoke-test the live oracle (expect `USDC (6 dec): 7000000` + a non-zero ETH wei):

```sh
REGISTRAR=$REGISTRAR_ADDR forge script \
  script/DeployMettaPaySubnameRegistrar.s.sol:Quote --sig "quote(uint8)" 1 \
  --rpc-url $BASE_SEPOLIA_RPC_URL
```

## 7. Authorize the registrar as a controller

On the Durin L2 Registry, add `$REGISTRAR_ADDR` as a controller, or
`claimFree` / `claimPaidUsdc` / `claimPaidEth` will revert.

## 8. Paste addresses into the app `.env`

```
VITE_PROOFLOCK_VERIFIER_ADDRESS=<verifier or empty>
VITE_PROOFLOCK_FACTORY_ADDRESS=<FACTORY_ADDR>
VITE_PROOFLOCK_FEE_COLLECTOR=<feeCollector>
VITE_PROOFLOCK_COMPLIANCE_OFFICER=<complianceOfficer>
VITE_DURIN_L2_REGISTRY=<DURIN_L2_REGISTRY>
VITE_MP_SUBNAME_REGISTRAR=<REGISTRAR_ADDR>
```

---

## Base Sepolia reference addresses

| Thing | Address |
| ----- | ------- |
| USDC (Circle) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| Chainlink ETH/USD feed | `0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1` |
| Functions Router | `0xf9B8fc078197181C841c296C876945aaa425B278` |
| Functions DON ID | `fun-base-sepolia-1` (`0x66756e2d626173652d7365706f6c69612d31` + zero-pad) |
