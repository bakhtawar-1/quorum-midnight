# Quorum Escrow

**Anonymous allegation escrow on Midnight.** A report against a person stays
sealed until `threshold` *independent* reporters name the same person — then, and
only then, the bodies unlock. Every reporter is anonymous; "independent" is
enforced in zero knowledge, not by trust.

---

## Inspiration

Picture the room you're already in: a company of a few hundred people, or a
single university department. Everyone who belongs there has a work email, and
that list of emails is the entire world of people who could ever use this tool.

Then something happens. A manager who crosses a line in one-on-ones. A professor
who retaliates against students who push back. A colleague whose "jokes" you've
watched land on three different people. You're fairly sure you're not the only
one who noticed. But "fairly sure" isn't something you can act on, because the
first person to file a lone complaint carries all of the risk:

- If you're the only name on it, you're identifiable by process of elimination.
- One report against a senior person is easy to wave away as a personality clash.
- If it goes nowhere, you are now *the person who complained.*

So nobody goes first. The information exists — it's just spread across people who
each individually can't afford to speak. This is the **"I'm not the only one"**
problem, and it's why whisper networks exist and why so much misconduct stays an
open secret for years.

The naive fix — a shared counter, "click here if it happened to you too" — dies
instantly to a Sybil attack: one motivated person spins up ten identities and
manufactures a fake quorum, or the accused does it to bury a real one. Midnight
gave us the missing piece. With zero-knowledge proofs we can make the number on
that counter *mean something* — "$N$ reporters" can be made to mean "$N$ distinct
verified humans" while revealing nothing about who any of them is, or which
report is whose. **Quorum Escrow is a mechanism for going first safely, by making
"going first" count for nothing until enough other people have independently done
the same.**

## What it does

An operator — HR, an ombuds office, a student union, a department admin — seeds an
**allowlist of verified emails**: exactly the people who belong in that room. That
list is the only trust the operator holds.

From there, as a reporter:

1. **Claim a slot.** You verify your email once and get a single-use link. You
   pick a private passphrase; the server mints you a one-time credential and
   spends it to enroll a *reporter key* derived from that passphrase. One email,
   one enrollment, ever — and the server keeps no record of which key came from
   which email.
2. **File — once.** You name a person and write down what happened. The report
   body is encrypted **in your browser** before it leaves your machine. On chain,
   all that lands is a single counter — keyed by a hash of the accused's
   identity — ticking up by one. You may file against a given person **exactly
   once**; a second attempt from your key is rejected before a transaction even
   exists.
3. **Nothing happens.** No email goes out. Nobody — not the operator, not the
   accused, not the other reporters — learns that you filed or that the counter
   moved. The encrypted body sits in escrow, split into pieces, and every
   piece-holder refuses to hand its piece over.
4. **The quorum forms.** Elsewhere, independently, other verified people file
   against the *same* person. When the counter reaches the threshold $t$ the
   operator fixed at deploy time (say $t = 3$), the bucket unlocks.
5. **Now the people who need to know, know.** The escrow pieces release, the
   bodies decrypt, and a *corroborated set* of reports becomes visible at one
   moment — as a group finding, instead of one exposed individual's accusation.
   The reporters finally learn they were right.

Below threshold, Quorum Escrow is a sealed vault. At threshold, it's a filing
cabinet that was already full.

### What "independent" actually means

The whole design exists to make $N$ on the counter mean *$N$ distinct human
beings*. Three layers, all enforced in zero knowledge in
[`contracts/quorum.compact`](../contracts/quorum.compact):

**A · Nullifier — one key, one report per person.** Filing publishes

$$\text{nullifier} = H(\texttt{"quorum:nullifier:v1"},\ \texttt{reporterSecret},\ \texttt{accusedID})$$

into an on-chain set. It's deterministic in your key and the accused, so a second
attempt reproduces the same value and is refused — yet it's a one-way hash, so it
links to neither.

**B · Membership — only enrolled people can file, and nobody can tell which one
did.** `submitReport` proves your reporter key is a leaf of a Merkle tree of
enrolled keys (`HistoricMerkleTree<10>`, up to $1024$ reporters) *without
revealing which leaf*. An outsider's key produces no valid proof at all.

