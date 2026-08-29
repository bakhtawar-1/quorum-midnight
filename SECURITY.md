# Security model

Quorum is a hackathon project. This file is the honest boundary between what is
cryptographically enforced and what is still trusted.

## Enforced on chain, in zero knowledge

- **One reporter key → one report per person.** `submitReport` spends a
  nullifier `hash(reporterSecret, accusedID)`; reuse is rejected before any
  transaction exists.
- **Only enrolled keys can file.** `submitReport` proves the caller's key is a
  leaf of `memberList` without revealing which leaf.
- **One identity credential → one enrolled key.** `enroll` proves the caller
  holds a credential in `identityList` and spends a per-identity
  `enrollNullifier`. Forever.
- **Unlock is a threshold.** A bucket opens only when `count >= threshold`
  distinct enrolled reporters have named it.

## Still trusted

- **The issuer.** Sybil resistance reduces to "the issuer registers one
  credential per real human." Everything downstream of that is cryptographic;
  that step is not. In the demo the issuer is `server/index.ts` with a seeded
  pool (`citizen-1..3`) and a shared secret.
- **The signing wallet.** The demo API signs with the local devnet genesis seed
  (`0x0…01`). Production must use a real wallet (e.g. Lace). **Never point the
  demo at a network that holds real value** — see `README.md`.
- **Report bodies at rest.** Bodies are AES-256-GCM encrypted in the browser;
  the key is Shamir-split `t`-of-`k` across independent escrow nodes, each
  releasing its share only after its own on-chain quorum check. No single party
  can open a body early — but the escrow nodes are still operated by the demo.
- **Transport / storage.** The demo API and escrow nodes persist to local JSON
  files and (by default) speak plain HTTP on localhost.

## Hardening already in place

- `NODE_ENV=production` makes `server/config.ts` fail closed: no built-in
  secrets, no `*` CORS, a bearer token required on mutating endpoints.
- Per-IP rate limiting, security headers, request-size and field-length caps,
  base64 validation on ciphertext/iv, atomic store writes.

## Not for production yet

Real per-person credential issuance · Lace (or equivalent) signing · a database
instead of JSON files · deployment to a funded network · a capability-token
model for the escrow nodes. Tracked in `README.md` → "Production checklist".

## Reporting a vulnerability

Open a private security advisory on the GitHub repository, or contact the
maintainer listed there. Please do not open a public issue for anything
exploitable.
