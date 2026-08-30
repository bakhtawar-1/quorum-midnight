# Quorum — anonymous allegation escrow on Midnight

## Inspiration

Picture the room you're already in. A company with a few hundred employees, or a
single university department. Everyone who belongs there has a work email, and
that list of emails is the entire world of people who could ever use this tool.

Now something happens. A manager who crosses a line in one-on-ones. A professor
who retaliates against students who push back. A colleague whose "jokes" you've
watched land on three different people. You're fairly sure you're not the only
one who has noticed. But "fairly sure" is not something you can act on, because
the first person to file a lone complaint carries all of the risk:

- If you're the only name on it, you're identifiable by process of elimination.
- One report against a senior person is easy to wave away as a personality clash.
- If it goes nowhere, you are now *the person who complained.*

So nobody goes first. The information exists — it's just spread across people who
each individually can't afford to speak. This is the **"I'm not the only one"**
problem, and it's why whisper networks exist and why so much misconduct stays an
open secret for years.

**Quorum is a mechanism for going first safely, by making "going first" mean
nothing until enough other people have independently done the same.**

## What it does

The operator — HR, an ombuds office, a student union, a department admin — seeds
an **allowlist of verified emails**: exactly the people who belong in that room.
That list is the only trust the operator holds.

From there, as a reporter:

1. **Claim a slot.** You verify your email once and get a single-use link. You
   choose a private passphrase; the server mints you a one-time credential and
   spends it to enrol a *reporter key* derived from that passphrase. One email,
   one enrolment, ever. The server keeps no record of which key came from which
   email.
2. **File — once.** You name a person and write down what happened. The report
   body is encrypted **in your browser** before it leaves your machine. On chain,
   all that lands is a single counter — keyed by a hash of the accused's
   identity — ticking up by one. You may file against a given person **exactly
   once**; a second attempt from your key is rejected before a transaction even
   exists.
3. **Nothing happens.** No email goes out. Nobody — not the operator, not the
   accused, not the other reporters — learns that you filed, or that the counter
   moved. The encrypted body sits in escrow, split into pieces, and every
   piece-holder refuses to hand its piece over.
4. **The quorum forms.** Elsewhere, independently, other verified people file
   against the *same* person. When the counter reaches the threshold $t$ the
   operator fixed at deploy time (say $t = 3$), the bucket unlocks.
5. **Now the people who need to know, know.** The escrow pieces release, the
   bodies decrypt, and a *corroborated set* of reports becomes visible to the
   people entitled to act on it — and to the reporters, who finally learn they
   were right. It surfaces as a group finding, at one moment, instead of one
   exposed individual's accusation.

Below threshold, Quorum is a sealed vault. At threshold, it's a filing cabinet
that was already full.

## The hard part: what "independent" means

A counter is worthless if one motivated person can drive it alone. The whole
design exists to make $N$ on the counter mean *$N$ distinct human beings*, while
revealing nothing about who they are. Three layers, all enforced in zero
knowledge in [`contracts/quorum.compact`](../contracts/quorum.compact):

**A · Nullifier — one key, one report per person.**
Filing publishes a nullifier

$$\text{nullifier} = H(\texttt{"quorum:nullifier:v1"},\ \texttt{reporterSecret},\ \texttt{accusedID})$$

into an on-chain set. It is deterministic in your key and the accused, so a
second attempt reproduces the same value and is refused — yet it is a one-way
hash, so it links to neither.

**B · Membership — only enrolled people can file, and nobody can tell which one
did.** `submitReport` proves your reporter key is a leaf of a Merkle tree of
enrolled keys (`HistoricMerkleTree<10>`, up to 1024 reporters) *without revealing
which leaf*. An outsider's key produces no valid proof at all.

**C · Identity-bound enrolment — one verified identity, one key.**
A key becomes a leaf only via `enroll`, which spends a one-time identity
credential (itself a leaf of an issuer-published tree) and burns a per-identity
enrol-nullifier. One issued credential → one enrolled key → one report per
person. Stacking alt accounts would require the operator handing you several
credentials — the one thing they are trusted not to do.