**C · Identity-bound enrollment — one verified identity, one key.** A key becomes
a leaf only via `enroll`, which proves possession of a one-time identity
credential (itself a leaf of an issuer-published tree) and burns a per-identity
nullifier $H(\texttt{"quorum:enroll-null:v1"},\ \texttt{personSecret})$. One
issued credential → one enrolled key → one report per person. A lone actor can
raise a bucket's count by at most $1$ per credential the operator hands them.

**Escrow · no early reveal, no single custodian.** The body key is AES-256-GCM in
the browser, then Shamir-split $t$-of-$k$ (default $2$-of-$3$) across independent
escrow nodes. Each node re-checks the chain itself and releases its share only
once $\texttt{buckets}[\text{bucketKey}] \ge \texttt{threshold}$.

We keep an explicit honesty boundary in [`SECURITY.md`](../SECURITY.md):
everything above is cryptographic. What remains *trusted* is the operator
registering one credential per real person — plus, in this demo, the signing
wallet and the fact that we run the escrow nodes.

## How we built it

- **Contract — Compact on Midnight.** `pragma language_version >= 0.23`, compiler
  `0.31.1` (language `0.23.0`, `compact-runtime@0.16.0`). Four circuits —
  `registerIdentity`, `enroll`, `submitReport`, `isUnlocked` — over a ledger of
  two `HistoricMerkleTree<10>`s, two nullifier `Set`s, a `Map<Bytes<32>, Uint<64>>`
  bucket counter, a `threshold`, and an `issuerCommitment`. All multi-input
  hashing is domain-separated with a padded tag (`pad(32, "quorum:bucket:v1")`,
  etc.) so a bucket hash can never collide with a nullifier.
- **Demo API** ([`server/index.ts`](../server/index.ts), Express, ~900 lines):
  boots a Midnight wallet, deploys or rejoins the contract, serializes
  `submitReport` calls, drives the nine ZK witnesses, and runs email credential
  issuance. It never sees a plaintext body or a body key.
- **Escrow nodes** ([`server/escrow-node.ts`](../server/escrow-node.ts)): $k$ tiny
  independent services — no wallet, no proof server, just the public indexer and
  their own quorum check. The browser talks to them **directly**, so the main API
  never touches key material.
- **UI** ([`ui/`](../ui), Vite + React + TS): passphrase → reporter key,
  browser-side AES-GCM seal, Shamir split, the claim / file / reveal flow, a live
  status board, and a light/dark design system. The "what actually leaves your
  device" panel spells out the proof, the bucket hash, the nullifier, and the
  `+1` before you submit.
- **Shamir** ([`ui/src/lib/shamir.ts`](../ui/src/lib/shamir.ts)): ~90 lines of
  $\mathrm{GF}(2^8)$ split/combine, browser-only, zero new dependencies.
- **Property test** ([`scripts/quorum-e2e.ts`](../scripts/quorum-e2e.ts)): deploy
  → enroll → Sybil attempts → quorum → unlock, ~13 real proofs against a local
  devnet in Docker.

We built it in milestones, each one closing a specific way to cheat the counter:
**M1** nullifier → **M2** membership Merkle proof → **M3** identity-bound
enrollment → **M4** distributed escrow → **M5** service hardening (fail-closed
config, rate limits, security headers, atomic writes, CI) → **M6** email-allowlist
issuance with random per-person secrets and single-use claim links.

## Challenges we ran into

- **Compact's information-flow analysis.** Every circuit parameter is
  private-until-declared-public, and taint is tracked *through hashes* — the
  compiler will tell you a "ledger operation might disclose a hash of the witness
  value." Every value entering a ledger op, **including reads** like
  `set.member(x)` and `map.lookup(k)`, needs an explicit `disclose()`. It's
  excellent discipline once it clicks, and a wall of (very precise) taint-path
  errors until it does.
- **Version-pinning hell.** The compiler's runtime target, `compact-runtime`, and
  a *transitive* `onchain-runtime-v3` WASM module all have to agree to the patch
  version. npm floated one copy `3.0.0 → 3.1.0`, we ended up with two WASM
  instances, and stores failed with a cryptic `expected instance of StateValue` —
  the `StateValue` one instance built was rejected by the other. The fix was an
  `overrides` pin **plus** `npm dedupe` to physically collapse the duplicate;
  `npm install` alone left two copies nested.
