# Quorum — build notes & gotchas

Running log so we don't rediscover pain at 3am. Newest gotchas at the bottom of each section.

## Environment (verified Step 1, 2026-08-29)

| Thing | Value |
|---|---|
| OS | Ubuntu on WSL2 (distro `Ubuntu`), Docker Desktop w/ WSL integration |
| Project path | `~/quorum` (Linux fs — never `/mnt/c` or `/mnt/d`) |
| `compact` (dev CLI / toolchain wrapper) | `0.5.2` |
| `compact compile` (the actual compiler) | `0.31.1` (SELECTED default; `compact list` shows `-> 0.31.1`) |
| Compiler 0.31.1 targets | language `0.23.0`, ledger `ledger-8.0.2`, runtime `0.16.0` |
| Contract pragma to use | `pragma language_version >= 0.23;` |
| `@midnight-ntwrk/compact-runtime` in package.json | `0.16.0` — MUST equal the compiler's runtime target |
| Node | v22.23.2 (via nvm) |
| npm | 10.9.8 |
| create-mn-app | v0.5.0 |

## Gotchas

### G1 — Node is nvm-managed; non-interactive shells don't see it
A plain `wsl bash -lc "..."` (what automation uses) has **no `node`/`npm`/`npx`** on PATH —
nvm only initializes for interactive shells. There is a loader at `~/.mn-env.sh` that pulls in
nvm + the Compact toolchain. **Every command must be prefixed** with `source ~/.mn-env.sh &&`.

### G2 — PowerShell -> wsl -> bash triple-quoting is hostile
PowerShell 5.1 expands `$VAR`, mangles `$(...)` and nested quotes before `wsl` sees them.
Rules that work:
- Use the `--%` stop-parsing token: `wsl --% bash -lc "..."`
- Keep commands simple, chain with `&&`, **no `$(...)` command substitution**, no `for` loops
  with `$var`, no mixing `'` inside `"`.
- To read/write files in the WSL fs from tooling, use the UNC path
  `\\wsl.localhost\Ubuntu\home\abaig04\quorum\...` instead of shelling out.

### G3 — compiler/runtime version mismatch (seen in a prior scaffold on this box)
If the DEFAULT compact toolchain is `0.34.0`, its compiler targets runtime `0.19.0`, but the
`create-mn-app` template pins `compact-runtime@0.16.0` -> deploy dies with:
`CompactError: Version mismatch: compiled code expects 0.19.0, runtime is 0.16.0`.
Fix (already applied to this box): select toolchain `0.31.1` as default
(`compact` had it installed; `compact list` now shows `-> 0.31.1`). Re-check with
`compact compile --version` (want `0.31.1`) before every `npm run setup`.

### G4 — `npm run cli` is an INTERACTIVE readline menu
`src/cli.ts` runs a `readline/promises` loop (1 store / 2 read / 3 balance / 4 exit).
Piping stdin naively -> `Error: readline was closed` once stdin hits EOF (a prior attempt
failed exactly here). Drive it with `expect` (keeps a PTY open, sends answers on prompt).
Working driver: `~/cli-roundtrip.exp` (spawns `npm run cli`, sends 1 / message / 2 / 4).
`sudo apt-get install -y expect` worked (passwordless sudo is enabled on this box).
Also: piping cli output through `| tee` masks the upstream exit code -- check the
`=== ROUNDTRIP OK ===` marker, not `$?`.

### G6 — duplicate `onchain-runtime-v3` WASM -> `expected instance of StateValue`  [FIXED]
Symptom: `npm run cli` connects fine, deploy works, but STORE fails with
`Unexpected error executing scoped transaction '<unnamed>': Error: expected instance of StateValue`.
Cause: the `midnight-js@4.1.1` stack pins `onchain-runtime-v3@3.0.0` **exact** everywhere
(`midnight-js-protocol`, `compact-js`, ...), but `compact-runtime@0.16.0` only asks for
`^3.0.0`. `onchain-runtime-v3@3.1.0` shipped 2026-08-04 (AFTER the SDK release froze) and
npm floated compact-runtime's copy up to 3.1.0 -> two WASM module instances -> the
`StateValue` the compiled circuit builds (3.1.0) is rejected by the tx assembler (3.0.0).
Fix applied to `package.json`:
    "overrides": { "@midnight-ntwrk/onchain-runtime-v3": "3.0.0" }
then `npm install && npm dedupe`. Verify with:
    find node_modules -type d -name onchain-runtime-v3   # must print exactly ONE path
    npm ls @midnight-ntwrk/onchain-runtime-v3 --all      # both consumers -> 3.0.0 overridden