**Escrow · no early reveal, no single custodian.**
The body key is AES-256-GCM in the browser, then Shamir-split $t$-of-$k$
(default $2$-of-$3$) across independent escrow nodes. Each node re-checks the
chain itself and releases its share only once

$$\texttt{buckets}[\text{bucketKey}] \ \ge\ \texttt{threshold}.$$

No single node — and no operator — can reconstruct a body early.

We keep an explicit honesty boundary in
[`SECURITY.md`](../SECURITY.md): everything above is cryptographic; what remains
*trusted* is the operator registering one credential per real person, plus (in
this demo) the signing wallet and the fact that we run the escrow nodes.

## How we built it

- **Contract:** [Compact](https://midnight.network) (`pragma language_version >= 0.23`,
  compiler `0.31.1`) — four circuits, `registerIdentity`, `enroll`,
  `submitReport`, `isUnlocked`, over a ledger of two Merkle trees, two nullifier
  sets, a bucket map and a threshold.
- **Demo API** (`server/index.ts`, Express): boots a Midnight wallet, deploys or
  rejoins the contract, serialises `submitReport` calls, drives the nine ZK
  witnesses, and issues email credentials. It never sees a plaintext body or a
  body key.
- **Escrow nodes** (`server/escrow-node.ts`): $k$ tiny independent services, each
  with nothing but the public indexer and its own quorum check.
- **UI** (`ui/`, Vite + React): passphrase → reporter key, browser-side AES-GCM
  seal, Shamir split, the file/reveal flow, and a live status board.
- **Property test** (`scripts/quorum-e2e.ts`): deploy → enrol → Sybil attempts →
  quorum → unlock — ~13 real proofs against a local devnet.

We built it in milestones — nullifier → membership → identity-bound enrolment →
distributed escrow → service hardening → email-allowlist issuance — each one
closing a specific way to cheat the counter.

## Challenges we faced

- **Compact's information-flow analysis.** Every circuit parameter is
  private-until-declared-public, and taint is tracked *through hashes*. Every
  value entering a ledger operation — including reads such as `set.member(x)` —
  needs an explicit `disclose()`. Excellent discipline once it clicks; a wall of
  (very precise) taint-path errors until it does.
- **Version-pinning hell.** The compiler's runtime target, `compact-runtime`,
  and a transitive `onchain-runtime-v3` WASM must all agree to the patch
  version. A floated `3.0.0 → 3.1.0` gave us two WASM instances and a cryptic
  `expected instance of StateValue` at store time; the fix was an `overrides`
  pin *plus* `npm dedupe` to collapse the duplicate copy.
- **Merkle witnesses across the FFI.** The generated TypeScript emits
  `goes_left` (snake_case) where the runtime struct uses `goesLeft`; a
  non-member needs a bogus all-zero path of length 10 so the call still executes
  and the in-circuit `checkRoot` produces a clean rejection.
- **Swapping private inputs per call.** There is no "set witness" API on a
  deployed handle, so the witness closures read a module-level `current` that
  the harness reassigns immediately before each call — race-free because
  witnesses are invoked synchronously.
- **Designing the trust boundary honestly.** The hardest non-code work was
  writing down, without hand-waving, exactly which guarantees are cryptographic
  and which are still "trust the operator" — and building the UI so a reporter
  sees that line too.

## What we learned

Zero-knowledge is less about hiding data and more about **proving a predicate
over data you refuse to reveal** — "I am one of these people, and I have not done
this before" is now a sentence you can enforce. We also learned how much of a
privacy tool's integrity lives *outside* the circuit: identity issuance, key
custody, transport, and the honesty of the docs.

## What's next

Real wallet signing (Lace) instead of a devnet seed; deployment to a funded
network; a database instead of flat JSON files; capability tokens for the escrow
nodes; independently operated escrow; and a formal write-up of the issuance
model so an operator can be audited against "one credential per human."
