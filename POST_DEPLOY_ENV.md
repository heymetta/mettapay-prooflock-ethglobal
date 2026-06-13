# Post-deploy: app .env

Paste these into the MettaPay app `.env` once Friday's deploys succeed, then
redeploy the app:

```
# ProofLock escrow
VITE_PROOFLOCK_VERIFIER_ADDRESS=<ProofLockVerifier address>
VITE_PROOFLOCK_FACTORY_ADDRESS=<EscrowFactory address>
VITE_PROOFLOCK_FEE_COLLECTOR=<treasury multisig>
VITE_PROOFLOCK_COMPLIANCE_OFFICER=<compliance officer wallet>

# ENS / Durin subnames (mettapay.eth)
VITE_DURIN_L2_REGISTRY=<Durin L2 Registry address>
VITE_MP_SUBNAME_REGISTRAR=<MettaPaySubnameRegistrar address>
```

Backend (Supabase secrets — set via Lovable Cloud):

- `MP_SUBNAME_BACKEND_SIGNER_PK` — private key for `BACKEND_SIGNER`
  (only needed if the server signs free-claim authorizations off-chain;
  on-chain `claimFree` is gated by `msg.sender == backendSigner`, so the
  backend must hold this key to mint the free 5-hex handles).
