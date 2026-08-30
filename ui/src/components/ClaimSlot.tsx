import { useState } from 'react'
import { ApiError, claimSlot, requestCredential, type Identity, type Issuance } from '../lib/api'

type Phase =
  | { k: 'idle' }
  | { k: 'working' }
  | { k: 'done'; key: string; credentialId: string }
  | { k: 'error'; message: string }

export function ClaimSlot({
  identities,
  members,
  issuance,
  onClaimed,
}: {
  identities: Identity[]
  members: { key: string; credentialId: string }[]
  issuance?: Issuance
  onClaimed: () => void
}) {
  const [picked, setPicked] = useState<string | null>(null)
  const [key, setKey] = useState('')
  const [phase, setPhase] = useState<Phase>({ k: 'idle' })
  const busy = phase.k === 'working'

  const available = identities.filter((i) => !i.used)
  const canClaim = !!picked && !!key.trim() && !busy
  const poolShown = identities.length > 0
  const emailShown = issuance?.emailEnabled && (!poolShown || available.length === 0)

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
        {poolShown && (
          <span className="pill">
            {available.length}/{identities.length} free
          </span>
        )}
      </h2>
      <p className="lede">
        Each reporter slot is backed by a one-time <strong>identity credential</strong> that an issuer
        registers on chain. Spending one enrols a reporter key; the contract&rsquo;s enroll-nullifier makes
        sure a credential can never be spent twice. <em>This is what stops one person minting many reporters.</em>
      </p>

      {poolShown && (
        <>
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
                {busy
                  ? 'Enrolling…'
                  : picked
                    ? `Spend “${picked}” → enrol “${key.trim() || '…'}”`
                    : 'Pick a credential above'}
              </button>
            </>
          )}
        </>
      )}

      {emailShown && (
        <EmailRequest sole={!poolShown} allowlistCount={issuance?.allowlistCount ?? 0} />
      )}

      {!poolShown && !emailShown && (
        <p className="hint">
          No credential pool and no email issuance is configured on this server. Set{' '}
          <code>QUORUM_IDENTITY_POOL</code> or <code>QUORUM_ALLOWLIST</code>.
        </p>
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

/** Email-allowlist path: request a claim link. Tells the person plainly when
 *  their address isn't on the issuer's allowlist. */
function EmailRequest({ sole, allowlistCount }: { sole: boolean; allowlistCount: number }) {
  const [email, setEmail] = useState('')
  const [state, setState] = useState<{ k: 'idle' | 'working' | 'sent' | 'denied' | 'error'; msg?: string }>({
    k: 'idle',
  })
  const busy = state.k === 'working'
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())

  const send = async () => {
    if (!valid) return
    setState({ k: 'working' })
    try {
      const r = await requestCredential(email.trim())
      setState({ k: 'sent', msg: r.message })
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'NOT_ALLOWED' || err.code === 'ALREADY_ISSUED')) {
        setState({ k: 'denied', msg: err.message })
        return
      }
      setState({
        k: 'error',
        msg: err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err),
      })
    }
  }

  return (
    <div className="email-req">
      {!sole && <p className="hint">Every pooled credential is spent — request one by email instead:</p>}
      <label className="claim-key">
        <span>Your email {allowlistCount > 0 && <em>({allowlistCount} on the allowlist)</em>}</span>
        <input
          type="email"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value)
            if (state.k === 'denied' || state.k === 'error') setState({ k: 'idle' })
          }}
          placeholder="you@example.org"
          disabled={busy || state.k === 'sent'}
          autoComplete="email"
          spellCheck={false}
          onKeyDown={(e) => e.key === 'Enter' && valid && send()}
        />
      </label>
      <button className="primary" disabled={!valid || busy || state.k === 'sent'} onClick={send}>
        {busy ? 'Sending…' : 'Email me a claim link'}
      </button>
      {state.k === 'sent' && <div className="result good">{state.msg}</div>}
      {state.k === 'denied' && (
        <div className="result warn">
          <strong>Not authorised.</strong> {state.msg}
        </div>
      )}
      {state.k === 'error' && (
        <div className="result bad">
          <strong>Couldn’t send.</strong> {state.msg}
        </div>
      )}
    </div>
  )
}
