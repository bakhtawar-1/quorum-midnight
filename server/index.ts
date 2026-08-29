/**
 * Quorum demo API  (Milestone 3 — identity-bound enrollment).
 *
 * Bridges the browser UI to the Quorum contract on the local devnet, reusing the
 * wallet / provider path proven in scripts/quorum-e2e.ts. No Lace needed: the
 * devnet genesis wallet signs. (Production swaps this for the user's Lace wallet.)
 *
 *   GET  /api/health     liveness + boot progress + counts
 *   GET  /api/state      threshold, identities, members, nullifiers, buckets + reports
 *   POST /api/enroll     claim a reporter slot: spend an identity credential to
 *                        enrol a reporter key  {credentialId, reporterKey}
 *   POST /api/report     file a report (proves membership + runs submitReport)
 *   POST /api/reveal     release sealed report bodies for an UNLOCKED bucket
 *
 * The issuer secret lives only here (QUORUM_ISSUER_SECRET or a dev default). On
 * first boot the issuer registers a small pool of identity credentials
 * (QUORUM_IDENTITY_POOL). Each credential can enrol exactly one reporter key —
 * the contract's enroll-nullifier enforces it.
 *
 * server/.reports.json holds each body's AES-GCM ciphertext/iv/key; the key is
 * withheld until the on-chain count reaches the threshold. Milestone 4 replaces
 * that trust with Shamir secret-sharing.
 */
import express from 'express';
import cors from 'cors';
import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import * as Rx from 'rxjs';

import { deployContract, findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';
import { persistentHash, CompactTypeVector, CompactTypeBytes } from '@midnight-ntwrk/compact-runtime';

import { resolveNetwork, getOrCreateWallet } from '../src/network';
import { createWallet, persistWalletState, unshieldedToken } from '../src/wallet';

// @ts-expect-error wallet sync needs a global WebSocket
globalThis.WebSocket = WebSocket;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.QUORUM_API_PORT ?? 8787);
const THRESHOLD = BigInt(process.env.QUORUM_THRESHOLD ?? '2');
const CONTRACT_VERSION = 3;
const IDENTITY_POOL = (process.env.QUORUM_IDENTITY_POOL ?? 'citizen-1,citizen-2,citizen-3')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Distributed escrow: k independent nodes each hold a Shamir share of every
// report's AES key; any t reconstruct. Each node gates its own release on an
// independent on-chain check. The browser splits and distributes shares — this
// API never touches key material.
const ESCROW_COUNT = Number(process.env.QUORUM_ESCROW_COUNT ?? 3);
const ESCROW_THRESHOLD = Number(process.env.QUORUM_ESCROW_THRESHOLD ?? 2);
const ESCROW_BASE_PORT = Number(process.env.QUORUM_ESCROW_BASE_PORT ?? 8801);
const SPAWN_ESCROW = process.env.QUORUM_SPAWN_ESCROW !== '0';
const escrowNodes = Array.from({ length: ESCROW_COUNT }, (_, i) => ({
  index: i + 1,
  url: `http://localhost:${ESCROW_BASE_PORT + i}`,
}));
const escrowProcs: ChildProcess[] = [];
const STORE_FILE = path.join(HERE, '.reports.json');
const MEMBERS_FILE = path.join(HERE, '.members.json');
const DEPLOY_FILE = path.join(HERE, '.deployment.json');
const ZK_DIR = path.resolve(HERE, '..', 'contracts', 'managed', 'quorum');

// ── hashing that matches the circuit (persistentHash over Vector<n, Bytes<32>>) ─
const BYTES32 = new CompactTypeBytes(32);
const VEC2 = new CompactTypeVector(2, BYTES32);
const VEC3 = new CompactTypeVector(3, BYTES32);
function pad32(s: string): Uint8Array {
  const out = new Uint8Array(32);
  out.set(new TextEncoder().encode(s).subarray(0, 32));
  return out;
}
const h2 = (tag: string, a: Uint8Array): Uint8Array => persistentHash(VEC2, [pad32(tag), a]);
const sha256 = (s: string | Uint8Array): Uint8Array =>
  new Uint8Array(createHash('sha256').update(typeof s === 'string' ? s.normalize('NFKC') : s).digest());
const hex = (u: Uint8Array): string => Buffer.from(u).toString('hex');
const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');

