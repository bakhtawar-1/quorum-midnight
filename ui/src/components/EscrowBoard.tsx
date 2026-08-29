import { useState } from 'react'
import type { Bucket, Escrow } from '../lib/api'
import { collectShares, reveal } from '../lib/api'
import { openReport, type ReportBody } from '../lib/crypto'
import { b64encode, combine } from '../lib/shamir'

export function EscrowBoard({
  buckets,
  threshold,
  escrow,
}: {
  buckets: Bucket[]
  threshold: number
  escrow: Escrow
}) {
  if (buckets.length === 0) {
    return (
      <div className="card board empty">
        <h2>Escrow board</h2>
        <p className="lede">No reports yet. Filed reports appear here as sealed buckets, one per person named.</p>
        <p className="hint">
          To see a bucket unlock: file against the same person with <strong>{threshold} different</strong> enrolled
          reporter keys.
        </p>
        <p className="hint">
          Each report body is Shamir-split across <strong>{escrow.nodes.length}</strong> escrow nodes (
          {escrow.threshold}-of-{escrow.nodes.length}); a node releases its share only after its own on-chain
          quorum check.
        </p>
      </div>
    )
  }
  return (
    <div className="card board">
      <h2>Escrow board</h2>
      <ul className="buckets">
        {buckets.map((b) => (
          <BucketRow key={b.bucketKeyHex} b={b} escrow={escrow} />
        ))}
      </ul>
    </div>
  )
}

type NodeState = { index: number; state: 'released' | 'sealed' | 'error' }

function BucketRow({ b, escrow }: { b: Bucket; escrow: Escrow }) {
  const [open, setOpen] = useState(false)
  const [bodies, setBodies] = useState<{ id: string; filedAt: string; body: ReportBody }[] | null>(null)
  const [nodeStates, setNodeStates] = useState<NodeState[]>([])
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)

  const pct = Math.min(100, (b.count / b.threshold) * 100)

  const doReveal = async () => {
    setLoading(true)
    setErr('')
    try {
      const r = await reveal(b.bucketKeyHex)
      const nodes = r.escrow?.nodes ?? escrow.nodes
      const t = r.escrow?.threshold ?? escrow.threshold
      const out: { id: string; filedAt: string; body: ReportBody }[] = []
      let lastStatus: NodeState[] = []
      for (const rep of r.reports) {
        const { got, nodeStatus } = await collectShares(nodes, { bucketKeyHex: b.bucketKeyHex, reportId: rep.id })
        lastStatus = nodeStatus
        if (got.length < t) {
          throw new Error(`only ${got.length}/${t} escrow shares released — cannot reconstruct`)
        }
        const keyBytes = combine(got.slice(0, t))
        const body = await openReport({ ciphertext: rep.ciphertext, iv: rep.iv, key: b64encode(keyBytes) })
        out.push({ id: rep.id, filedAt: rep.filedAt, body })
      }
      setNodeStates(lastStatus)
      setBodies(out)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <li className={`bucket ${b.unlocked ? 'unlocked' : 'sealed'}`}>
      <button className="bucket-head" onClick={() => setOpen((v) => !v)}>
        <span className="chev" aria-hidden>
          {open ? '▾' : '▸'}
        </span>
        <span className="who">{b.accusedLabel}</span>
        <span className="count">
          {b.count}
          <span className="of">/{b.threshold}</span>
        </span>
        <span className={`badge ${b.unlocked ? 'good' : ''}`}>{b.unlocked ? 'UNLOCKED' : 'SEALED'}</span>
      </button>

      <div className="meter" aria-hidden>
        <div className="fill" style={{ width: `${pct}%` }} />
      </div>

      {open && (
        <div className="bucket-body">
          <div className="reports">
            {b.reports.map((r, i) => (
              <div className="report-row" key={r.id}>
                <span className="idx">#{i + 1}</span>
                <span className="when">{new Date(r.filedAt).toLocaleString()}</span>
                <span className="state">{r.sealed ? '🔒 sealed' : '🔓 open'}</span>
              </div>
            ))}
          </div>

          {!b.unlocked && (
            <p className="hint">
              Opens when the {b.threshold}
              <span className="sup">th</span> independent report lands. Until then every escrow node refuses to
              release its share.
            </p>
          )}

          {b.unlocked && !bodies && (
            <button className="primary sm" onClick={doReveal} disabled={loading}>
              {loading ? 'Collecting shares…' : `Collect ${escrow.threshold}/${escrow.nodes.length} shares & decrypt`}
            </button>
          )}

          {nodeStates.length > 0 && (
            <div className="nodes">
              {nodeStates.map((n) => (
                <span key={n.index} className={`node ${n.state}`}>
                  node {n.index}: {n.state === 'released' ? 'share released' : n.state === 'sealed' ? 'withheld' : 'error'}
                </span>
              ))}
            </div>
          )}

          {err && <p className="err">{err}</p>}

          {bodies && (
            <div className="revealed">
              {bodies.map((x, i) => (
                <article key={x.id} className="revealed-report">
                  <header>
                    <b>
                      #{i + 1} · {x.body.title}
                    </b>
                    <span className="when">{new Date(x.filedAt).toLocaleString()}</span>
                  </header>
                  <p>{x.body.details}</p>
                </article>
              ))}
            </div>
          )}
        </div>
      )}
    </li>
  )
}
