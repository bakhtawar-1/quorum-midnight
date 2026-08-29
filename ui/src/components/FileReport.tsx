import { useEffect, useState } from 'react'
import { ApiError, distributeShares, fileReport, type Escrow } from '../lib/api'
import { sealReport, sha256Hex } from '../lib/crypto'
import { b64decode, split } from '../lib/shamir'

type Phase =
  | { k: 'idle' }
  | { k: 'sealing' }
  | { k: 'working' }
  | { k: 'sharing' }
  | {
      k: 'done'
      count: number
      threshold: number
      unlocked: boolean
      block: number | null
      stored: number
      nodes: number
    }
  | { k: 'duplicate' }
  | { k: 'error'; message: string }

const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`

export function FileReport({
  threshold,
  members,
  escrow,
  onChange,
}: {
  threshold: number
  members: { key: string }[]
  escrow: Escrow
  onChange: () => void
}) {
  const [accused, setAccused] = useState('')
  const [secret, setSecret] = useState('')
  const [title, setTitle] = useState('')
  const [details, setDetails] = useState('')
  const [phase, setPhase] = useState<Phase>({ k: 'idle' })
  const [accusedHash, setAccusedHash] = useState('')

  useEffect(() => {
    const name = accused.trim().toLowerCase().replace(/\s+/g, ' ')
    if (!name) {
      setAccusedHash('')
      return
    }
    let live = true
    sha256Hex(name).then((h) => live && setAccusedHash(h))
    return () => {
      live = false
    }
  }, [accused])

  const keyTrim = secret.trim()
  const enrolled = members.some((m) => m.key === keyTrim)
  const busy = phase.k === 'sealing' || phase.k === 'working' || phase.k === 'sharing'
  const name = accused.trim() || 'the person'
  const detailsReady = !!(accused.trim() && title.trim() && details.trim())

  const submit = async () => {
    try {
      setPhase({ k: 'sealing' })
      const sealed = await sealReport({ title: title.trim(), details: details.trim() })
      setPhase({ k: 'working' })
      const result = await fileReport({ accusedLabel: accused.trim(), reporterSecret: secret, sealed })

      // fan the AES key out as Shamir shares — one per escrow node. This browser
      // and the escrow nodes are the only parties that ever touch key material.
      setPhase({ k: 'sharing' })
      const shares = split(b64decode(sealed.key), escrow.threshold, escrow.nodes.length)
      const acks = await distributeShares(escrow.nodes, {
        bucketKeyHex: result.bucketKeyHex,
        reportId: result.reportId,
        shares,
      })
      const stored = acks.filter((a) => a.ok).length

      setPhase({
        k: 'done',
        count: result.count,
        threshold: result.threshold,
        unlocked: result.unlocked,
        block: result.blockHeight,
        stored,
        nodes: escrow.nodes.length,
      })
      setTitle('')
      setDetails('')
      onChange()
    } catch (err) {
      if (err instanceof ApiError && err.code === 'DUPLICATE') {
        setPhase({ k: 'duplicate' })
        return
      }
      if (err instanceof ApiError && err.code === 'NOT_ENROLLED') {
        // state was stale — reflect it and let them enroll
        onChange()
        setPhase({ k: 'idle' })
        return
      }
      setPhase({ k: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  const reset = () => setPhase({ k: 'idle' })

  return (
    <div className="card file">
      <h2>
        <span className="stepno">2</span> File a report
      </h2>
      <p className="lede">
        Your report is sealed in this browser, then submitted as a zero-knowledge transaction. It stays
        unreadable until <strong>{threshold}</strong> enrolled reporters independently name the same person.
      </p>

      <label>
        <span>Who are you reporting?</span>
        <input
          value={accused}
          onChange={(e) => setAccused(e.target.value)}
          placeholder="name, handle, or internal ID"
          disabled={busy}
          autoComplete="off"
          spellCheck={false}
        />
      </label>

      <label>
        <span>Report title</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="one line" disabled={busy} />
      </label>

      <label>
        <span>What happened</span>
        <textarea
          value={details}
          onChange={(e) => setDetails(e.target.value)}
          placeholder="dates, specifics, witnesses… this text is encrypted before it leaves the page"
          rows={5}
          disabled={busy}
        />
      </label>

      <label>
        <span>
          Your private reporter key <em>— never transmitted. Use the same key each time.</em>
        </span>
        <input
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder="a passphrase only you know"
          disabled={busy}
          autoComplete="off"
        />
        {keyTrim && (
          <span className={`keystat ${enrolled ? 'ok' : 'warn'}`}>
            {enrolled ? '✓ this key is enrolled' : 'not enrolled — claim a reporter slot for it in step 1'}
          </span>
        )}
      </label>

      <div className="onchain">
        <div className="onchain-h">What actually leaves your device</div>
        <ul>
          <li>
            <span className="k">membership</span>
            <span className="v">
              a ZK proof that your key is in the enrolled-reporter tree{' '}
              <span className="dim">— without revealing which key</span>
            </span>
          </li>
          <li>
            <span className="k">bucket key</span>
            <span className="v">
              hash( hash(<em>{name}</em>) , org&nbsp;salt ) <span className="dim">— computed inside the circuit</span>
            </span>
          </li>
          <li>
            <span className="k">nullifier</span>
            <span className="v">
              hash( your key , <em>{name}</em> ){' '}
              <span className="dim">— refile with the same key → same value → rejected</span>
            </span>
          </li>
          <li>
            <span className="k">counter</span>
            <span className="v">+1 on that bucket</span>
          </li>
        </ul>
        <div className="onchain-f">
          The name exists only as a hash —{' '}
          <span className="mono">SHA-256("{name}") = {accusedHash ? short(accusedHash) : '—'}</span>. The report
          body is <strong>AES-GCM encrypted here</strong>, then its key is <strong>Shamir-split</strong> across{' '}
          {escrow.nodes.length} escrow nodes ({escrow.threshold}-of-{escrow.nodes.length}) — no single party,
          this server included, can decrypt before quorum.
        </div>
      </div>

      {phase.k === 'idle' && (
        <button className="primary" disabled={!(detailsReady && enrolled) || busy} onClick={submit}>
          {!keyTrim
            ? 'Enter your reporter key'
            : enrolled
              ? 'Seal & file report'
              : `“${keyTrim}” isn’t enrolled — claim a slot in step 1`}
        </button>
      )}

      {busy && (
        <div className="progress">
          <div className={`step ${phase.k === 'sealing' ? 'on' : 'done'}`}>
            <span className="mark">{phase.k === 'sealing' ? '•' : '✓'}</span> Encrypt report body
          </div>
          <div
            className={`step ${phase.k === 'working' ? 'on' : phase.k === 'sharing' ? 'done' : ''}`}
          >
            <span className="mark spin">•</span> Prove membership + submitReport{' '}
            <span className="dim">(~30–60s — the slow part)</span>
          </div>
          <div className={`step ${phase.k === 'sharing' ? 'on' : ''}`}>
            <span className="mark spin">•</span> Split key → {escrow.nodes.length} escrow nodes
          </div>
        </div>
      )}

      {phase.k === 'done' && (
        <div className={`result ${phase.unlocked ? 'good' : 'ok'}`}>
          <strong>Filed.</strong> Bucket now at <b>{phase.count}/{phase.threshold}</b>
          {phase.unlocked ? ' — quorum reached, this bucket is UNLOCKED.' : ' — still sealed.'}
          {phase.block != null && <span className="dim"> · block {phase.block}</span>}
          <div className="dim" style={{ marginTop: 4 }}>
            key shares stored on {phase.stored}/{phase.nodes} escrow nodes
          </div>
          <button className="link" onClick={reset}>
            file another
          </button>
        </div>
      )}

      {phase.k === 'duplicate' && (
        <div className="result warn">
          <strong>Already reported.</strong> That reporter key has already filed against this person — one
          reporter, one report per person. This is the nullifier doing its job.
          <button className="link" onClick={reset}>
            ok
          </button>
        </div>
      )}

      {phase.k === 'error' && (
        <div className="result bad">
          <strong>Something went wrong.</strong> {phase.message}
          <button className="link" onClick={reset}>
            try again
          </button>
        </div>
      )}
    </div>
  )
}
