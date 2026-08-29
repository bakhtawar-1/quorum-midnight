import { useState } from 'react'
import { ApiError, claimSlot, type Identity } from '../lib/api'

type Phase =
  | { k: 'idle' }
  | { k: 'working' }
  | { k: 'done'; key: string; credentialId: string }
  | { k: 'error'; message: string }

export function ClaimSlot({
  identities,
  members,
  onClaimed,
}: {
  identities: Identity[]
  members: { key: string; credentialId: string }[]
  onClaimed: () => void
}) {
  const [picked, setPicked] = useState<string | null>(null)
  const [key, setKey] = useState('')
  const [phase, setPhase] = useState<Phase>({ k: 'idle' })
  const busy = phase.k === 'working'

  const available = identities.filter((i) => !i.used)
  const canClaim = !!picked && !!key.trim() && !busy

  const claim = async () => {
    if (!picked) return
    setPhase({ k: 'working' })
    try {
      const r = await claimSlot({ credentialId: picked, reporterKey: key.trim() })
      setPhase({ k: 'done', key: r.key, credentialId: r.credentialId })
      setPicked(null)
      setKey('')
      onClaimed()
    } catch (err) {
      setPhase({
        k: 'error',
        message: err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err),
      })
    }
  }

  return (
    <div className="card claim">
      <h2>
        <span className="stepno">1</span> Claim a reporter slot{' '}
        <span className="pill">
          {available.length}/{identities.length} free
        </span>
      </h2>
      <p className="lede">
        Each reporter slot is backed by a one-time <strong>identity credential</strong> that an issuer
        registered on chain. Spending one enrols a reporter key; the contract&rsquo;s enroll-nullifier makes
        sure a credential can never be spent twice. <em>This is what stops one person minting many reporters.</em>
      </p>

      <div className="creds">
        {identities.map((i) => {
          const owner = members.find((m) => m.credentialId === i.id)
          return (
            <button
              key={i.id}
              className={`cred ${i.used ? 'used' : ''} ${picked === i.id ? 'picked' : ''}`}
              disabled={i.used || busy}
              onClick={() => setPicked(i.id)}
            >
              <span className="cred-id">{i.id}</span>
              <span className="cred-state">
                {i.used ? (owner ? `→ ${owner.key}` : 'spent') : 'available'}
              </span>
            </button>
          )
        })}
      </div>

      {available.length > 0 && (
        <>
          <label className="claim-key">
            <span>Reporter key to enrol {picked ? <em>with “{picked}”</em> : ''}</span>
            <input
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="a passphrase you'll use to file (e.g. alice-1)"
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
              onKeyDown={(e) => e.key === 'Enter' && canClaim && claim()}
            />
          </label>
          <button className="primary" disabled={!canClaim} onClick={claim}>
            {busy ? 'Enrolling…' : picked ? `Spend “${picked}” → enrol “${key.trim() || '…'}”` : 'Pick a credential above'}
          </button>
        </>
      )}
      {available.length === 0 && identities.length > 0 && (
        <p className="hint">Every credential in the pool is spent. Restart the API with a bigger <code>QUORUM_IDENTITY_POOL</code> for more.</p>
      )}

      {busy && (
        <div className="progress">
          <div className="step on">
            <span className="mark spin">•</span> Proving identity + inserting into the member tree{' '}
            <span className="dim">(~30–45s)</span>
          </div>
        </div>
      )}
      {phase.k === 'done' && (
        <div className="result good">
          <strong>Enrolled “{phase.key}”</strong> against credential “{phase.credentialId}”. Use that key in
          step 2.
        </div>
      )}
      {phase.k === 'error' && (
        <div className="result bad">
          <strong>Couldn’t enrol.</strong> {phase.message}
        </div>
      )}
    </div>
  )
}
