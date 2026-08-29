/**
 * Zero-dependency HTTP hardening helpers, shared by the API and the escrow nodes.
 *
 * Deliberately small: an explicit CORS allow-list, conservative security headers,
 * a fixed-window in-memory rate limiter (single-instance only — swap for a shared
 * store before running more than one replica), an optional bearer-token gate, and
 * an atomic JSON writer so a crash mid-write can't truncate a store file.
 */
import type { RequestHandler } from 'express';
import * as fs from 'node:fs';
import { timingSafeEqual } from 'node:crypto';

/** CORS with an explicit origin allow-list. `['*']` reflects any origin (dev only). */
export function cors(origins: string[]): RequestHandler {
  const allowAny = origins.includes('*');
  const allowed = new Set(origins);
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (allowAny) {
      res.setHeader('Access-Control-Allow-Origin', origin ?? '*');
    } else if (origin && allowed.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type,authorization');
    res.setHeader('Access-Control-Max-Age', '600');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  };
}

/** Conservative response headers. HSTS only when the request arrived over TLS. */
export const securityHeaders: RequestHandler = (req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
};

/** Fixed-window per-IP limiter. In-memory: correct only for a single instance. */
export function rateLimit(opts: { windowMs: number; max: number }): RequestHandler {
  const hits = new Map<string, { n: number; reset: number }>();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, opts.windowMs);
  sweep.unref?.();

  return (req, res, next) => {
    const now = Date.now();
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    let entry = hits.get(ip);
    if (!entry || entry.reset <= now) {
      entry = { n: 0, reset: now + opts.windowMs };
      hits.set(ip, entry);
    }
    entry.n += 1;
    res.setHeader('X-RateLimit-Limit', String(opts.max));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, opts.max - entry.n)));
    if (entry.n > opts.max) {
      res.setHeader('Retry-After', String(Math.ceil((entry.reset - now) / 1000)));
      res.status(429).json({ error: 'RATE_LIMITED', message: 'Too many requests — slow down.' });
      return;
    }
    next();
  };
}

/** Optional bearer-token gate. No-op when `token` is undefined (dev). */
export function requireToken(token: string | undefined): RequestHandler {
  return (req, res, next) => {
    if (!token) {
      next();
      return;
    }
    const header = req.headers.authorization ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
    const a = Buffer.from(presented);
    const b = Buffer.from(token);
    if (a.length === b.length && timingSafeEqual(a, b)) {
      next();
      return;
    }
    res.status(401).json({ error: 'UNAUTHORIZED', message: 'A valid Bearer token is required.' });
  };
}

/** tmp-file + rename, so a partial write can never replace a good store file. */
export function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

/** base64 shape check + decoded-byte-size cap. */
export function isBase64(value: unknown, maxBytes: number): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  return Math.floor((value.length * 3) / 4) <= maxBytes;
}
