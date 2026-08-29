/**
 * Email-allowlist credential issuance — the state behind /api/request-credential
 * and /api/claim-credential.
 *
 * Three local JSON stores (all gitignored, all written atomically):
 *   .allowlist.json  string[]        — emails the issuer has verified as distinct people
 *   .magic.json      MagicRecord[]   — outstanding / spent claim tokens (hashed)
 *   .issued.json     IssuedRecord[]  — which emails already received a credential
 *
 * Privacy note: .issued.json records the email only, never the reporter key or
 * on-chain leaf — the server does not keep an email → reporter link.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { config } from './config';
import { writeJsonAtomic } from './http';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ALLOWLIST_FILE = config.allowlist.file ? path.resolve(config.allowlist.file) : path.join(HERE, '.allowlist.json');
const MAGIC_FILE = path.join(HERE, '.magic.json');
const ISSUED_FILE = path.join(HERE, '.issued.json');

const readJson = <T>(file: string, fallback: T): T => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
};

const sha256hex = (s: string): string => createHash('sha256').update(s).digest('hex');

const eq = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (email.length < 3 || email.length > 254) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

interface MagicRecord {
  tokenHash: string;
  email: string;
  createdAt: string;
  expiresAt: number;
  usedAt: string | null;
}
interface IssuedRecord {
  email: string;
  issuedAt: string;
}

// ── allowlist ────────────────────────────────────────────────────────────────

let allowlist = new Set<string>();

/** Load the allowlist file, merge in QUORUM_ALLOWLIST, and persist the normalized union. */
export function loadAllowlist(): void {
  const fromFile = readJson<string[]>(ALLOWLIST_FILE, []);
  const merged = [...fromFile, ...config.allowlist.seed]
    .map(normalizeEmail)
    .filter((e): e is string => e !== null);
  allowlist = new Set(merged);
  const canonical = [...allowlist].sort();
  try {
    if (JSON.stringify(canonical) !== JSON.stringify(fromFile)) writeJsonAtomic(ALLOWLIST_FILE, canonical);
  } catch {
    /* a read-only allowlist file is fine */
  }
}

export const isAllowed = (email: string): boolean => allowlist.has(email);
export const allowlistCount = (): number => allowlist.size;

// ── issued (one credential per email, ever) ──────────────────────────────────

export const hasCredential = (email: string): boolean =>
  readJson<IssuedRecord[]>(ISSUED_FILE, []).some((r) => r.email === email);

export const issuedCount = (): number => readJson<IssuedRecord[]>(ISSUED_FILE, []).length;

export function recordIssued(email: string): void {
  const rows = readJson<IssuedRecord[]>(ISSUED_FILE, []);
  rows.push({ email, issuedAt: new Date().toISOString() });
  writeJsonAtomic(ISSUED_FILE, rows);
}

// ── magic tokens ─────────────────────────────────────────────────────────────

/** Mint a single-use claim token for `email`, invalidating that email's earlier unused ones. */
export function createMagic(email: string): string {
  const raw = randomBytes(32).toString('base64url');
  const rows = readJson<MagicRecord[]>(MAGIC_FILE, []);
  const kept = rows.filter((r) => !(r.email === email && r.usedAt === null));
  kept.push({
    tokenHash: sha256hex(raw),
    email,
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + config.email.magicTtlMs,
    usedAt: null,
  });
  writeJsonAtomic(MAGIC_FILE, kept);
  return raw;
}

export type ConsumeResult = { ok: true; email: string } | { ok: false; reason: 'INVALID' | 'EXPIRED' | 'USED' };

/** Validate and burn a claim token. */
export function consumeMagic(raw: unknown): ConsumeResult {
  if (typeof raw !== 'string' || raw.length < 20 || raw.length > 200) return { ok: false, reason: 'INVALID' };
  const hash = sha256hex(raw);
  const rows = readJson<MagicRecord[]>(MAGIC_FILE, []);
  const idx = rows.findIndex((r) => eq(r.tokenHash, hash));
  if (idx < 0) return { ok: false, reason: 'INVALID' };
  const rec = rows[idx];
  if (rec.usedAt !== null) return { ok: false, reason: 'USED' };
  if (Date.now() > rec.expiresAt) return { ok: false, reason: 'EXPIRED' };
  rows[idx] = { ...rec, usedAt: new Date().toISOString() };
  writeJsonAtomic(MAGIC_FILE, rows);
  return { ok: true, email: rec.email };
}
