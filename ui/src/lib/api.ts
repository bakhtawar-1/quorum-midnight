import type { Sealed } from './crypto'
import type { Share } from './shamir'

const BASE = import.meta.env.VITE_QUORUM_API ?? 'http://localhost:8787'

export interface EscrowNode {
  index: number
  url: string
}
export interface Escrow {
  threshold: number
  count?: number
  nodes: EscrowNode[]
}

export interface Health {
  ready: boolean
  contractAddress: string
  threshold: number
  memberCount: number
  identityCount: number
  escrow: Escrow
  boot: { phase: string; detail?: string }
}

export interface Identity {
  id: string
  used: boolean
}

export interface BucketReport {
  id: string
  filedAt: string
  sealed: boolean
}

export interface Bucket {
  bucketKeyHex: string
  accusedLabel: string
  count: number
  threshold: number
  unlocked: boolean
  reports: BucketReport[]
}

export interface State {
  contractAddress: string
  threshold: number
  nullifierCount: number
  bucketCount: number
  memberCount: number
  identityCount: number
  identitiesUsed: number
  identities: Identity[]
  members: { key: string; credentialId: string; enrolledAt: string }[]
  escrow: Escrow
  buckets: Bucket[]
}

export interface FileResult {
  ok: true
  reportId: string
  bucketKeyHex: string
  count: number
  threshold: number
  unlocked: boolean
  txId: string | null
  blockHeight: number | null
}

export class ApiError extends Error {
  code: string
  status: number
  constructor(status: number, code: string, message: string) {
    super(message)
    this.code = code
    this.status = status
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    })
  } catch {
    throw new ApiError(0, 'OFFLINE', `Can't reach the Quorum API at ${BASE}. Is \`npm run quorum:api\` running?`)
  }
  const text = await res.text()
  const body = text ? JSON.parse(text) : {}
  if (!res.ok) throw new ApiError(res.status, body.error ?? 'ERROR', body.message ?? res.statusText)
  return body as T
}

export const getHealth = () => req<Health>('/api/health')
export const getState = () => req<State>('/api/state')

export const fileReport = (input: {
  accusedLabel: string
  reporterSecret: string
  sealed: Pick<Sealed, 'ciphertext' | 'iv'>
}) =>
  req<FileResult>('/api/report', {
    method: 'POST',
    body: JSON.stringify({
      accusedLabel: input.accusedLabel,
      reporterSecret: input.reporterSecret,
      ciphertext: input.sealed.ciphertext,
      iv: input.sealed.iv,
    }),
  })

/** fan the k Shamir shares out to the k escrow nodes (browser -> node directly) */
export async function distributeShares(
  nodes: EscrowNode[],
  input: { bucketKeyHex: string; reportId: string; shares: Share[] },
): Promise<{ index: number; ok: boolean }[]> {
  return Promise.all(
    nodes.map(async (n, i) => {
      try {
        const res = await fetch(`${n.url}/store`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            bucketKeyHex: input.bucketKeyHex,
            reportId: input.reportId,
            share: JSON.stringify(input.shares[i]),
          }),
        })
        return { index: n.index, ok: res.ok }
      } catch {
        return { index: n.index, ok: false }
      }
    }),
  )
}

/** collect shares for one report from the escrow nodes (each gates on its own chain check) */
export async function collectShares(
  nodes: EscrowNode[],
  input: { bucketKeyHex: string; reportId: string },
): Promise<{ got: Share[]; nodeStatus: { index: number; state: 'released' | 'sealed' | 'error' }[] }> {
  const results = await Promise.all(
    nodes.map(async (n) => {
      try {
        const url = `${n.url}/share?bucketKeyHex=${encodeURIComponent(input.bucketKeyHex)}&reportId=${encodeURIComponent(input.reportId)}`
        const res = await fetch(url)
        if (res.ok) {
          const b = await res.json()
          return { index: n.index, state: 'released' as const, share: JSON.parse(b.share) as Share }
        }
        return { index: n.index, state: res.status === 403 ? ('sealed' as const) : ('error' as const) }
      } catch {
        return { index: n.index, state: 'error' as const }
      }
    }),
  )
  return {
    got: results.filter((r) => r.state === 'released').map((r) => (r as any).share as Share),
    nodeStatus: results.map((r) => ({ index: r.index, state: r.state })),
  }
}

export const claimSlot = (input: { credentialId: string; reporterKey: string }) =>
  req<{ ok: true; key: string; credentialId: string; memberCount: number }>('/api/enroll', {
    method: 'POST',
    body: JSON.stringify(input),
  })

export const reveal = (bucketKeyHex: string) =>
  req<{
    ok: true
    count: number
    threshold: number
    escrow: Escrow
    reports: { id: string; filedAt: string; ciphertext: string; iv: string }[]
  }>('/api/reveal', { method: 'POST', body: JSON.stringify({ bucketKeyHex }) })
