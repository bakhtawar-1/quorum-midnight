/**
 * Quorum -- end-to-end proof of the FULL security property (Milestone 3).
 *
 *   PHASE 1  issuer registers a pool of identity credentials
 *            + a non-issuer registration attempt is REJECTED
 *
 *   PHASE 2  identity-bound enrollment (permissionless, one per identity)
 *     - person A enrolls reporter key KEY_A                 ACCEPTED
 *     - person A enrolls AGAIN with a different key         REJECTED  (identity already enrolled)   <-- M3 headline
 *     - person B enrolls KEY_B                              ACCEPTED
 *     - person E (no credential) tries to enroll            REJECTED  (identity not registered)
 *
 *   PHASE 3  the Sybil attack, boxed in
 *     - attacker holds ONE identity (person C), enrolls KEY_C, files vs Z -> Z = 1
 *     - KEY_C files vs Z again                              REJECTED  (report nullifier)
 *     - a 2nd report on Z needs a 2nd issued identity, which the attacker does not have -> Z stuck at 1/2
 *
 *   PHASE 4  a real quorum still forms (M1 + M2 guarantees intact)
 *     - KEY_A -> X = 1 ; KEY_A -> X again REJECTED ; KEY_B -> X = 2 UNLOCKED ; KEY_A -> Y = 1
 *
 *   PHASE 5  isUnlocked reads
 *
 * Run:  npx tsx scripts/quorum-e2e.ts        (devnet must be up: docker ps)
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { WebSocket } from 'ws'
import * as Rx from 'rxjs'

import { deployContract } from '@midnight-ntwrk/midnight-js-contracts'
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider'
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider'
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider'
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider'
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js'
import { persistentHash, CompactTypeVector, CompactTypeBytes } from '@midnight-ntwrk/compact-runtime'

import { resolveNetwork, getOrCreateWallet } from '../src/network'
import { createWallet, persistWalletState, unshieldedToken } from '../src/wallet'

// @ts-expect-error the wallet SDK needs a global WebSocket
globalThis.WebSocket = WebSocket

// ── hashing that MATCHES the circuit ────────────────────────────────────────
const BYTES32 = new CompactTypeBytes(32)
const VEC2 = new CompactTypeVector(2, BYTES32)
const VEC3 = new CompactTypeVector(3, BYTES32)
function pad32(s: string): Uint8Array {
  const out = new Uint8Array(32)
  out.set(new TextEncoder().encode(s).subarray(0, 32))
  return out
}
const h2 = (tag: string, a: Uint8Array): Uint8Array => persistentHash(VEC2, [pad32(tag), a])
const h3 = (tag: string, a: Uint8Array, b: Uint8Array): Uint8Array => persistentHash(VEC3, [pad32(tag), a, b])
const idLeafOf = (personSecret: Uint8Array) => h2('quorum:id:v1', personSecret)
const memberLeafOf = (reporterKey: Uint8Array) => h2('quorum:member:v1', reporterKey)

// ── demo formatting ────────────────────────────────────────────────────────
const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
}
const rule = () => console.log(C.dim('─'.repeat(78)))
function banner(t: string) {
  console.log('')
  rule()
  console.log(`  ${C.bold(t)}`)
  rule()
}
const hex = (u: Uint8Array) => Buffer.from(u).toString('hex')
const short = (h: string) => `${h.slice(0, 8)}…${h.slice(-4)}`
const id32 = (b: number) => new Uint8Array(32).fill(b)

// ── fixed secrets (never leave this process) ───────────────────────────────
const THRESHOLD = 2n
const ISSUER_SECRET = id32(0x11)
const WRONG_ISSUER = id32(0xff)
const ORG_SALT = id32(0x50)
const ACCUSED_X = id32(0x58)
const ACCUSED_Y = id32(0x59)
const ACCUSED_Z = id32(0x5a)
const PERSON_A = id32(0xa0)
const PERSON_B = id32(0xb0)
const PERSON_C = id32(0xc0) // the "attacker" — holds exactly one identity
const PERSON_E = id32(0xe0) // never registered
const KEY_A = id32(0x41)
const KEY_A2 = id32(0x42) // person A's attempted 2nd key
const KEY_B = id32(0x43)
const KEY_C = id32(0x44)
const KEY_E = id32(0x45)

const failures: string[] = []
function check(cond: boolean, pass: string, fail: string) {
  if (cond) console.log(`  ${C.green('✓')} ${pass}`)
  else {
    console.log(`  ${C.red('✗')} ${fail}`)
    failures.push(fail)
  }
}

// ── witnesses read from `current`, set right before each serialized call ────
type PathEntry = { sibling: { field: bigint }; goes_left: boolean }
type MerklePath = { leaf: Uint8Array; path: PathEntry[] }
const DUMMY_PATH = (leaf: Uint8Array): MerklePath => ({
  leaf,
  path: Array.from({ length: 10 }, () => ({ sibling: { field: 0n }, goes_left: false })),
})
let current = {
  accusedID: ACCUSED_X,
  reporterSecret: KEY_A,
  salt: ORG_SALT,
  memberPath: DUMMY_PATH(id32(0)),
  issuerSecret: ISSUER_SECRET,
  registrantSecret: PERSON_A,
  personSecret: PERSON_A,
  identityPath: DUMMY_PATH(id32(0)),
  newReporterSecret: KEY_A,
}
const W = {
  accusedID: (c: any): [any, Uint8Array] => [c.privateState, current.accusedID],
  reporterSecret: (c: any): [any, Uint8Array] => [c.privateState, current.reporterSecret],
  salt: (c: any): [any, Uint8Array] => [c.privateState, current.salt],
  memberPath: (c: any): [any, MerklePath] => [c.privateState, current.memberPath],
  issuerSecret: (c: any): [any, Uint8Array] => [c.privateState, current.issuerSecret],
  registrantSecret: (c: any): [any, Uint8Array] => [c.privateState, current.registrantSecret],
  personSecret: (c: any): [any, Uint8Array] => [c.privateState, current.personSecret],
  identityPath: (c: any): [any, MerklePath] => [c.privateState, current.identityPath],
  newReporterSecret: (c: any): [any, Uint8Array] => [c.privateState, current.newReporterSecret],
}

async function waitForProofServer(url: string, tries = 60): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      await fetch(url, { method: 'GET', signal: AbortSignal.timeout(3000) })
      return
    } catch (err: any) {
      const code = err?.cause?.code || err?.code || ''
      if (code !== 'ECONNREFUSED' && code !== 'UND_ERR_CONNECT_TIMEOUT' && code !== 'UND_ERR_SOCKET') return
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error(`proof server never came up at ${url}`)
}
async function withDustRetry<T>(fn: () => Promise<T>, tries = 12): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (err: any) {
      const msg = `${err?.message ?? ''} ${err?.cause?.message ?? ''}`
      if (!/Not enough Dust|Insufficient Funds|could not balance dust/.test(msg) || attempt >= tries) throw err
      await new Promise((r) => setTimeout(r, 5000))
    }
  }
}
const rejectionReason = (msg: string): string =>
  /not the identity issuer/i.test(msg) ? 'issuer gate — not the identity issuer'
  : /already enrolled a reporter key/i.test(msg) ? 'enroll-nullifier — this identity already enrolled'
  : /identity credential is not registered/i.test(msg) ? 'identity proof — credential not in the registry'
  : /membership path is not for your key|not an enrolled reporter/i.test(msg) ? 'membership — not an enrolled reporter'
  : /already filed/i.test(msg) ? 'report nullifier — already filed against this person'
  : /assert|unsatisf|constraint|proof/i.test(msg) ? 'proof unsatisfiable'
  : msg.split('\n')[0].slice(0, 120)

async function main() {
  const started = Date.now()
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const zkConfigPath = path.resolve(__dirname, '..', 'contracts', 'managed', 'quorum')
  if (!fs.existsSync(path.join(zkConfigPath, 'contract', 'index.js'))) {
    console.error('Compiled contract missing. Run:  npm run compile')
    process.exit(1)
  }
  const Quorum = await import(pathToFileURL(path.join(zkConfigPath, 'contract', 'index.js')).href)
  const { network, config: networkConfig } = resolveNetwork()
  const { seed } = getOrCreateWallet(network)
  const ISSUER_COMMITMENT = h2('quorum:issuer:v1', ISSUER_SECRET)

  banner('QUORUM · Milestone 3 · identity-bound enrollment')
  console.log(`  network    ${network}   threshold ${THRESHOLD}`)
  console.log(`  issuer     commitment ${short(hex(ISSUER_COMMITMENT))}  (issuer secret never on chain)`)
  console.log(C.dim('  registered later: persons A, B, C   ·   never registered: person E'))

  // ── wallet + providers ───────────────────────────────────────────────────
  banner('Booting wallet + devnet providers')
  const walletCtx = await createWallet({ network, networkConfig, seed })
  const synced = await walletCtx.wallet.waitForSyncedState()
  await persistWalletState(network, walletCtx)
  console.log(`  wallet synced · ${(synced.unshielded.balances[unshieldedToken().raw] ?? 0n).toLocaleString()} tNight`)
  const dustState = await Rx.firstValueFrom(walletCtx.wallet.state().pipe(Rx.filter((s: any) => s.isSynced)))
  const unreg = dustState.unshielded.availableCoins.filter((c: any) => !c.meta?.registeredForDustGeneration)
  if (unreg.length > 0) {
    const recipe = await walletCtx.wallet.registerNightUtxosForDustGeneration(
      unreg,
      walletCtx.unshieldedKeystore.getPublicKey(),
      (p: any) => walletCtx.unshieldedKeystore.signData(p),
    )
    await walletCtx.wallet.submitTransaction(await walletCtx.wallet.finalizeRecipe(recipe))
  }
  if (dustState.dust.balance(new Date()) === 0n) {
    await Rx.firstValueFrom(
      walletCtx.wallet.state().pipe(
        Rx.throttleTime(5000),
        Rx.filter((s: any) => s.isSynced),
        Rx.filter((s: any) => s.dust.balance(new Date()) > 0n),
      ),
    )
  }
  await waitForProofServer(networkConfig.proofServer)
  console.log('  DUST ready · proof server ready')

  const walletProvider = {
    getCoinPublicKey: () => walletCtx.shieldedSecretKeys.coinPublicKey,
    getEncryptionPublicKey: () => walletCtx.shieldedSecretKeys.encryptionPublicKey,
    async balanceTx(tx: any, ttl?: Date) {
      const recipe = await walletCtx.wallet.balanceUnboundTransaction(
        tx,
        { shieldedSecretKeys: walletCtx.shieldedSecretKeys, dustSecretKey: walletCtx.dustSecretKey },
        { ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000) },
      )
      return walletCtx.wallet.finalizeRecipe(recipe)
    },
    submitTx: (tx: any) => walletCtx.wallet.submitTransaction(tx) as any,
  }
  const zkConfigProvider = new NodeZkConfigProvider(zkConfigPath)
  const providers = {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: 'quorum-e2e-state',
      accountId: walletCtx.unshieldedKeystore.getBech32Address().toString(),
      privateStoragePasswordProvider: () => 'Local-Devnet-Development-Placeholder-1',
    }),
    publicDataProvider: indexerPublicDataProvider(networkConfig.indexer, networkConfig.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(networkConfig.proofServer, zkConfigProvider),
    walletProvider,
    midnightProvider: walletProvider,
  }
  const compiled = CompiledContract.make('quorum', Quorum.Contract).pipe(
    CompiledContract.withWitnesses(W as any),
    CompiledContract.withCompiledFileAssets(zkConfigPath),
  )

  // ── PHASE 0: deploy ──────────────────────────────────────────────────────
  banner('PHASE 0 — deploy')
  const deployed: any = await withDustRetry(() =>
    deployContract(providers as any, {
      compiledContract: compiled as any,
      args: [THRESHOLD, ISSUER_COMMITMENT],
      privateStateId: 'quorumPS',
      initialPrivateState: {},
    }),
  )
  const address: string = deployed.deployTxData.public.contractAddress
  console.log(`  ${C.green('deployed')} at ${C.cyan(address)}`)

  const readLedger = async () => {
    const st = await providers.publicDataProvider.queryContractState(address)
    if (!st) throw new Error('queryContractState returned null')
    return Quorum.ledger(st.data) as any
  }
  const ledgerWhen = async (pred: (l: any) => boolean) => {
    for (let i = 0; i < 20; i++) {
      const l = await readLedger()
      if (pred(l)) return l
      await new Promise((r) => setTimeout(r, 1500))
    }
    return readLedger()
  }
  const bucketMap = (l: any) => {
    const m = new Map<string, bigint>()
    for (const [k, v] of l.buckets) m.set(hex(k), v)
    return m
  }

  const l0 = await readLedger()
  check(l0.threshold === THRESHOLD, `threshold reads back ${l0.threshold}`, `threshold wrong: ${l0.threshold}`)
  check(hex(l0.issuerCommitment) === hex(ISSUER_COMMITMENT), 'issuerCommitment matches TS-computed hash', 'issuerCommitment mismatch')
  check(
    l0.identityList.firstFree() === 0n && l0.memberList.firstFree() === 0n && l0.buckets.size() === 0n,
    'identity tree / member tree / buckets all empty',
    'ledger not empty at deploy',
  )

  // ── helpers ─────────────────────────────────────────────────────────────
  const registerIdentity = async (label: string, personSecret: Uint8Array) => {
    current = { ...current, issuerSecret: ISSUER_SECRET, registrantSecret: personSecret }
    const tx: any = await withDustRetry(() => deployed.callTx.registerIdentity())
    const returned: Uint8Array = tx?.private?.result ?? tx?.result
    check(hex(returned) === hex(idLeafOf(personSecret)), `registered ${label} · id-leaf ${short(hex(returned))}`, `${label} id-leaf mismatch`)
    await ledgerWhen((l) => l.identityList.findPathForLeaf(idLeafOf(personSecret)) !== undefined)
  }

  const enroll = async (
    step: string,
    personSecret: Uint8Array,
    reporterKey: Uint8Array,
    expect: 'accept' | 'reject',
  ) => {
    banner(`${step}`)
    const l = await readLedger()
    const idPath = l.identityList.findPathForLeaf(idLeafOf(personSecret)) as MerklePath | undefined
    current = {
      ...current,
      personSecret,
      identityPath: idPath ?? DUMMY_PATH(idLeafOf(personSecret)),
      newReporterSecret: reporterKey,
    }
    console.log(C.dim(`  holds a registered credential? ${idPath ? C.green('yes') : C.yellow('no')}`))
    try {
      const tx: any = await withDustRetry(() => deployed.callTx.enroll())
      if (expect === 'reject') return check(false, '', `${step} was ACCEPTED but must be rejected`)
      const leaf: Uint8Array = tx?.private?.result ?? tx?.result
      await ledgerWhen((l2) => l2.memberList.findPathForLeaf(memberLeafOf(reporterKey)) !== undefined)
      check(hex(leaf) === hex(memberLeafOf(reporterKey)), `${step} — ${C.green('ACCEPTED')}, reporter leaf ${short(hex(leaf))}`, `${step} leaf mismatch`)
    } catch (err: any) {
      const msg = err?.message ?? String(err)
      if (expect === 'accept') return check(false, '', `${step} FAILED unexpectedly: ${msg}`)
      check(true, `${step} — ${C.green('REJECTED')} · ${rejectionReason(msg)}`, '')
    }
  }

  const fileReport = async (
    step: string,
    title: string,
    accused: Uint8Array,
    reporterKey: Uint8Array,
    expect: 'accept' | 'reject',
  ) => {
    banner(`${step} — ${title}`)
    const l = await readLedger()
    const mPath = l.memberList.findPathForLeaf(memberLeafOf(reporterKey)) as MerklePath | undefined
    const before = bucketMap(l)
    current = {
      ...current,
      accusedID: accused,
      reporterSecret: reporterKey,
      salt: ORG_SALT,
      memberPath: mPath ?? DUMMY_PATH(memberLeafOf(reporterKey)),
    }
    try {
      const tx: any = await withDustRetry(() => deployed.callTx.submitReport())
      const res = tx?.private?.result ?? tx?.result
      const keyHex = Array.isArray(res) ? hex(res[0]) : ''
      const count = Array.isArray(res) ? BigInt(res[1]) : -1n
      if (expect === 'reject') {
        check(false, '', `${step} was ACCEPTED but must be rejected`)
        return { keyHex, count }
      }
      await ledgerWhen((l2) => {
        for (const [k, v] of bucketMap(l2)) if ((before.get(k) ?? 0n) < v) return true
        return false
      })
      check(true, `${step} — ${C.green('ACCEPTED')}, bucket ${short(keyHex)} = ${C.bold(String(count))}`, '')
      return { keyHex, count }
    } catch (err: any) {
      const msg = err?.message ?? String(err)
      if (expect === 'accept') {
        check(false, '', `${step} FAILED unexpectedly: ${msg}`)
        return { keyHex: '', count: -1n }
      }
      check(true, `${step} — ${C.green('REJECTED')} · ${rejectionReason(msg)}`, '')
      return { keyHex: '', count: -1n }
    }
  }

  // ── PHASE 1: issuer registers credentials ───────────────────────────────
  banner('PHASE 1 — issuer registers identity credentials')
  await registerIdentity('person A', PERSON_A)
  await registerIdentity('person B', PERSON_B)
  await registerIdentity('person C', PERSON_C)
  const l1 = await ledgerWhen((l) => l.identityList.firstFree() === 3n)
  check(l1.identityList.firstFree() === 3n, `identity registry holds 3 credentials · root ${short(String(l1.identityList.root().field))}`, `firstFree=${l1.identityList.firstFree()}`)

  banner('Non-issuer tries to register a credential')
  current = { ...current, issuerSecret: WRONG_ISSUER, registrantSecret: PERSON_E }
  try {
    await withDustRetry(() => deployed.callTx.registerIdentity())
    check(false, '', 'non-issuer registration was ACCEPTED')
  } catch (err: any) {
    check(true, `${C.green('REJECTED')} · ${rejectionReason(err?.message ?? String(err))}`, '')
  }

  // ── PHASE 2: identity-bound enrollment ─────────────────────────────────
  banner('PHASE 2 — identity-bound enrollment (permissionless, one per identity)')
  await enroll('Step 2a  person A enrolls reporter key KEY_A', PERSON_A, KEY_A, 'accept')
  await enroll('Step 2b  person A enrolls AGAIN with a different key', PERSON_A, KEY_A2, 'reject')
  await enroll('Step 2c  person B enrolls reporter key KEY_B', PERSON_B, KEY_B, 'accept')
  await enroll('Step 2d  person E (no credential) tries to enroll', PERSON_E, KEY_E, 'reject')
  const l2 = await readLedger()
  check(l2.memberList.firstFree() === 2n, 'member tree holds exactly 2 reporter keys (A and B)', `firstFree=${l2.memberList.firstFree()}`)

  // ── PHASE 3: the Sybil attack, boxed in ────────────────────────────────
  banner('PHASE 3 — the Sybil attack, boxed in')
  console.log(C.dim('  attacker holds ONE identity (person C). Goal: unlock person Z alone (needs 2 reports).'))
  await enroll('Step 3a  person C enrolls reporter key KEY_C', PERSON_C, KEY_C, 'accept')
  const z1 = await fileReport('Step 3b  KEY_C files against Z', 'first report on Z', ACCUSED_Z, KEY_C, 'accept')
  check(z1.count === 1n, 'bucket Z = 1', `expected 1, got ${z1.count}`)
  await fileReport('Step 3c  KEY_C files against Z AGAIN', 'second report on Z with the same key', ACCUSED_Z, KEY_C, 'reject')
  console.log(C.dim('  a 2nd nullifier on Z needs a 2nd enrolled key, which needs a 2nd issued identity (see 2b/2d).'))
  const l3 = await readLedger()
  check((bucketMap(l3).get(z1.keyHex) ?? 0n) === 1n, 'bucket Z is STUCK at 1/2 — the lone attacker cannot reach quorum', `bucket Z = ${bucketMap(l3).get(z1.keyHex)}`)

  // ── PHASE 4: a real quorum still forms ─────────────────────────────────
  banner('PHASE 4 — a real quorum still forms (M1 + M2 guarantees intact)')
  const x1 = await fileReport('Step 4a  KEY_A files against X', 'first report on X', ACCUSED_X, KEY_A, 'accept')
  check(x1.count === 1n, 'bucket X = 1', `expected 1, got ${x1.count}`)
  await fileReport('Step 4b  KEY_A files against X AGAIN', 'duplicate', ACCUSED_X, KEY_A, 'reject')
  const x2 = await fileReport('Step 4c  KEY_B files against X', 'independent second reporter', ACCUSED_X, KEY_B, 'accept')
  check(x2.count === 2n, 'bucket X = 2 → UNLOCKED', `expected 2, got ${x2.count}`)
  check(x2.keyHex === x1.keyHex, 'A and B landed in the SAME bucket for X', 'different buckets')
  const y1 = await fileReport('Step 4d  KEY_A files against Y', 'nullifier is per-accused', ACCUSED_Y, KEY_A, 'accept')
  check(y1.count === 1n && y1.keyHex !== x1.keyHex, 'bucket Y = 1, distinct from X — A not blocked', `Y=${y1.count}`)

  // ── PHASE 5: isUnlocked ───────────────────────────────────────────────
  banner('PHASE 5 — isUnlocked circuit')
  const ask = async (keyHex: string) => {
    current = { ...current, accusedID: ACCUSED_X, reporterSecret: KEY_A, salt: ORG_SALT }
    const tx: any = await withDustRetry(() => deployed.callTx.isUnlocked(Buffer.from(keyHex, 'hex')))
    return (tx?.private?.result ?? tx?.result) === true
  }
  check(await ask(x1.keyHex), 'isUnlocked(X) = true  (2 ≥ 2)', 'isUnlocked(X) should be true')
  check(!(await ask(y1.keyHex)), 'isUnlocked(Y) = false (1 < 2)', 'isUnlocked(Y) should be false')

  // ── final ────────────────────────────────────────────────────────────
  banner('FINAL LEDGER STATE')
  const fin = await readLedger()
  console.log(`  identities registered ${fin.identityList.firstFree()}   enrolled reporters ${fin.memberList.firstFree()}`)
  console.log(`  enroll-nullifiers ${fin.enrollNullifiers.size()}   report-nullifiers ${fin.nullifiers.size()}`)
  for (const [k, v] of bucketMap(fin)) {
    const tag = k === x1.keyHex ? 'X' : k === y1.keyHex ? 'Y' : k === z1.keyHex ? 'Z' : '?'
    const st = v >= fin.threshold ? C.green('UNLOCKED') : C.yellow('locked  ')
    console.log(`  ${st}  bucket(${tag}) ${short(k)}  count ${C.bold(String(v))}`)
  }

  banner(failures.length === 0 ? C.green('RESULT: ALL CHECKS PASSED ✅') : C.red(`RESULT: ${failures.length} CHECK(S) FAILED ❌`))
  for (const f of failures) console.log(`  ${C.red('•')} ${f}`)
  console.log(C.dim(`\n  elapsed ${((Date.now() - started) / 1000).toFixed(1)}s`))
  await walletCtx.wallet.stop()
  process.exit(failures.length === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\n' + C.red('e2e crashed:'))
  console.error(err)
  process.exit(1)
})