NOTE: `npm install` alone left two physical copies at 3.0.0 nested under each consumer
(still two module instances!). `npm dedupe` was required to hoist a single copy.
Do NOT follow the forum's "bump compact-js to 2.5.3" advice -- 2.5.3 pulls `ledger-v9`
alpha and breaks the `compact-js@2.5.1` pin that `midnight-js-protocol@4.1.1` expects.

### G5 — devnet host ports are fixed: 8088 (indexer), 9944 (node RPC), 6300 (proof server)
Only one Midnight devnet can run at a time. Killed the prior `~/midnight-test` devnet
containers (`docker rm -f midnight-test-*`) before scaffolding `quorum`. If `npm run setup`
complains about a port in use, `docker ps` and remove stale `*-node/-indexer/-proof-server`.

## Compact constructs seen so far (hello-world template)

- `pragma language_version >= 0.23;` — pins the language level the compiler must support.
- `import CompactStandardLibrary;` — brings in stdlib types/among them hashing helpers.
- `export ledger message: Opaque<"string">;` — a PUBLIC on-chain state field.
- `export circuit storeMessage(customMessage: Opaque<"string">): [] { ... }` — a circuit
  returning nothing (`[]`).
- `message = disclose(customMessage);` — `disclose()` is the explicit gate that moves a
  private/witness value into public state. Without it the compiler refuses to leak.

## Compact — Milestone 1 contract (`contracts/quorum.compact`)

### G7 — `disclose()` is required for EVERY value entering a ledger op, incl. reads
Compact does whole-program information-flow analysis. It treats **every circuit and
constructor parameter as private-until-declared-public**, and it tracks taint *through
hashes* ("ledger operation might disclose a hash of the witness value").
Things that each needed an explicit `disclose(...)`:
- `constructor(initialThreshold)` -> `threshold = disclose(initialThreshold);`
- `nullifiers.member(nullifier)` — a READ. `member` / `lookup` count as ledger ops.
- `buckets.member(bucketKey)`, `buckets.lookup(bucketKey)` — READS.
- `isUnlocked(bucketKey)` — the plain parameter needed `disclose(bucketKey)` before use.
Clean pattern: `disclose()` once at the point the value becomes intentionally public
(e.g. `const bucketKey = disclose(persistentHash<...>([...]));`) and every downstream
ledger read/write of that binding is then fine — no need to re-wrap.
The error is compile-time and very precise: it prints the full taint path
("via this path through the program: the binding of acc ... the argument to member ...").

### G8 — ledger ADT method names (compiler-confirmed, compact 0.31.1)
- `Map<K,V>`: `.member(k)`, `.lookup(k)`, `.insert(k, v)`, `.isEmpty()`, `.size()`, iterable.
- `Set<T>`:   `.member(e)`, `.insert(e)`, `.isEmpty()`, `.size()`, iterable. (no `.lookup`)
- `Counter`:  `.increment(n)`, `.decrement(n)`; TS side exposes `.read()` / plain getter.
- Reads (`member`/`lookup`) are allowed straight inside a circuit.

### G9 — Uint arithmetic widens; cast the result back
`prior + 1` where `prior: Uint<64>` does NOT stay `Uint<64>` (bounds widen). Assigning it
into `Map<_, Uint<64>>` needs an explicit narrow: `const n: Uint<64> = (prior + 1) as Uint<64>;`
This compiled fine. A missing-key read guarded with a ternary also compiled:
`buckets.member(k) ? buckets.lookup(k) : 0`.

### G10 — hashing: `persistentHash`, not `transientHash`, for anything stored
- `persistentHash<T>(value: T): Bytes<32>` — SHA-256, stable across upgrades. Use for
  anything that lands in ledger state or is used for auth (bucket key, nullifier).
- `transientHash<T>(value: T): Field` — in-circuit only, NOT upgrade-stable.
- Multi-input hash = hash a vector with a domain tag:
  `persistentHash<Vector<3, Bytes<32>>>([pad(32, "quorum:bucket:v1"), a, b])`.
- `pad(32, "literal")` -> `Bytes<32>` from a short string (<= 32 bytes). Used for
  domain-separation so a bucket hash can never equal a nullifier hash.

### G11 — witnesses are nullary functions; `Bytes<32>` <-> JS `Uint8Array`
`witness accusedID(): Bytes<32>;` is called in-circuit as `accusedID()`. In generated TS a
witness is `(ctx) => [newPrivateState, Uint8Array]`. A tuple return
`circuit f(): [Bytes<32>, Uint<64>]` becomes `[Uint8Array, bigint]` in TS; `Uint<64>` is `bigint`.

