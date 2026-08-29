import { useState } from 'react'
import { ApiError, claimCredential } from '../lib/api'

type Phase =
  | { k: 'idle' }
  | { k: 'working' }
  | { k: 'done'; key: string }
  | { k: 'error'; message: string }

/**
 * Landing view for a credential claim link (`/claim?token=…`). The email was
 * already verified by holding the link; here the person picks a reporter key and
 * the server mints + spends a one-time credential in a single step.
 */
export function ClaimCredential({ token, onClaimed }: { token: string; onClaimed: () => void }) {
  const [key, setKey] = useState('')
  const [phase, setPhase] = useState<Phase>({ k: 'idle' })
  const busy = phase.k === 'working'
  const canClaim = !!key.trim() && !busy

  const claim = async () => {
    if (!key.trim()) return
    setPhase({ k: 'working' })
    try {
      const r = await claimCredential(token, key.trim())
      setPhase({ k: 'done', key: r.key })
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
        <span className="stepno">✓</span> Claim your reporter credential
      </h2>
      <p className="lede">
        Your email was verified. Choose a <strong>reporter key</strong> — a passphrase you&rsquo;ll use to file.
        The server mints a one-time identity credential for you and spends it to enrol this key, on chain, in
        zero knowledge. The credential is never reused; your email is never linked to the key.
      </p>

      {phase.k !== 'done' && (
        <>
          <label className="claim-key">
            <span>Reporter key to enrol</span>
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
            {busy ? 'Claiming…' : key.trim() ? `Enrol “${key.trim()}”` : 'Enter a reporter key'}
          </button>
        </>
      )}

      {busy && (
        <div className="progress">
          <div className="step on">
            <span className="mark spin">•</span> Registering credential + inserting into the member tree{' '}
            <span className="dim">(~60–90s — two proofs)</span>
          </div>
        </div>
      )}
      {phase.k === 'done' && (
        <div className="result good">
          <strong>Enrolled “{phase.key}”.</strong> That key is now a reporter. Use it in step 2 to file. This
          claim link is spent — keep the passphrase safe.
        </div>
      )}
      {phase.k === 'error' && (
        <div className="result bad">
          <strong>Couldn&rsquo;t claim.</strong> {phase.message}
        </div>
      )}
    </div>
  )
}
