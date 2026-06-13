# MettaPay × ENS — Durin L2 Subname Setup

This document is for ENS hackathon judges and operators wiring `mettapay.eth`
to the Durin L2 Registry running on Base. It explains the architecture, the
one-time L1 + L2 wiring, and where the relevant code lives inside this repo.

---

## 1. Architecture

```text
        ┌──────────────────────────────┐         ┌──────────────────────────────┐
        │  L1 Ethereum (mettapay.eth)  │ ─CCIP─▶ │  Base L2 — Durin Registry    │
        │  Resolver = Durin L1Resolver │         │  Owns *.mettapay.eth labels  │
        └──────────────┬───────────────┘         └──────────────┬───────────────┘
                       │                                          │
                       │  resolves name → address                 │  emits SubnameClaimed
                       ▼                                          ▼
              ┌──────────────────┐                     ┌────────────────────────┐
              │  MettaPay app    │ ─ verifies tx ────▶ │  Database mirror        │
              │  (TanStack Start)│                     │  public.ens_subnames    │
              └──────────────────┘                     └────────────────────────┘
```

- **L1 (`mettapay.eth`)** points its resolver at Durin's L1 CCIP-Read resolver.
- **L2 (Base, chainId 8453)** holds the canonical mapping `label → owner address`
  in the Durin L2 Registry. All issuance happens here — gasless for free
  names (signed by the registrar) and a tiny paid txn for custom names.
- **App database** (`public.ens_subnames`) mirrors the L2 state so the app
  can resolve names without an RPC round-trip on every payment.

## 2. One-time L1 + L2 wiring

> The exact Durin contract addresses come from the
> [Durin docs](https://durin.dev). Fill in the table below after deploy.

### 2.1 Deploy the L2 Registry + Registrar on Base

```sh
# Inside Durin's repo
ENS_PARENT="mettapay.eth" \
PARENT_OWNER="0xYourMultisig" \
forge script script/DeployL2Registry.s.sol \
  --rpc-url https://mainnet.base.org \
  --broadcast
```

Outputs:

| Contract            | Address (Base mainnet)        |
| ------------------- | ----------------------------- |
| L2 Registry         | `0x________________________`  |
| MettaPay Registrar  | `0x________________________`  |
| Treasury safe       | `0x________________________`  |

Set `VITE_MP_SUBNAME_REGISTRAR=0x…` in `.env` so the client send-by-name
quote/claim UI can call it (`src/routes/_authenticated/settings_.username.tsx`).

### 2.2 Point `mettapay.eth` at Durin's L1 Resolver

On the ENS Manager (`https://app.ens.domains/mettapay.eth`):

1. Set **Resolver** to Durin's L1 CCIP-Read Resolver
   (`0x________________________`).
2. Call `setL2Registry(8453, 0x<L2 Registry>)` on that resolver from the
   `mettapay.eth` owner wallet.
3. (Optional) Wrap `mettapay.eth` in NameWrapper if you want fuse-based
   permission management — not required for Durin.

### 2.3 Verify end-to-end

```ts
import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";

const client = createPublicClient({ chain: mainnet, transport: http() });
const addr = await client.getEnsAddress({ name: "test.mettapay.eth" });
console.log(addr); // → 0x… resolved via CCIP-Read from Base
```

If `addr` matches the wallet that claimed `test`, the L1 → L2 hop works.

## 3. App integration map

| Concern                | File                                                      |
| ---------------------- | --------------------------------------------------------- |
| Server logic + pricing | `src/lib/ens.functions.ts`                                |
| DB schema + RPCs       | `supabase/migrations/…_ens_subnames.sql`                  |
| Auto-issue on connect  | `src/components/prooflock/ConnectWalletButton.tsx`        |
| Customization UI       | `src/routes/_authenticated/settings_.username.tsx`        |
| Header pill            | `src/components/prooflock/AppHeader.tsx` (`SubnamePill`)  |
| Send-by-name (wallet)  | `src/components/dashboard/QuickSendCard.tsx`              |
| Send-by-name (escrow)  | `public.resolve_recipient` RPC (used in escrow + chat)    |

### Pricing (USDC, 1:1; ETH quoted via Chainlink Base ETH/USD)

| Years | USD | Notes                            |
| ----- | --- | -------------------------------- |
| 1     | $7  | Default starter tier             |
| 3     | $17 | ~19% discount vs. yearly         |
| 5     | $30 | ~14% discount vs. 3-year         |

Free `0x{first5}.mettapay.eth` is auto-issued on first wallet link — no expiry,
deterministic so the wallet always resolves even without paid customization.

## 4. ENS prize judging checklist

- [x] Subname issuance lives on an **L2 (Base)** via Durin's pattern — gasless
      free tier, paid customization in ETH or USDC.
- [x] L1 `mettapay.eth` is resolvable from any ENS-aware wallet via
      **CCIP-Read** through Durin's L1 Resolver.
- [x] App resolves names **bidirectionally**: address → primary name (header
      pill, recipient trust badge) and name → address (escrow recipient,
      wallet quick-send).
- [x] Reserved labels, length/charset validation, race-safe DB write — see
      `validateLabel` and the unique index on `lower(label)` in the migration.
- [x] On-chain payment is **verified server-side** (transaction receipt + `from`
      match) before the DB row is upgraded to `paid` — see `claimCustomSubname`.

## 5. Operational notes

- Renewals reuse `claimCustomSubname` with a `tx_hash` for a registrar
  `renew(label, years)` call; expiry is recomputed `now + years * 365d`.
- The free tier never expires; users can switch to paid at any time and the
  upgrade replaces (does not duplicate) their existing row.
- If `VITE_MP_SUBNAME_REGISTRAR` is unset, the `/settings/username` page still
  renders quotes but the "Pay" button stays disabled — useful for staged demos.