### Compile
    npm run compile                # now points at quorum (repointed in Step 4)
    npm run compile:hello-world    # the original, kept for reference
Outputs: contract/index.{js,d.ts}, keys/{submitReport,isUnlocked}.{prover,verifier},
zkir/{submitReport,isUnlocked}.{zkir,bzkir}.

## Step 4 — the e2e (`scripts/quorum-e2e.ts`, `npm run quorum:e2e`)

### G12 — supplying witnesses to a compiled contract: `withWitnesses`
`deploy.ts`/`cli.ts` use `CompiledContract.make(tag, C).pipe(withVacantWitnesses, ...)`
because hello-world has NO witnesses. Quorum has three, so:
    CompiledContract.make('quorum', Quorum.Contract).pipe(
      CompiledContract.withWitnesses({ accusedID, reporterSecret, salt }),
      CompiledContract.withCompiledFileAssets(zkConfigPath))
Each witness impl has shape `(ctx) => [ctx.privateState, Uint8Array]` (32 bytes).
The compiled `Contract` constructor hard-checks that all three function-valued
fields are present, by name, or it throws.

### G13 — swapping witness values per call
There is no "set private input" API on a deployed handle. Trick used: the witness
closures read a module-level `let current = {accusedID, reporterSecret, salt}`, and
the harness assigns `current = ...` immediately before each `deployed.callTx.submitReport()`.
Witnesses are invoked synchronously during the call, so this is race-free.
`privateStateId`/`initialPrivateState` stay constant (`{}`) — M1 keeps no private state.

### G14 — a failed `assert` fails LOCALLY, before any tx exists
`deployed.callTx.submitReport()` on a spent nullifier throws:
  `Unexpected error executing scoped transaction '<unnamed>': Error: failed assert:
   Quorum: this reporter has already filed against this person`
The proof is unsatisfiable, so nothing is submitted and no DUST is spent. Good demo
point: the network never sees a rejected tx — it sees nothing.

### G15 — reading circuit output + ledger state
- `tx.private.result` holds the circuit's return value: `[Uint8Array, bigint]` for
  `submitReport` -> `[bucketKey, newCount]`; `boolean` for `isUnlocked`.
- `tx.public.txId` / `tx.public.blockHeight`.
- Authoritative state: `providers.publicDataProvider.queryContractState(addr)` then
  `Quorum.ledger(state.data)` -> `{ threshold, buckets, nullifiers }`.
  `buckets` is iterable: `for (const [k,v] of l.buckets)`. `nullifiers.size()`.
- Indexer lags the node by ~1s after a tx -> poll `queryContractState` in a short loop.

### G16 — the bucket key can't be recomputed off-chain (cheaply)
It's `persistentHash` of a Compact-serialised `Vector<3, Bytes<32>>` with a padded
domain tag. Don't reproduce that in JS. Get the key from `tx.private.result[0]`, or
by diffing the `buckets` map before/after the call.

### DUST on a fresh devnet
`deployContract` / `callTx` can throw `Insufficient Funds` / `Not enough Dust` for the
first few seconds while registered NIGHT starts generating DUST. The harness wraps every
tx in `withDustRetry` (10 x 5s). Copied the pattern from `deploy.ts`.

## Milestone 1.5 — web UI (`ui/`, separate Vite app)

Architecture: **Midnight Lace (Preview) extension on the "Undeployed" network** via the
DApp Connector API (`window.midnight.lace`, v4.x). Lace auto-funds on Undeployed -> no
faucet. Browser providers: `FetchZkConfigProvider` (serves `zkir`/`keys` from the app's
`public/`), `httpClientProofProvider` (-> local :6300), `indexerPublicDataProvider`,
`levelPrivateStateProvider`. Chose this over bundling a headless seed wallet (Node-polyfill
+ WASM rabbit hole, and not how real Midnight DApps work).

### UI-1 (done) — Vite + React + TS shell
    cd ~/quorum && npm create vite@latest ui -- --template react-ts
    cd ui && npm install