// derivations (both sides of every hash must agree with the circuit)
const registrantSecretOf = (credentialId: string): Uint8Array => sha256(credentialId);
const idLeafOf = (personSecret: Uint8Array): Uint8Array => h2('quorum:id:v1', personSecret);
const enrollNullOf = (personSecret: Uint8Array): Uint8Array => h2('quorum:enroll-null:v1', personSecret);
const reporterSecretOf = (key: string): Uint8Array => sha256(key);
const memberLeafOf = (key: string): Uint8Array => h2('quorum:member:v1', reporterSecretOf(key));

const ORG_SALT = sha256('quorum:v1:org:demo');
const ISSUER_SECRET = sha256(process.env.QUORUM_ISSUER_SECRET ?? 'quorum-demo-issuer-secret');
const ISSUER_COMMITMENT = h2('quorum:issuer:v1', ISSUER_SECRET);

// ── local stores ─────────────────────────────────────────────────────────
interface StoredReport {
  id: string;
  bucketKeyHex: string;
  accusedLabel: string;
  filedAt: string;
  ciphertext: string;
  iv: string;
  // NOTE: no `key` — the AES key is Shamir-split by the browser and held only
  // by the escrow nodes. This API cannot decrypt a report body.
}
interface StoredMember {
  key: string;
  credentialId: string;
  leafHex: string;
  enrolledAt: string;
}
const readJson = <T>(f: string, fallback: T): T => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8')) as T;
  } catch {
    return fallback;
  }
};
const writeJson = (f: string, v: unknown): void => fs.writeFileSync(f, JSON.stringify(v, null, 2));

// ── contract-call serialization ──────────────────────────────────────────
let chain: Promise<unknown> = Promise.resolve();
const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = chain.then(fn, fn) as Promise<T>;
  chain = run.then(() => undefined, () => undefined);
  return run;
};
async function withDustRetry<T>(fn: () => Promise<T>, tries = 12): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const msg = `${err?.message ?? ''} ${err?.cause?.message ?? ''}`;
      if (!/Not enough Dust|Insufficient Funds|could not balance dust/.test(msg) || attempt >= tries) throw err;
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

// ── witnesses (values set immediately before each serialized call) ────────
type PathEntry = { sibling: { field: bigint }; goes_left: boolean };
type MerklePath = { leaf: Uint8Array; path: PathEntry[] };
const dummyPath = (leaf: Uint8Array): MerklePath => ({
  leaf,
  path: Array.from({ length: 10 }, () => ({ sibling: { field: 0n }, goes_left: false })),
});
let current = {
  accusedID: new Uint8Array(32),
  reporterSecret: new Uint8Array(32),
  salt: ORG_SALT,
  memberPath: dummyPath(new Uint8Array(32)),
  issuerSecret: ISSUER_SECRET,
  registrantSecret: new Uint8Array(32),
  personSecret: new Uint8Array(32),
  identityPath: dummyPath(new Uint8Array(32)),
  newReporterSecret: new Uint8Array(32),
};
const witnesses = {
  accusedID: (c: any): [any, Uint8Array] => [c.privateState, current.accusedID],
  reporterSecret: (c: any): [any, Uint8Array] => [c.privateState, current.reporterSecret],
  salt: (c: any): [any, Uint8Array] => [c.privateState, current.salt],
  memberPath: (c: any): [any, MerklePath] => [c.privateState, current.memberPath],
  issuerSecret: (c: any): [any, Uint8Array] => [c.privateState, current.issuerSecret],
  registrantSecret: (c: any): [any, Uint8Array] => [c.privateState, current.registrantSecret],
  personSecret: (c: any): [any, Uint8Array] => [c.privateState, current.personSecret],
  identityPath: (c: any): [any, MerklePath] => [c.privateState, current.identityPath],
  newReporterSecret: (c: any): [any, Uint8Array] => [c.privateState, current.newReporterSecret],
};

// ── boot state ───────────────────────────────────────────────────────────
type BootState =
  | {
      phase:
        | 'starting'
        | 'syncing-wallet'
        | 'funding-dust'
        | 'deploying'
        | 'registering-identities'
        | 'ready';
      detail?: string;
    }
  | { phase: 'error'; detail: string };
let boot: BootState = { phase: 'starting' };

let Quorum: any;
let providers: any;
let deployed: any;
let contractAddress = '';

