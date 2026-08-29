/**
 * Central configuration for the Quorum demo services.
 *
 * One rule: **fail closed in production.** When `NODE_ENV=production`, every
 * secret / origin allow-list must come from the environment — the `quorum-demo-*`
 * fallbacks below are only reachable in development. A missing required value
 * throws here, at import time, before the server binds a port.
 *
 * See `.env.example` for the full list.
 */

export const isProd = process.env.NODE_ENV === 'production';

class ConfigError extends Error {}

function required(name: string, devDefault?: string): string {
  const v = process.env[name]?.trim();
  if (v) return v;
  if (isProd) {
    throw new ConfigError(
      `${name} is required when NODE_ENV=production. See .env.example — ` +
        `refusing to start with an insecure built-in default.`,
    );
  }
  return devDefault ?? '';
}

function optional(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new ConfigError(`${name} must be a number, got ${JSON.stringify(raw)}`);
  return n;
}

function listEnv(name: string, fallback: string[]): string[] {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function corsOrigins(): string[] {
  const raw = process.env.QUORUM_CORS_ORIGIN?.trim();
  if (!raw) {
    if (isProd) {
      throw new ConfigError(
        'QUORUM_CORS_ORIGIN is required when NODE_ENV=production ' +
          '(comma-separated list of allowed browser origins).',
      );
    }
    return ['*'];
  }
  const origins = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (isProd && origins.includes('*')) {
    throw new ConfigError('QUORUM_CORS_ORIGIN="*" is not allowed when NODE_ENV=production.');
  }
  return origins;
}

export const config = {
  isProd,

  api: {
    port: numberEnv('QUORUM_API_PORT', 8787),
    threshold: BigInt(process.env.QUORUM_THRESHOLD?.trim() || '2'),

    /** issuer credential secret — deploy arg drives `issuerCommitment` on chain */
    issuerSecret: required('QUORUM_ISSUER_SECRET', 'quorum-demo-issuer-secret'),
    /** LevelDB private-state encryption password */
    privateStatePassword: required('QUORUM_PRIVATE_STATE_PASSWORD', 'Local-Devnet-Development-Placeholder-1'),
    /** seeded identity-credential pool (demo issuer registers these on boot) */
    identityPool: listEnv('QUORUM_IDENTITY_POOL', ['citizen-1', 'citizen-2', 'citizen-3']),

    /**
     * Optional bearer token gating the mutating endpoints. Unset in dev → routes
     * are open. Required in production.
     */
    apiToken: isProd ? required('QUORUM_API_TOKEN') : optional('QUORUM_API_TOKEN'),
  },

  cors: {
    origins: corsOrigins(),
  },

  rateLimit: {
    windowMs: numberEnv('QUORUM_RATELIMIT_WINDOW_MS', 60_000),
    max: numberEnv('QUORUM_RATELIMIT_MAX', 20),
  },

  escrow: {
    count: numberEnv('QUORUM_ESCROW_COUNT', 3),
    threshold: numberEnv('QUORUM_ESCROW_THRESHOLD', 2),
    basePort: numberEnv('QUORUM_ESCROW_BASE_PORT', 8801),
    spawn: process.env.QUORUM_SPAWN_ESCROW !== '0',
  },
} as const;

if (!isProd) {
  // one-line reminder that demo defaults are in play
  const usingDefaults = [
    !process.env.QUORUM_ISSUER_SECRET && 'QUORUM_ISSUER_SECRET',
    !process.env.QUORUM_API_TOKEN && 'QUORUM_API_TOKEN(open)',
    !process.env.QUORUM_CORS_ORIGIN && 'QUORUM_CORS_ORIGIN(*)',
  ].filter(Boolean);
  if (usingDefaults.length) {
    console.warn(`[quorum-config] dev mode — insecure defaults: ${usingDefaults.join(', ')}. Set NODE_ENV=production to enforce.`);
  }
}
