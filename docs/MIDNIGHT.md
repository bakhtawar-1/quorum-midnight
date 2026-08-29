# Midnight networks, wallets & toolchain

Reference detail moved out of the top-level README. Operational notes and
gotchas from building this live in [`../NOTES.md`](../NOTES.md).

## ⚠️ LOCAL DEVNET ONLY

The deploy path uses a well-known genesis seed
(`0000…0001`) so the pre-minted NIGHT in the `dev` chain preset is immediately
available. **Do not use this seed against Preprod, mainnet, or any environment
that handles real value** — anyone running this devnet has full access to funds
at this seed.

## Networks

| Network      | When to use                                                                                  | Default? |
| ------------ | ------------------------------------------------------------------------------------------- | -------- |
| `undeployed` | Local devnet bundled in `docker-compose.yml`. Genesis seed is hardcoded; no funding needed. | yes      |
| `preview`    | Public preview testnet. Faucet at `https://midnight-tmnight-preview.nethermind.dev`.        |          |
| `preprod`    | Public preprod testnet. Faucet at `https://midnight-tmnight-preprod.nethermind.dev`.       |          |

The active network is **sticky**: whichever network you last interacted with
stays active until you switch. Any command run with `--network <name>` also sets
that network active for subsequent commands.

```sh
npm run setup -- --network preview   # runs on preview AND makes it active
npm run network preview              # switch without running anything
npm run network                      # print the current active network
npm run network undeployed           # back to local devnet
```

## How wallets work across networks

- `undeployed` uses a hardcoded genesis seed; the local devnet pre-funds it.
- `preview` / `preprod` generate a fresh wallet on first use: a 24-word BIP-39
  recovery phrase (printed once) plus its derived seed, both stored in
  `.midnight-state.json` (gitignored). The wallet survives switching networks.
- **Back up your recovery phrase** if you fund a public-network wallet you care
  about. It is kept in `.midnight-state.json` under
  `wallets.<network>.mnemonic`. Anyone holding the phrase controls the wallet.
- Wallets created before mnemonic support keep working from their stored `seed`.

### Using the same wallet as Lace

Seeds are derived with the standard BIP-39 `mnemonicToSeed` step — the same
convention Lace uses.

- **Bring your Lace wallet here**: pass your recovery phrase via
  `MIDNIGHT_WALLET_MNEMONIC`. To keep it out of shell history:

  ```bash
  read -s MIDNIGHT_WALLET_MNEMONIC && export MIDNIGHT_WALLET_MNEMONIC
  npm run deploy
  ```
- **Take a scaffold wallet to Lace**: restore Lace from the 24-word phrase in
  `.midnight-state.json`.

### Funding a public-network wallet

On the first run with `--network preview` (or `preprod`):

1. `setup` prints your wallet address and the faucet URL.
2. Open the faucet URL, paste the address, request tNIGHT.
3. `setup` polls the balance every 10 s and continues once funds arrive.
4. Default poll budget is 10 minutes — override with
   `MIDNIGHT_FAUCET_TIMEOUT_MS=1800000` (30 min) for unattended runs.

If the faucet is slow or the script times out, your seed is preserved. Re-run
`npm run setup -- --network preview` once the funds land.

## Environment overrides

These override the active network's config (they apply to whichever network is
active for the run):

| Variable                     | Effect                                                                                                        |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `MIDNIGHT_WALLET_SEED`       | Use this hex seed (32–128 hex chars; a Lace-compatible BIP-39 seed is 128) instead of generating one.        |
| `MIDNIGHT_WALLET_MNEMONIC`   | Use this BIP-39 recovery phrase instead of generating a wallet. Not persisted. Set only one of seed/mnemonic. |
| `MIDNIGHT_INDEXER_URL`       | Override the indexer GraphQL URL.                                                                            |
| `MIDNIGHT_INDEXER_WS_URL`    | Override the indexer WS URL.                                                                                 |
| `MIDNIGHT_NODE_URL`          | Override the node RPC URL.                                                                                    |
| `MIDNIGHT_FAUCET_URL`        | Override the faucet URL printed during setup.                                                                 |
| `MIDNIGHT_PROOF_SERVER_URL`  | Override the proof server URL — set to a public proof server to skip running one locally.                     |
| `MIDNIGHT_FAUCET_TIMEOUT_MS` | Faucet poll budget in milliseconds (default 600000 = 10 min).                                                 |

By default all networks use the **local** proof server, which keeps your witness
data on your machine.

## Wallet sync cache

After each `deploy`, `cli`, or `check-balance` run, the wallet's synced state is
serialized to `.midnight-wallet-state/<network>/` (gitignored). The next run on
the same network restores from that snapshot instead of replaying from genesis.
If the cache is stale or corrupt it falls back to a fresh from-seed sync with a
one-line warning. `npm run clean` removes it.

## Compact compiler version

`.compact-version` at the create-mn-app repo root pinned the compiler version
this project was scaffolded against.

```bash
compact update <version>
compact use <version>
```

This project is built and verified against compiler `0.31.1` (language `0.23.0`,
`compact-runtime@0.16.0`). See [`../NOTES.md`](../NOTES.md) §G3 for the
version-mismatch failure mode and fix.
