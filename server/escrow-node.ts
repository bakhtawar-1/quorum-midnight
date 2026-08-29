/**
 * Quorum escrow node.
 *
 * One of k independent holders of a Shamir share of each report's AES key.
 * It never sees a full key. It releases its share for a bucket ONLY after it
 * has independently confirmed, against the chain, that the bucket's on-chain
 * report count has reached the threshold.
 *
 * Run k of these (different ESCROW_INDEX / ESCROW_PORT). The browser splits
 * each key k ways and posts one share to each node directly — the main API
 * never touches the shares.
 *
 *   POST /store   { bucketKeyHex, reportId, share }   -> stash a share
 *   GET  /share?bucketKeyHex=&reportId=               -> share, or 403 SEALED
 *   GET  /health
 */
import express from 'express';
import cors from 'cors';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';

import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { resolveNetwork } from '../src/network';

// @ts-expect-error the indexer client wants a global WebSocket
globalThis.WebSocket = WebSocket;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX = Number(process.env.ESCROW_INDEX ?? 1);
const PORT = Number(process.env.ESCROW_PORT ?? 8800 + INDEX);
const STORE_FILE = path.join(HERE, `.escrow-${INDEX}.json`);
const DEPLOY_FILE = path.join(HERE, '.deployment.json');
const ZK_DIR = path.resolve(HERE, '..', 'contracts', 'managed', 'quorum');

const { config: networkConfig } = resolveNetwork();
const publicDataProvider = indexerPublicDataProvider(networkConfig.indexer, networkConfig.indexerWS);

const Quorum: any = await import(pathToFileURL(path.join(ZK_DIR, 'contract', 'index.js')).href);

type Store = Record<string, string>; // `${bucketKeyHex}:${reportId}` -> share
const load = (): Store => {
  try {
    return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')) as Store;
  } catch {
    return {};
  }
};
const save = (s: Store) => fs.writeFileSync(STORE_FILE, JSON.stringify(s, null, 2));

function contractAddress(): string | null {
  try {
    return JSON.parse(fs.readFileSync(DEPLOY_FILE, 'utf8')).address ?? null;
  } catch {
    return null;
  }
}

/** the node's OWN check: is this bucket at/over threshold on chain? */
async function bucketUnlocked(bucketKeyHex: string): Promise<{ unlocked: boolean; count: number; threshold: number }> {
  const addr = contractAddress();
  if (!addr) throw new Error('no deployment on file');
  const st = await publicDataProvider.queryContractState(addr);
  if (!st) throw new Error('queryContractState returned null');
  const ledger = Quorum.ledger(st.data) as any;
  const threshold = Number(ledger.threshold);
  let count = 0;
  for (const [k, v] of ledger.buckets) {
    if (Buffer.from(k).toString('hex') === bucketKeyHex) count = Number(v);
  }
  return { unlocked: count >= threshold, count, threshold };
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '64kb' }));

app.get('/health', (_req, res) => res.json({ ok: true, index: INDEX, port: PORT, held: Object.keys(load()).length }));

app.post('/store', (req, res) => {
  const { bucketKeyHex, reportId, share } = req.body ?? {};
  if (typeof bucketKeyHex !== 'string' || typeof reportId !== 'string' || typeof share !== 'string') {
    return res.status(400).json({ error: 'BAD_INPUT' });
  }
  const s = load();
  s[`${bucketKeyHex}:${reportId}`] = share;
  save(s);
  res.json({ ok: true, index: INDEX });
});

app.get('/share', async (req, res) => {
  const bucketKeyHex = String(req.query.bucketKeyHex ?? '');
  const reportId = String(req.query.reportId ?? '');
  const key = `${bucketKeyHex}:${reportId}`;
  const share = load()[key];
  if (!share) return res.status(404).json({ error: 'NO_SHARE', index: INDEX });
  try {
    const g = await bucketUnlocked(bucketKeyHex);
    if (!g.unlocked) {
      return res.status(403).json({
        error: 'SEALED',
        index: INDEX,
        message: `node ${INDEX}: bucket is ${g.count}/${g.threshold} — share withheld until quorum`,
        count: g.count,
        threshold: g.threshold,
      });
    }
    res.json({ ok: true, index: INDEX, share });
  } catch (err: any) {
    res.status(500).json({ error: 'CHECK_FAILED', index: INDEX, message: err?.message ?? String(err) });
  }
});

app.listen(PORT, () => console.log(`[escrow-node ${INDEX}] listening on http://localhost:${PORT}`));
