# MettaPay — Client action steps (Base Sepolia)

All contracts are **freshly deployed (real Circle USDC + real Durin registry),
verified on Basescan, and already owned by your wallet.** Signer, treasury, and
owner are baked in — so only a few on-chain actions remain. Do them **in order**.

## Your wallets
| Role | Address |
| --- | --- |
| Durin registry **admin** | `0x89d0d8cEE487346c2f00bAEA60d03d71E6aeAbA3` |
| Contracts **owner** | `0x7CC8F5E12d0b371971E9983EC45175303eF2394B` |
| Backend **signer** | `0x33c4223319015BFDb38CA144d8cE201ecd482871` |

## Contract addresses (current / canonical)
| Contract | Address |
| --- | --- |
| MettaPaySubnameRegistrar | `0x6cAd60E85D233F062fdd47c16d7A3f720cB0e41c` |
| EscrowFactory | `0xb2ea821A185AF28f85aFCD0B71A8053D77208F8B` |
| ProofLockVerifier (inert) | `0x364e91923ACe4C6c962Fe2D135A0bFc7cd78F321` |
| Durin L2 Registry | `0xd9dc8056f4c517FcBD93a7f90b490721e2909D6e` |
| USDC (Circle, real) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |

> ⚠️ The old factory `0xFbf178…432C` (mock USDC) and old registrar `0x563D6F…c2C3`
> are **deprecated** — use only the addresses above.

## Already done for you (no action)
- ✅ Factory + registrar wired to **real Circle USDC** (your 20 USDC is now usable).
- ✅ Registrar wired to your **real Durin registry**.
- ✅ Registrar **backend signer** = `0x33c4…2871` (baked in).
- ✅ Registrar **treasury** = `0x7CC8…2394B` (baked in).
- ✅ Ownership of factory + registrar = `0x7CC8…2394B`.

---

## STEP 1 — Confirm the registry  *(reply, no transaction)*
You deployed two `mettapay.eth` registries; we used `0xd9dc8056…` (2 subnames).
The other is `0x7df495ba…` (1 subname). **Confirm `0xd9dc8056…` is correct**, or we
re-deploy the registrar against the other (5 min).

## STEP 2 — Authorize the registrar  ⭐ **(unblocks all minting)**
Until this is done, `claimFree` / `claimPaid` **revert**.

- **Wallet:** `0x89d0d8c…aeAbA3` (registry admin)
- **Where:** Durin dashboard (Registrars/Controllers → Add) or Basescan
- **Call on registry `0xd9dc8056…`:**
  ```
  addRegistrar(0x6cAd60E85D233F062fdd47c16d7A3f720cB0e41c)
  ```
- **Confirm:** `registrars(0x6cAd60E8…)` returns `true`.

## STEP 3 — Accept verifier ownership  *(2-step handoff)*
- **Wallet:** `0x7CC8…2394B`
- **Where:** Basescan → `0x364e9192…F321` → Write → connect wallet
- **Call:** `acceptOwnership()`
- ℹ️ The verifier is **inert on testnet** (Chainlink Functions retired 2026-06-02);
  deployed for completeness. See the strategy note below.

## STEP 4 — Test a live mint  *(proof it works end-to-end)*
After Step 2:
- **Wallet:** `0x33c4…2871` (backend signer)
- **Call on registrar `0x6cAd60E8…`:**
  ```
  claimFree("0xabcde", <userWallet>)
  ```
  (`0x` + 5 hex = free auto-name. Paid custom names: `claimPaidUsdc` / `claimPaidEth`,
  priced $7/$17/$30 in real USDC.)
- **Confirm:** `FreeClaimed` event; `recordOf("0xabcde").holder == userWallet`.

## STEP 5 — L1 wiring so names resolve in wallets  *(one-time ENS)*
- **Wallet:** owner of `mettapay.eth` on L1
- **Where:** Durin dashboard “Connect to ENS” flow
- **Actions:** set `mettapay.eth` resolver → Durin L1 Resolver
  `0x8A968aB9eb8C084FBC44c531058Fc9ef945c3D61` (Sepolia), then
  `setL2Registry(namehash("mettapay.eth"), 84532, 0xd9dc8056…)`.
- **Confirm:** a minted `x.mettapay.eth` resolves to the holder's address.

## STEP 6 — Optional
- **Different treasury?** Treasury is currently `0x7CC8…` (owner). To change:
  `setTreasury(<addr>)` on the registrar from `0x7CC8…`.
- **Default text records** (avatar/url) at claim time? Tell us — small change + 1 redeploy.
  Address resolution already works without it.

---

## Checklist
- [ ] Step 1 — confirm registry `0xd9dc8056…`
- [ ] Step 2 — `addRegistrar(0x6cAd60E8…)` from `0x89d0d8c…`  ⭐
- [ ] Step 3 — `acceptOwnership()` on verifier from `0x7CC8…`
- [ ] Step 4 — test `claimFree` from `0x33c4…`
- [ ] Step 5 — L1 ENS wiring for `mettapay.eth`
- [ ] Step 6 — optional treasury / text records

> Strategy note: `ProofLockVerifier` runs on Chainlink Functions, which Chainlink is
> fully retiring (testnets done; mainnet 2026-09-01). If you want proof-verification
> to actually run, we recommend a backend-signed attestation (same pattern as the
> registrar's `signer`). The escrow's manual Approve & Release works without it.