async function waitForProofServer(url: string, tries = 60): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      await fetch(url, { method: 'GET', signal: AbortSignal.timeout(3000) });
      return;
    } catch (err: any) {
      const code = err?.cause?.code || err?.code || '';
      if (code !== 'ECONNREFUSED' && code !== 'UND_ERR_CONNECT_TIMEOUT' && code !== 'UND_ERR_SOCKET') return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`proof server never came up at ${url}`);
}

async function readLedger() {
  const st = await providers.publicDataProvider.queryContractState(contractAddress);
  if (!st) throw new Error('queryContractState returned null');
  return Quorum.ledger(st.data) as any;
}

async function ensureIdentityPool(): Promise<void> {
  for (const id of IDENTITY_POOL) {
    const secret = registrantSecretOf(id);
    const l = await readLedger();
    if (l.identityList.findPathForLeaf(idLeafOf(secret))) continue;
    await serialize(async () => {
      current = { ...current, issuerSecret: ISSUER_SECRET, registrantSecret: secret };
      await withDustRetry(() => deployed.callTx.registerIdentity());
    });
    // let the indexer catch up before the next lookup
    for (let i = 0; i < 15; i++) {
      const l2 = await readLedger();
      if (l2.identityList.findPathForLeaf(idLeafOf(secret))) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

async function bootstrap(): Promise<void> {
  const { network, config: networkConfig } = resolveNetwork();
  const { seed } = getOrCreateWallet(network);

  const contractPath = path.join(ZK_DIR, 'contract', 'index.js');
  if (!fs.existsSync(contractPath)) throw new Error('contracts/managed/quorum missing — run `npm run compile`');
  Quorum = await import(pathToFileURL(contractPath).href);

  boot = { phase: 'syncing-wallet' };
  const walletCtx = await createWallet({ network, networkConfig, seed });
  await walletCtx.wallet.waitForSyncedState();
  await persistWalletState(network, walletCtx);

  boot = { phase: 'funding-dust' };
  const dustState = await Rx.firstValueFrom(walletCtx.wallet.state().pipe(Rx.filter((s: any) => s.isSynced)));
  const unregistered = dustState.unshielded.availableCoins.filter((c: any) => !c.meta?.registeredForDustGeneration);
  if (unregistered.length > 0) {
    const recipe = await walletCtx.wallet.registerNightUtxosForDustGeneration(
      unregistered,
      walletCtx.unshieldedKeystore.getPublicKey(),
      (p: any) => walletCtx.unshieldedKeystore.signData(p),
    );
    await walletCtx.wallet.submitTransaction(await walletCtx.wallet.finalizeRecipe(recipe));
  }
  if (dustState.dust.balance(new Date()) === 0n) {
    await Rx.firstValueFrom(
      walletCtx.wallet.state().pipe(
        Rx.throttleTime(5000),
        Rx.filter((s: any) => s.isSynced),
        Rx.filter((s: any) => s.dust.balance(new Date()) > 0n),
      ),
    );
  }
  await waitForProofServer(networkConfig.proofServer);

  const walletProvider = {
    getCoinPublicKey: () => walletCtx.shieldedSecretKeys.coinPublicKey,
    getEncryptionPublicKey: () => walletCtx.shieldedSecretKeys.encryptionPublicKey,
    async balanceTx(tx: any, ttl?: Date) {
      const recipe = await walletCtx.wallet.balanceUnboundTransaction(
        tx,
        { shieldedSecretKeys: walletCtx.shieldedSecretKeys, dustSecretKey: walletCtx.dustSecretKey },
        { ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000) },
      );
      return walletCtx.wallet.finalizeRecipe(recipe);
    },
    submitTx: (tx: any) => walletCtx.wallet.submitTransaction(tx) as any,
  };
  const zkConfigProvider = new NodeZkConfigProvider(ZK_DIR);
  providers = {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: 'quorum-demo-state',
      accountId: walletCtx.unshieldedKeystore.getBech32Address().toString(),
      privateStoragePasswordProvider: () => 'Local-Devnet-Development-Placeholder-1',
    }),
    publicDataProvider: indexerPublicDataProvider(networkConfig.indexer, networkConfig.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(networkConfig.proofServer, zkConfigProvider),
    walletProvider,
    midnightProvider: walletProvider,
  };

  const compiled = CompiledContract.make('quorum', Quorum.Contract).pipe(
    CompiledContract.withWitnesses(witnesses as any),
    CompiledContract.withCompiledFileAssets(ZK_DIR),
  );

  const cached = readJson<{ address: string; threshold: string; v?: number } | null>(DEPLOY_FILE, null);
  if (cached && cached.v === CONTRACT_VERSION && cached.threshold === THRESHOLD.toString()) {
    try {
      const probe = await providers.publicDataProvider.queryContractState(cached.address);
      if (probe) {
        contractAddress = cached.address;
        deployed = await findDeployedContract(providers, {
          compiledContract: compiled as any,
          contractAddress,
          privateStateId: 'quorumPS',
          initialPrivateState: {},
        });
      }
    } catch {
      /* fall through to deploy */
    }
  }
  if (!deployed) {
    boot = { phase: 'deploying' };
    deployed = await withDustRetry(() =>
      deployContract(providers, {
        compiledContract: compiled as any,
        args: [THRESHOLD, ISSUER_COMMITMENT],
        privateStateId: 'quorumPS',
        initialPrivateState: {},
      }),
    );
    contractAddress = deployed.deployTxData.public.contractAddress;
    writeJson(DEPLOY_FILE, { address: contractAddress, threshold: THRESHOLD.toString(), v: CONTRACT_VERSION });
    writeJson(STORE_FILE, []);
    writeJson(MEMBERS_FILE, []);
    for (let i = 1; i <= ESCROW_COUNT; i++) {
      try {
        fs.rmSync(path.join(HERE, `.escrow-${i}.json`));
      } catch {
        /* not there */
      }
    }
  }

  boot = { phase: 'registering-identities' };
  await ensureIdentityPool();

  if (SPAWN_ESCROW) startEscrowNodes();

  boot = { phase: 'ready' };
  const members = readJson<StoredMember[]>(MEMBERS_FILE, []);
  console.log(
    `[quorum-api] ready · contract ${contractAddress} · threshold ${THRESHOLD} · identities ${IDENTITY_POOL.length} · members ${members.length} · escrow ${ESCROW_THRESHOLD}-of-${ESCROW_COUNT}`,
  );
}

function startEscrowNodes(): void {
  const node = path.join(HERE, 'escrow-node.ts');
  for (const n of escrowNodes) {
    const p = spawn('npx', ['tsx', node], {
      env: { ...process.env, ESCROW_INDEX: String(n.index), ESCROW_PORT: String(ESCROW_BASE_PORT + n.index - 1) },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    p.on('error', (e) => console.error(`[escrow-node ${n.index}] spawn error:`, e.message));
    escrowProcs.push(p);
  }
}
function stopEscrowNodes(): void {
  for (const p of escrowProcs) {
    try {
      p.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
}
process.on('exit', stopEscrowNodes);
process.on('SIGINT', () => {
  stopEscrowNodes();
  process.exit(0);
});
process.on('SIGTERM', () => {
  stopEscrowNodes();
  process.exit(0);
});

// identity-pool status from the ledger
async function poolStatus(): Promise<{ id: string; used: boolean }[]> {
  const l = await readLedger();
  return IDENTITY_POOL.map((id) => ({
    id,
    used: l.enrollNullifiers.member(enrollNullOf(registrantSecretOf(id))),
  }));
}

// ── HTTP ─────────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json({ limit: '256kb' }));

app.get('/api/health', (_req, res) => {
  res.json({
    boot,
    contractAddress,
    threshold: Number(THRESHOLD),
    ready: boot.phase === 'ready',
    identityCount: IDENTITY_POOL.length,
    memberCount: readJson<StoredMember[]>(MEMBERS_FILE, []).length,
    escrow: { threshold: ESCROW_THRESHOLD, count: ESCROW_COUNT, nodes: escrowNodes },
  });
});

app.get('/api/state', async (_req, res) => {
  if (boot.phase !== 'ready') return res.status(503).json({ error: 'BOOTING', boot });
  try {
    const l = await readLedger();
    const rows = readJson<StoredReport[]>(STORE_FILE, []);
    const members = readJson<StoredMember[]>(MEMBERS_FILE, []);
    const identities = await poolStatus();

    const byKey = new Map<string, StoredReport[]>();
    for (const r of rows) {
      if (!byKey.has(r.bucketKeyHex)) byKey.set(r.bucketKeyHex, []);
      byKey.get(r.bucketKeyHex)!.push(r);
    }
    const buckets: any[] = [];
    for (const [k, count] of l.buckets) {
      const keyHex = hex(k);
      const reps = (byKey.get(keyHex) ?? []).sort((a, b) => a.filedAt.localeCompare(b.filedAt));
      const unlocked = count >= l.threshold;
      buckets.push({
        bucketKeyHex: keyHex,
        accusedLabel: reps[0]?.accusedLabel ?? '(unknown — filed elsewhere)',
        count: Number(count),
        threshold: Number(l.threshold),
        unlocked,
        reports: reps.map((r) => ({ id: r.id, filedAt: r.filedAt, sealed: !unlocked })),
      });
    }
    buckets.sort((a, b) => b.count - a.count || a.accusedLabel.localeCompare(b.accusedLabel));
    res.json({
      contractAddress,
      threshold: Number(l.threshold),
      nullifierCount: Number(l.nullifiers.size()),
      bucketCount: Number(l.buckets.size()),
      identityCount: IDENTITY_POOL.length,
      identitiesUsed: identities.filter((i) => i.used).length,
      identities,
      memberCount: Number(l.memberList.firstFree()),
      members: members.map((m) => ({ key: m.key, credentialId: m.credentialId, enrolledAt: m.enrolledAt })),
      escrow: { threshold: ESCROW_THRESHOLD, count: ESCROW_COUNT, nodes: escrowNodes },
      buckets,
    });
  } catch (err: any) {
    res.status(500).json({ error: 'STATE_FAILED', message: err?.message ?? String(err) });
  }
});

app.post('/api/enroll', async (req, res) => {
  if (boot.phase !== 'ready') return res.status(503).json({ error: 'BOOTING', boot });
  const { credentialId, reporterKey } = req.body ?? {};
  if (typeof credentialId !== 'string' || !IDENTITY_POOL.includes(credentialId)) {
    return res.status(400).json({ error: 'UNKNOWN_CREDENTIAL', message: 'Pick a credential from the pool.' });
  }
  if (typeof reporterKey !== 'string' || !reporterKey.trim()) {
    return res.status(400).json({ error: 'BAD_INPUT', message: 'reporterKey is required.' });
  }
  const key = reporterKey.trim();
  const secret = registrantSecretOf(credentialId);
  try {
    const l = await readLedger();
    if (l.enrollNullifiers.member(enrollNullOf(secret))) {
      return res.status(409).json({
        error: 'CREDENTIAL_USED',
        message: `Credential "${credentialId}" has already been used to enrol a reporter. One credential, one reporter.`,
      });
    }
    if (readJson<StoredMember[]>(MEMBERS_FILE, []).some((m) => m.key === key)) {
      return res.status(409).json({ error: 'KEY_TAKEN', message: `Reporter key "${key}" is already enrolled.` });
    }
    const idPath = l.identityList.findPathForLeaf(idLeafOf(secret)) as MerklePath | undefined;
    if (!idPath) {
      return res.status(500).json({ error: 'NOT_REGISTERED', message: `Credential "${credentialId}" is not registered on chain yet.` });
    }
    await serialize(async () => {
      current = {
        ...current,
        personSecret: secret,
        identityPath: idPath,
        newReporterSecret: reporterSecretOf(key),
      };
      await withDustRetry(() => deployed.callTx.enroll());
    });
    const members = readJson<StoredMember[]>(MEMBERS_FILE, []);
    members.push({ key, credentialId, leafHex: hex(memberLeafOf(key)), enrolledAt: new Date().toISOString() });
    writeJson(MEMBERS_FILE, members);
    res.json({ ok: true, key, credentialId, memberCount: members.length });
  } catch (err: any) {
    const msg = `${err?.message ?? ''} ${err?.cause?.message ?? ''}`;
    if (/already enrolled a reporter key/i.test(msg)) {
      return res.status(409).json({ error: 'CREDENTIAL_USED', message: `Credential "${credentialId}" was already used.` });
    }
    res.status(500).json({ error: 'ENROLL_FAILED', message: err?.message ?? String(err) });
  }
});

app.post('/api/report', async (req, res) => {
  if (boot.phase !== 'ready') return res.status(503).json({ error: 'BOOTING', boot });
  const { accusedLabel, reporterSecret, ciphertext, iv } = req.body ?? {};
  if (
    typeof accusedLabel !== 'string' || !accusedLabel.trim() ||
    typeof reporterSecret !== 'string' || !reporterSecret.trim() ||
    typeof ciphertext !== 'string' || typeof iv !== 'string'
  ) {
    return res.status(400).json({ error: 'BAD_INPUT', message: 'accusedLabel, reporterSecret and an encrypted body are required.' });
  }

  const leaf = memberLeafOf(reporterSecret);
  try {
    const pre = await readLedger();
    if (!pre.memberList.findPathForLeaf(leaf)) {
      return res.status(403).json({
        error: 'NOT_ENROLLED',
        message: 'This reporter key is not enrolled. Claim a reporter slot first (step 1).',
      });
    }
  } catch (err: any) {
    return res.status(500).json({ error: 'STATE_FAILED', message: err?.message ?? String(err) });
  }

  try {
    const outcome = await serialize(async () => {
      const l = await readLedger();
      const found = l.memberList.findPathForLeaf(leaf) as MerklePath | undefined;
      current = {
        ...current,
        accusedID: sha256(norm(accusedLabel)),
        reporterSecret: reporterSecretOf(reporterSecret),
        salt: ORG_SALT,
        memberPath: found ?? dummyPath(leaf),
      };
      const tx: any = await withDustRetry(() => deployed.callTx.submitReport());
      const result = tx?.private?.result ?? tx?.result;
      return {
        bucketKeyHex: Array.isArray(result) ? hex(result[0]) : '',
        count: Array.isArray(result) ? Number(result[1]) : NaN,
        txId: tx?.public?.txId ?? tx?.txId ?? null,
        blockHeight: tx?.public?.blockHeight ?? tx?.blockHeight ?? null,
      };
    });

    const rows = readJson<StoredReport[]>(STORE_FILE, []);
    const id = `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    rows.push({
      id,
      bucketKeyHex: outcome.bucketKeyHex,
      accusedLabel: accusedLabel.trim(),
      filedAt: new Date().toISOString(),
      ciphertext,
      iv,
    });
    writeJson(STORE_FILE, rows);

    const l = await readLedger();
    res.json({
      ok: true,
      reportId: id,
      bucketKeyHex: outcome.bucketKeyHex,
      count: outcome.count,
      threshold: Number(l.threshold),
      unlocked: outcome.count >= Number(l.threshold),
      txId: outcome.txId,
      blockHeight: outcome.blockHeight,
    });
  } catch (err: any) {
    const msg = `${err?.message ?? ''} ${err?.cause?.message ?? ''}`;
    if (/not an enrolled reporter/i.test(msg)) {
      return res.status(403).json({ error: 'NOT_ENROLLED', message: 'This reporter key is not enrolled.' });
    }
    if (/already filed|failed assert|nullifier|unsatisf/i.test(msg)) {
      return res.status(409).json({
        error: 'DUPLICATE',
        message: 'That reporter key has already filed against this person. One reporter, one report per person.',
      });
    }
    res.status(500).json({ error: 'SUBMIT_FAILED', message: err?.message ?? String(err) });
  }
});

app.post('/api/reveal', async (req, res) => {
  if (boot.phase !== 'ready') return res.status(503).json({ error: 'BOOTING', boot });
  const { bucketKeyHex } = req.body ?? {};
  if (typeof bucketKeyHex !== 'string') return res.status(400).json({ error: 'BAD_INPUT' });
  try {
    const l = await readLedger();
    let count = 0n;
    for (const [k, v] of l.buckets) if (hex(k) === bucketKeyHex) count = v;
    if (count < l.threshold) {
      return res.status(403).json({
        error: 'SEALED',
        message: `Sealed — ${count}/${l.threshold} reporters. It opens when the ${l.threshold}th independent report lands.`,
        count: Number(count),
        threshold: Number(l.threshold),
      });
    }
    const rows = readJson<StoredReport[]>(STORE_FILE, []).filter((r) => r.bucketKeyHex === bucketKeyHex);
    res.json({
      ok: true,
      count: Number(count),
      threshold: Number(l.threshold),
      escrow: { threshold: ESCROW_THRESHOLD, nodes: escrowNodes },
      // no key: the browser fetches Shamir shares from the escrow nodes and combines them
      reports: rows.map((r) => ({ id: r.id, filedAt: r.filedAt, ciphertext: r.ciphertext, iv: r.iv })),
    });
  } catch (err: any) {
    res.status(500).json({ error: 'REVEAL_FAILED', message: err?.message ?? String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`[quorum-api] listening on http://localhost:${PORT}  (threshold ${THRESHOLD}, pool ${IDENTITY_POOL.join('/')})`);
  bootstrap().catch((err) => {
    console.error('[quorum-api] boot failed:', err);
    boot = { phase: 'error', detail: err?.message ?? String(err) };
  });
});