- **Merkle witnesses across the FFI.** The generated TypeScript emits `goes_left`
  (snake_case) where the runtime struct uses `goesLeft`. And a non-member has no
  path at all, so `findPathForLeaf` returns `undefined` — you have to feed the
  circuit a bogus all-zero path of length 10 so the call still executes and the
  in-circuit `checkRoot` produces a *clean* "you are not an enrolled reporter"
  rejection instead of a crash.
- **Swapping private inputs per call.** There's no "set witness" API on a deployed
  contract handle. The witness closures read a module-level `current` object that
  the harness reassigns immediately before each `callTx` — race-free only because
  witnesses are invoked synchronously during the call.
- **Fresh-devnet DUST.** The first transactions after deploy throw
  `Not enough Dust` for a few seconds while registered NIGHT starts generating
  DUST. Every tx is wrapped in a retry (10 × 5s).
- **The WSL2 dev loop.** nvm-managed Node isn't on `PATH` for non-interactive
  shells; PowerShell → `wsl` → bash triple-quoting mangles `$(...)`; `pkill -f
  'server/index.ts'` matches its own shell and kills it; `setsid npm` silently
  fails where `setsid npx` works. Most of [`NOTES.md`](../NOTES.md) is us not
  wanting to rediscover this at 3am.
- **Writing the trust boundary honestly.** The hardest non-code work was stating,
  without hand-waving, exactly which guarantees are cryptographic and which are
  still "trust the operator" — and building the UI so a reporter sees that line
  too.

## Accomplishments that we're proud of

- **A counter where $N$ genuinely means $N$ distinct issued identities**, proven
  in zero knowledge, revealing nothing about who reported or which report is
  whose.
- **The full property test passes.** Sybil attempts with fresh un-enrolled keys
  are rejected and the bucket is never even created; a duplicate filing is
  rejected *locally, before any transaction exists* — the network sees nothing
  and no fee is paid; a late enrollment still works because the
  `HistoricMerkleTree` keeps older roots valid, so an in-flight proof built
  against a prior root still counts. Every rejection reason is distinct and
  asserted: *"not the identity issuer" / "this identity already enrolled" /
  "credential not in the registry" / "already filed" / "not an enrolled
  reporter."*
- **No single party — including us — can open a report body early.** Browser
  AES-GCM, Shamir $2$-of-$3$ across nodes that each independently check the chain.
  Kill one escrow node and reveal still works.
- **It's a runnable web app, not just a contract** — claim, file, and reveal in
  the browser, with a live on-chain status board and an honesty note in the
  footer.
- **Fail-closed production config, per-IP rate limiting, security headers, atomic
  store writes, and green CI** (typecheck + UI lint/build) — for a hackathon
  build.
- **Zero extra crypto dependencies.** Shamir is ~90 lines of $\mathrm{GF}(2^8)$.

## What we learned

- **Zero-knowledge is less about hiding data and more about proving a predicate
  over data you refuse to reveal.** "I am one of these people, and I have not done
  this before" is now a sentence you can *enforce*.
- **How much of a privacy tool's integrity lives outside the circuit** — identity
  issuance, key custody, transport security, and the honesty of the docs. The
  circuit was the tractable part.
- **Historic Merkle trees are not a nicety.** Without them, every new enrollment
  would invalidate a proof another reporter already built and hadn't yet
  submitted.
- **Rejected ZK calls fail before proof generation.** Both the nullifier and
  membership asserts surface during local scoped-transaction execution — near
  instant — so only *accepted* filings pay the ~30–60s proving cost, and the
  chain never sees a rejected transaction.
- A lot of concrete Midnight practice: witness FFI shapes, `withWitnesses`,
  `persistentHash` vs `transientHash`, reproducing an in-circuit hash in
  TypeScript, indexer lag after a tx, and the dust-retry pattern.

## What's next for Quorum Escrow

- **Real wallet signing (Lace)** instead of the local devnet genesis seed, and
  deployment to a funded network (`preview` / `preprod`).
- **Independently operated escrow nodes** — different orgs or jurisdictions — plus
  capability tokens on the escrow `/store` endpoint.
- **A database** instead of flat JSON files, and rotating the issuer secret out of
  the app process.
- **Full end-to-end in CI** against an ephemeral devnet.
- **A formal, auditable write-up of the issuance model**, so an operator can be
  held to "one credential per human" by someone other than themselves.
- Product surface: time-bounded buckets, a retract/appeal flow, and a way to
  notify reporters that a quorum has formed without leaking who they are.
