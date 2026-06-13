# MettaPay — Base Sepolia handoff

Hi,

Quick update on the smart contracts. Everything is deployed and verified on **Base
Sepolia**, and there is **one small action on your side** to flip on the ENS
subnames. Details below.

---

## 1. What's live and working

**ProofLock escrow** — fully working on-chain (tested the complete buyer/seller
flow end to end: funding, proof submission, release, dispute + arbitration,
deadline refund — all in real transactions).

| Contract | Address (verified on Basescan) |
| --- | --- |
| EscrowFactory | `0xFbf178c4c491Fdf8108eE6E385217363f7A6432C` |
| Test USDC (mintable, 6-dec) | `0x7D6A9C0F49936F58e62BF1B92ca2CA079d845137` |
| MettaPaySubnameRegistrar | `0x563D6F6f089013693315eD17F02D67a27A80c2C3` |

**Subname registrar** — built exactly to your spec: a **free** automatic
`0x<wallet>.mettapay.eth` for every user, and a **paid** upgrade for a custom
name ($7 / $17 / $30 for 1 / 3 / 5 years, in USDC or ETH). It's deployed and
wired to your real Durin `mettapay.eth` registry.

## 2. One thing to fix on the address you sent

The address you gave as the Durin registry — `0x04658b29…25416` — is **not** your
ENS registry. On-chain it's an unrelated account-abstraction module (no ENS
functions), so subname minting would just fail against it.

**Good news:** I located your actual Durin registry on Base Sepolia myself by
matching `mettapay.eth`. You actually deployed **two**:

- `0xd9dc8056f4c517FcBD93a7f90b490721e2909D6e` — 2 subnames (I used this one)
- `0x7df495baAF6aAEAbA439b79b409045dA82E74929` — 1 subname

Both are named `mettapay.eth` and admin'd by your wallet
`0x89d0d8cEE487346c2f00bAEA60d03d71E6aeAbA3`.
👉 **Please confirm `0xd9dc8056…` is the one you want to use.** If it's the other
one, I'll re-point in two minutes.

## 3. Action required from you (1 transaction)

Our registrar can only create subnames once your registry authorizes it. Only
the registry **admin** (your wallet) can do this — by design in Durin.

**From `0x89d0d8cEE487346c2f00bAEA60d03d71E6aeAbA3`, call:**

```
Registry: 0xd9dc8056f4c517FcBD93a7f90b490721e2909D6e
Function: addRegistrar(address)
Argument: 0x563D6F6f089013693315eD17F02D67a27A80c2C3
```

You can do this on Basescan (Write Contract → `addRegistrar`) or via the Durin
dashboard. The moment it confirms, free + paid subnames work, and I'll capture a
live `0x….mettapay.eth` mint transaction to show you.

## 4. So names actually resolve in wallets (L1 wiring)

For `*.mettapay.eth` to resolve in ENS-aware wallets, `mettapay.eth` on L1 must
point at Durin's L1 Resolver and target your L2 registry. If you haven't already
done this in the Durin dashboard:

1. Set `mettapay.eth`'s resolver to Durin's L1 Resolver
   (`0x8A968aB9eb8C084FBC44c531058Fc9ef945c3D61` on Sepolia).
2. Call `setL2Registry(namehash("mettapay.eth"), 84532, 0xd9dc8056…)` on it.

(One-time, done by the `mettapay.eth` owner — Durin walks you through it.)

## 5. One optional question

Durin registries store **text records** (avatar, url, etc.) in addition to the
address. Our registrar sets the **address** record on claim, so the name resolves
to the user's wallet (the core feature). If you'd also like default **text
records** set at claim time, tell me and I'll add it — otherwise it's not needed.

---

### Summary of what you need to do
1. Confirm the registry to use (`0xd9dc8056…` recommended).
2. From the admin wallet, call `addRegistrar(0x563D6F6f…80c2C3)` on it.
3. (If not done) complete the L1 resolver wiring for `mettapay.eth`.

After step 2, I'll send you the live free-subname mint transaction. Thanks!