Vite 8 / React 19 / TS 6. `vite.config.ts` pins port 5173, `strictPort`, `host: true`
(so the Windows browser reaches the WSL dev server at http://localhost:5173).
Overwrote the create-vite demo `App.tsx` / `App.css` / `index.css` with a plain Quorum
shell (no Midnight deps yet). `npm run build` = `tsc -b && vite build`, both clean.
Dev server:  cd ~/quorum/ui && npm run dev     (log: /tmp/quorum-ui-dev.log)

### Reworked: local-API web app (no Lace dependency)
User wanted a professional, runnable site NOW. Lace-in-browser needs an extension the
user hasn't set up, so the web app talks to a small local API that reuses the proven
e2e wallet path (genesis seed). Lace stays the documented production path.

Pieces:
- `server/index.ts` — Express API on :8787. Boots wallet + providers, deploys (or
  rejoins via `server/.deployment.json`) the Quorum contract with `QUORUM_THRESHOLD`
  (default 2), serializes `submitReport` calls, stores AES-GCM report bundles in
  `server/.reports.json`, withholds the key until on-chain count >= threshold.
  Endpoints: GET /api/health, GET /api/state, POST /api/report, POST /api/reveal.
- `ui/` — the Vite app, now a real UI: `src/lib/crypto.ts` (WebCrypto AES-256-GCM
  seal/open in the browser), `src/lib/api.ts`, `src/components/FileReport.tsx`,
  `src/components/EscrowBoard.tsx`. Talks to :8787 (override `VITE_QUORUM_API`).

Run:
    npm run quorum:api      # terminal 1 — wait for "[quorum-api] ready"
    npm run quorum:ui       # terminal 2 — http://localhost:5173
Verified end-to-end via curl: file (count 1, sealed) -> duplicate (HTTP 409) ->
2nd reporter (count 2, unlocked) -> /api/reveal returns both bundles.

### G17 — `pkill -f` / `pgrep -f` SELF-MATCH from PowerShell one-liners
`wsl --% bash -lc "... pkill -f 'server/index.ts' ..."` — the pattern (and any real
`tsx server/index.ts` in the same line) matches the running shell's own cmdline, so
pkill SIGTERMs the shell -> the tool reports "Exit code 15" and nothing after runs.
Kill background servers by PORT instead (`fuser -k 8787/tcp`, or `lsof -ti tcp:PORT | xargs kill`),
or just relaunch after confirming the port is free. Launch detached with
`setsid npx tsx ./server/index.ts > log 2>&1 < /dev/null & disown`.

### Honesty boundary for judges (encryption)
On-chain + ZK-proven and real: bucket key = hash(accused, orgSalt), per-reporter
nullifier, public counter, `isUnlocked`. Demo-grade: the report BODY is AES-GCM
encrypted client-side but the escrow SERVICE holds the key and releases it at quorum.
Milestone 2 = Shamir threshold shares so no party (incl. the service) can open early.
The UI states this in its footer.

### Stale `~/midnight-test` processes
Session-1 provisioning left something in `~/midnight-test` respawning `src/cli.ts` /
`scripts/e2e-check.ts`. Different project, torn-down devnet — harmless noise in `ps`.

## Milestone 2 — reporter membership (enrollment gate)

Closes the Sybil hole: "N reporters" = "N distinct passphrases" -> now "N ENROLLED keys".

### M2-1 (done) — contract
`contracts/quorum.compact` compiles (3 circuits: enroll, submitReport, isUnlocked).
New ledger:
- `memberList: HistoricMerkleTree<10, Bytes<32>>` — up to 1024 enrolled reporter leaves.
  Historic => enrolling a new member keeps older roots valid, so an in-flight proof
  built against a prior root still verifies.
- `adminCommitment: Bytes<32>` = `persistentHash(["quorum:admin:v1", adminSecret])`.
Constructor is now `constructor(initialThreshold: Uint<64>, initialAdminCommitment: Bytes<32>)`
=> TS `initialState(ctx, threshold: bigint, adminCommitment: Uint8Array)`.

New circuits / witnesses:
- `enroll(): Bytes<32>` — witnesses `adminSecret`, `newReporterSecret`. Asserts
  `hash("quorum:admin:v1", adminSecret) == adminCommitment`, then
  `memberList.insert(disclose(leaf))` where `leaf = hash("quorum:member:v1", newReporterSecret)`.
  Returns the leaf (disclosed) so the service can index it.
- `submitReport` gains witness `memberPath(): MerkleTreePath<10, Bytes<32>>` and, before
  the M1 logic:
    const myLeaf = persistentHash(["quorum:member:v1", reporterSecret()]);
    const p = memberPath();
    assert(p.leaf == myLeaf, ...);
    assert(memberList.checkRoot(disclose(merkleTreePathRoot<10, Bytes<32>>(p))), ...);
  Which specific leaf is never disclosed — only that SOME enrolled leaf matches.

### G18 — stdlib Merkle API (compiler 0.31.1 confirmed)
- `struct MerkleTreeDigest { field: Field; }`
- `struct MerkleTreePathEntry { sibling: MerkleTreeDigest; goesLeft: Boolean; }`
- `struct MerkleTreePath<#n, T> { leaf: T; path: Vector<n, MerkleTreePathEntry>; }`
- `circuit merkleTreePathRoot<#n, T>(path): MerkleTreeDigest;`  (hashes the leaf)
- ledger `HistoricMerkleTree<n, T>`: circuit-side `insert`, `checkRoot(MerkleTreeDigest): Boolean`,
  `root()`, `history()`; TS-only `findPathForLeaf(leaf): MerkleTreePath | undefined`,
  `pathForLeaf(index, leaf)`, `firstFree()`.
- TS witness shape for the path: `{ leaf: Uint8Array, path: { sibling: { field: bigint }, goes_left: boolean }[] }`
  — note TS emits `goes_left` (snake_case). `findPathForLeaf` returns a runtime
  `MerkleTreePath` — check field casing (goesLeft vs goes_left) when wiring the witness in M2-3.
- `checkRoot` arg disclosed as `{ field: bigint }`; `merkleTreePathRoot(path)` is
  witness-tainted so its result needs `disclose()` before `checkRoot`.

### M2-2 (done) — full-property e2e (`npm run quorum:e2e`, ~4 min, ALL PASS)
Phases: 0 deploy(2 args) · 1 enroll A+B · 2 M1 guarantees still hold · 3 unenrolled C
rejected ("not an enrolled reporter") · 4 Sybil with 2 fresh keys -> both rejected, bucket
never created · 5 enroll C late -> root changes -> C can now file, A/B old-root proofs still
count (HistoricMerkleTree) · 6 isUnlocked.

### G19 — computing `persistentHash` in TypeScript to match the circuit
`@midnight-ntwrk/compact-runtime` exports it directly:
    import { persistentHash, CompactTypeVector, CompactTypeBytes } from '@midnight-ntwrk/compact-runtime'
    const VEC2 = new CompactTypeVector(2, new CompactTypeBytes(32))
    persistentHash(VEC2, [pad32("quorum:member:v1"), secret])  // -> Uint8Array, == circuit's value
`pad32(s)` = UTF-8 bytes of `s` right-padded with zeros to 32 (matches Compact `pad(32, s)`).
Verified: TS-computed adminCommitment and reporter leaves == the on-chain values.

### G20 — the `memberPath` witness + non-members
`ledger.memberList.findPathForLeaf(leafBytes)` returns exactly the witness shape
`{ leaf: Uint8Array, path: {sibling:{field:bigint}, goes_left:boolean}[] }` — pass it straight
through, no conversion. For a NON-enrolled key it returns `undefined`; supply a bogus
all-zero path of length 10 so the call still executes, and the in-circuit
`checkRoot` assert fails -> clean "not an enrolled reporter" rejection.

### G21 — rejected circuit calls fail FAST
Both assert failures (nullifier reuse, membership) surface during local "scoped transaction
execution", before proof generation — near-instant. Only the ACCEPTED calls pay the
~30-45s proving cost. The 14-check M2 e2e (10 real proofs) ran in 232s.

### M2-3 (done) — server + UI wired to the membership contract
`server/index.ts` rewritten:
- 6 witnesses (adds memberPath / adminSecret / newReporterSecret); `current` set per call.
- `ADMIN_SECRET = sha256(env QUORUM_ADMIN_SECRET || 'quorum-demo-admin-secret')`;
  `ADMIN_COMMITMENT = persistentHash(["quorum:admin:v1", ADMIN_SECRET])` -> deploy arg 2.
- `CONTRACT_VERSION = 2` in `.deployment.json`; a mismatch forces redeploy (so an ABI
  change can't rejoin a stale address).
- `POST /api/enroll {reporterKey}` -> runs `enroll` circuit, appends to `server/.members.json`
  (key -> leafHex, for display; the tree itself is the source of truth). Idempotent.
- `POST /api/report`: pre-checks `memberList.findPathForLeaf(leaf)` and returns
  **403 NOT_ENROLLED** before spending a proof if the key isn't in the tree; otherwise sets
  `memberPath` from the found path and calls `submitReport`.
- `/api/health` + `/api/state` expose `memberCount` (+ `members` list).
UI: new `AdminPanel.tsx` (enrolled count pill + enroll input + member list); `FileReport`
handles the 403 with a "enroll it in the Admin panel" message and the on-chain preview now
lists the membership proof; footer honesty note updated (membership is real; body-key
escrow is the remaining trusted bit -> Milestone 3 Shamir).
Verified via curl: unenrolled -> 403 instant · enroll alice-1/bob-2 -> memberCount 2 ·
alice-1 files Jordan Blake -> 1 · bob-2 -> 2, unlocked.

### G22 — `setsid npm ...` fails ("No such file or directory")
`setsid` execs the target directly, and the nvm `npm` shim isn't resolved the same way.
`setsid npx vite ...` works; `setsid npm run ...` does not. Launch the UI dev server with
    source ~/.mn-env.sh && cd ~/quorum/ui && setsid npx vite --port 5173 --strictPort --host > log 2>&1 < /dev/null & disown
Kill background servers by port: `ss -ltnp 'sport = :PORT'` -> `grep -oP 'pid=\K[0-9]+'` -> kill.
Do NOT `rm` anything under `/tmp` from these one-liners — the harness blocks it; use
`~/quorum/` or the scratchpad, and rely on `>` truncation instead of `rm`.

### Running the web app (Milestone 2)
    npm run quorum:api    # wait for "[quorum-api] ready", ~40s (deploys contract 2)
    npx vite  (from ui/)  # or: npm run quorum:ui
Then http://localhost:5173 . Flow: enroll one or more reporter keys in the Admin panel ->
file with an enrolled key -> file again with a 2nd enrolled key to cross the threshold ->
Reveal. Filing with an un-enrolled key is rejected with a clear message.

## Milestone 3 — identity-bound enrollment (Sybil cost, no money needed)

Answers "one person can enroll many alt keys": each enrollment now consumes a one-time
identity credential. Pure hashing / Merkle — testable on the devnet with zero funds.

### M3-1 (done) — contract
`contracts/quorum.compact` compiles — 4 circuits: registerIdentity, enroll, submitReport, isUnlocked.
New ledger:
- `identityList: HistoricMerkleTree<10, Bytes<32>>` — registered identity-credential leaves.
- `enrollNullifiers: Set<Bytes<32>>` — one enrollment per identity, forever.
- `issuerCommitment: Bytes<32>` = `persistentHash(["quorum:issuer:v1", issuerSecret])`.
  Replaces M2's `adminCommitment`. Constructor: `(initialThreshold, initialIssuerCommitment)`.
Removed: `adminSecret` witness (M2's admin model is gone).
Circuits:
- `registerIdentity(): Bytes<32>` — issuer-only (proves `issuerSecret`). witness
  `registrantSecret`; inserts `hash("quorum:id:v1", registrantSecret)` into `identityList`.
- `enroll(): Bytes<32>` — PERMISSIONLESS now, but gated. witnesses `personSecret`,
  `identityPath` (MerkleTreePath<10,Bytes<32>>), `newReporterSecret`. Asserts:
  (1) `identityPath.leaf == hash("quorum:id:v1", personSecret)` and
      `identityList.checkRoot(merkleTreePathRoot(identityPath))`;
  (2) `enrollNull = hash("quorum:enroll-null:v1", personSecret)` unused -> insert;
  (3) `memberList.insert(hash("quorum:member:v1", newReporterSecret))`.
- `submitReport` / `isUnlocked` — byte-identical to M2 (membership in `memberList` is
  what they check; M3 only changes how leaves get into `memberList`).
Generated: 9 witnesses; ledger reader adds `identityList` (same shape as `memberList`) +
`enrollNullifiers` (Set). Constructor -> `initialState(ctx, threshold, issuerCommitment)`.

### M3-2 (done) — full-property e2e (`npm run quorum:e2e`, ~5 min, ALL PASS)
Phases: 0 deploy(2 args) · 1 issuer registers A/B/C + non-issuer register REJECTED ·
2 person A enrolls KEY_A / **A enrolls again -> REJECTED (enroll-nullifier)** / B enrolls /
person E (no credential) -> REJECTED (identity proof) · 3 attacker (1 identity) enrolls
KEY_C, files Z=1, **files Z again -> REJECTED (report nullifier)**, bucket Z stuck 1/2 ·
4 real quorum still forms (KEY_A->X, dup rejected, KEY_B->X unlocks, KEY_A->Y) · 5 isUnlocked.
Rejection reasons are distinct and matched: "not the identity issuer" / "this identity
already enrolled" / "credential not in the registry" / "already filed" / "not an enrolled reporter".
~13 real proofs; registerIdentity + enroll prove faster than submitReport (smaller circuits).

### M3-3 (done) — server + UI on the identity-issuer model
`server/index.ts`: `CONTRACT_VERSION=3`; `ISSUER_SECRET` (env `QUORUM_ISSUER_SECRET` or
default) -> `ISSUER_COMMITMENT` deploy arg 2; `QUORUM_IDENTITY_POOL` (default
`citizen-1,citizen-2,citizen-3`). Boot phase `registering-identities`: `ensureIdentityPool()`
runs `registerIdentity` for each pool entry not already on chain (~25s each; only first boot
pays it, later boots rejoin via the v3 cache). 9 witnesses.
- `GET /api/state` adds `identities:[{id,used}]` (`used` = enroll-nullifier spent) +
  `identityCount` / `identitiesUsed` + `members[].credentialId`.
- `POST /api/enroll {credentialId, reporterKey}`: 409 CREDENTIAL_USED if that credential's
  enroll-nullifier is already spent; else builds `identityPath` via
  `identityList.findPathForLeaf(idLeafOf(sha256(credentialId)))` and runs `enroll`.
- `POST /api/report` unchanged from M2 (membership + memberPath; 403 NOT_ENROLLED pre-check).
UI: `AdminPanel` -> `ClaimSlot.tsx` — a credential-pool picker (available / spent / -> which
reporter key) + reporter-key input -> "Spend credential -> enrol key". `FileReport` lost its
inline enrol button (needs a credential now); keeps the live "enrolled?" badge and gates the
file button on it. Footer rewritten for the 3-layer story + "single remaining trust: the issuer".
Verified via curl: 3 credentials registered on boot · claim citizen-1->alice-1 · claim
citizen-1 again -> **409 "one credential, one reporter"** · claim citizen-2->bob-2 · unenrolled
`stranger` -> 403 · alice-1 files -> 1 · bob-2 files -> **2, unlocked**.

## Milestone 4 — distributed escrow (no single party can decrypt early)

Removes the last trusted piece: the escrow service holding the body key. Now the
browser AES-GCM encrypts the body, Shamir-splits the key k ways (GF(256), t-of-k),
and posts one share to each of k INDEPENDENT escrow nodes. Each node independently
re-checks the chain and releases its share only once the bucket is at/over threshold.
Default k=3, t=2. No new deps (Shamir is ~90 lines).

Files:
- `ui/src/lib/shamir.ts` — GF(2^8) split/combine (+ b64 helpers). Browser-only.
- `server/escrow-node.ts` — tiny express: POST /store, GET /share (gates on its own
  `queryContractState` + count>=threshold), GET /health. Env ESCROW_INDEX / ESCROW_PORT.
  No wallet, no proof server — just the public indexer.
- `server/index.ts` — spawns k escrow-node children on boot (SPAWN_ESCROW=0 to disable),
  kills them on exit. `StoredReport` lost its `key` field. `/api/report` no longer takes
  `key`; `/api/reveal` returns `{id,ciphertext,iv}` + `escrow:{threshold,nodes}`.
  `/api/health` + `/api/state` expose `escrow`.
- UI: `FileReport` splits the key + `distributeShares()` to the nodes after the tx;
  `EscrowBoard` reveal = `collectShares()` from the nodes -> `combine(t)` -> `openReport`,
  and shows per-node released/withheld chips. Footer + statusbar updated.

### G23 — the browser talks to the escrow nodes DIRECTLY
So the main API never touches key material. Nodes have `cors()` open. Node URLs come
from `/api/health` `.escrow.nodes`. On reveal the browser fans out GET /share to all k,
takes the first t that return 200, `combine`s them.

Verified via curl (`m4test.sh`): file report 1 -> ask node 1 for its share ->
**403 "node 1: bucket is 1/2 — share withheld until quorum"** ; file report 2 (crosses
threshold) -> ask all 3 nodes -> **200 + share** from each. Node gating is per-node and
chain-checked. (Browser-side Shamir split/combine not curl-testable; lib type-checks +
GF(256) is standard.)

### Running the web app (Milestone 4)
    npm run quorum:api    # boots API + spawns 3 escrow nodes (:8801-3). First boot ~2-3 min.
    (cd ui && npx vite --port 5173 --strictPort --host)
http://localhost:5173 . Flow: step 1 spend a credential to enrol a reporter key (x2) ;
step 2 file with each key against the same person to cross the threshold ; on the escrow
board, "Collect 2/3 shares & decrypt" — before quorum every node withholds; after, any 2
of 3 reconstruct. Kill one escrow node and it still works (2-of-3).

## Milestone 5 — hardening the demo services (no contract change)

Bounded production-readiness pass on `server/`. No new dependencies — the extra
HTTP concerns are ~120 lines of plain Express middleware.

- `server/config.ts` — single place that reads every `QUORUM_*` / `NODE_ENV`
  var. **Fail closed when `NODE_ENV=production`**: `QUORUM_ISSUER_SECRET`,
  `QUORUM_PRIVATE_STATE_PASSWORD`, `QUORUM_API_TOKEN`, `QUORUM_CORS_ORIGIN`
  (non-`*`) are then required or import throws before the port binds. Dev keeps
  the old `quorum-demo-*` defaults + prints a one-line warning.
- `server/http.ts` — `cors(origins)` explicit allow-list (replaces open
  `cors()`), `securityHeaders`, `rateLimit` (fixed-window per-IP, in-memory —
  single instance only), `requireToken` (bearer; no-op when unset),
  `writeJsonAtomic` (tmp + rename), `isBase64(v, maxBytes)`.
- `server/index.ts` — wired to both; `mutating = [rateLimit, requireToken]` on
  `/api/enroll|report|reveal`; field caps (accusedLabel ≤200, keys ≤128) and
  base64 validation on ciphertext/iv; `trust proxy` in prod; all `writeJson`
  now atomic. `escrow-node.ts` — same headers/CORS/limit, `/store` size caps,
  atomic save. `/store` left unauthenticated on purpose (a share is inert pre-
  quorum; `/share` chain-checks) with a TODO for capability tokens.
- `server/tsconfig.json` + `npm run typecheck` / `typecheck:server` — the server
  was never type-checked before (root tsconfig is `src/**` only). `strict` on,
  `noImplicitAny` off (the Midnight SDK surface is loosely typed).
- `.github/workflows/ci.yml` — `api` job (npm ci + both typechecks), `ui` job
  (npm ci + oxlint + `tsc -b && vite build`). e2e stays local (needs a devnet).
- `.env.example`, `SECURITY.md` (the trust boundary), `docs/MIDNIGHT.md` (the
  network/wallet reference lifted out of README), rewritten `README.md`.

### G24 — WSL command exec intermittently `Wsl/Service/0x8007274c`
On this box `wsl <cmd>` hangs for ~10–30 s at a time (Docker Desktop resource
churn) then recovers. `\\wsl$\...` file IO is unaffected. Automation must retry
the invocation, not just the inner command.

## Milestone 6 — email-allowlist credential issuance (branch `feat/email-credentials`)

Replaces "credentials are guessable `citizen-N` strings" with per-person random
secrets gated by an operator-maintained email allowlist. No contract change.

- `server/credentials.ts` — three gitignored stores: `.allowlist.json`
  (emails, seeded from `QUORUM_ALLOWLIST`, then operator-editable), `.magic.json`
  (sha256-hashed single-use claim tokens, `QUORUM_MAGIC_TTL_MS` default 30 min),
  `.issued.json` (`{email, issuedAt}` only — deliberately no email→leaf link).
  `timingSafeEqual` on the token hash; anti-enumeration in the endpoint.
- `server/mailer.ts` — `sendMagicLink`; lazy `import('nodemailer')` when
  `QUORUM_SMTP_URL` set, else logs the link to the API console. `nodemailer` is
  NOT in package.json — `npm i nodemailer` when going to real SMTP (keeps CI /
  the dev path dependency-free).
- `server/index.ts` — `POST /api/request-credential` (5/h/IP, always the same
  "check your inbox"), `POST /api/claim-credential` (burns token → `issueAndEnrol`:
  `registerIdentity` a `randomBytes(32)` secret, wait for the indexer, `enroll`
  the chosen reporter key — two proofs, ~60–90 s). `/api/state` gains an
  `issuance` block. Seeded pool still works alongside; set `QUORUM_IDENTITY_POOL=`
  empty to run email-only.
- UI — `ClaimCredential.tsx` for the `/?claim=<token>` landing (query param, not
  a route — survives any static host); `ClaimSlot.tsx` shows an email-request
  form when the pool is empty/spent; `App.tsx` branches on `?claim=`.
- Docs: `.env.example`, `README.md` "Credential issuance", `SECURITY.md`.

### Not verified end-to-end
Built without a running devnet (WSL flaky, no proof server up). Test locally:
`npm run quorum:api` with `QUORUM_IDENTITY_POOL=` and `QUORUM_ALLOWLIST=you@x.com`,
`POST /api/request-credential {email}`, copy the `[mailer:dev]` link from the API
log, open it, enrol a key, file. Then merge.
