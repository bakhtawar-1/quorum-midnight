import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'
import { FileReport } from './components/FileReport'
import { EscrowBoard } from './components/EscrowBoard'
import { ClaimSlot } from './components/ClaimSlot'
import { getHealth, getState, type Health, type State } from './lib/api'

const BOOT_LABEL: Record<string, string> = {
  starting: 'starting API…',
  'syncing-wallet': 'syncing devnet wallet…',
  'funding-dust': 'preparing transaction fees (DUST)…',
  deploying: 'deploying the Quorum contract…',
  'registering-identities': 'issuer registering identity credentials…',
  ready: 'ready',
  error: 'boot error',
}

export default function App() {
  const [health, setHealth] = useState<Health | null>(null)
  const [state, setState] = useState<State | null>(null)
  const [stateErr, setStateErr] = useState('')
  const pollRef = useRef<number | null>(null)

  // health: poll until ready
  useEffect(() => {
    let live = true
    const tick = async () => {
      try {
        const h = await getHealth()
        if (!live) return
        setHealth(h)
        if (!h.ready) setTimeout(tick, 1500)
      } catch {
        if (!live) return
        setHealth(null)
        setTimeout(tick, 2000)
      }
    }
    tick()
    return () => {
      live = false
    }
  }, [])

  const refresh = useCallback(async () => {
    try {
      setState(await getState())
      setStateErr('')
    } catch (e) {
      setStateErr(e instanceof Error ? e.message : String(e))
    }
  }, [])

  // state: poll while ready
  useEffect(() => {
    if (!health?.ready) return
    refresh()
    pollRef.current = window.setInterval(refresh, 4000)
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current)
    }
  }, [health?.ready, refresh])

  const ready = !!health?.ready
  const threshold = state?.threshold ?? health?.threshold ?? 2
  const memberCount = state?.memberCount ?? health?.memberCount ?? 0
  const escrow = state?.escrow ??
    health?.escrow ?? {
      threshold: 2,
      count: 3,
      nodes: [1, 2, 3].map((i) => ({ index: i, url: `http://localhost:${8800 + i}` })),
    }

  return (
    <div className="app">
      <header className="masthead">
        <div className="brand">
          <h1>Quorum</h1>
          <span className="tag">allegation escrow</span>
        </div>
        <p className="pitch">
          A report stays cryptographically unreadable until <strong>{threshold} independent reporters</strong> name
          the same person — then every corroborating report opens at once. Nobody has to be the one who goes first
          alone.
        </p>
      </header>

      <div className="statusbar">
        {!health && <Dot tone="warn" label={`connecting to API…`} />}
        {health && !ready && (
          <Dot tone="warn" label={BOOT_LABEL[health.boot.phase] ?? health.boot.phase} />
        )}
        {ready && <Dot tone="good" label="devnet connected" />}
        {ready && (
          <>
            <Meta k="contract" v={`${health!.contractAddress.slice(0, 10)}…${health!.contractAddress.slice(-6)}`} />
            <Meta k="threshold" v={String(threshold)} />
            {state && <Meta k="identity slots" v={`${state.identitiesUsed}/${state.identityCount} used`} />}
            <Meta k="enrolled reporters" v={String(memberCount)} />
            <Meta k="escrow" v={`${escrow.threshold}-of-${escrow.nodes.length} nodes`} />
            {state && <Meta k="nullifiers spent" v={String(state.nullifierCount)} />}
            {state && <Meta k="people named" v={String(state.bucketCount)} />}
          </>
        )}
        {health?.boot.phase === 'error' && (
          <span className="boot-err">API boot failed: {health.boot.detail}</span>
        )}
      </div>

      {!ready ? (
        <div className="card gate">
          <div className="spinner" />
          <div>
            <strong>Bringing up the local devnet stack.</strong>
            <p>
              {health
                ? BOOT_LABEL[health.boot.phase] ?? health.boot.phase
                : `Waiting for the Quorum API on :8787. Start it with `}
              {!health && <code>npm run quorum:api</code>}
            </p>
            <p className="hint">
              First run deploys the contract, funds fees, and has the issuer register the identity
              pool — 2–3 min. Later runs rejoin instantly.
            </p>
          </div>
        </div>
      ) : (
        <main className="grid">
          <div className="left">
            <ClaimSlot
              identities={state?.identities ?? []}
              members={state?.members ?? []}
              onClaimed={refresh}
            />
            <FileReport
              threshold={threshold}
              members={state?.members ?? []}
              escrow={escrow}
              onChange={refresh}
            />
          </div>
          <div className="right">
            {stateErr && <div className="card err-card">Couldn’t read chain state: {stateErr}</div>}
            <EscrowBoard buckets={state?.buckets ?? []} threshold={threshold} escrow={escrow} />
          </div>
        </main>
      )}

      <footer className="foot">
        <p>
          <strong>The trust model.</strong> Three ZK-enforced layers on chain: a report key files{' '}
          <em>once per person</em> (nullifier); only <em>enrolled</em> keys file at all (membership proof, which
          key stays hidden); and a key is only enrolled by spending a <em>one-time identity credential</em>
          (identity proof + enroll-nullifier) — so one issued identity → one key → one report per person. The
          report body is AES-GCM encrypted in your browser and its key is <em>Shamir-split</em> across{' '}
          {escrow.nodes.length} escrow nodes ({escrow.threshold}-of-{escrow.nodes.length}); each node releases
          its share only after its own on-chain quorum check, so no single party — this server included — can
          open a report early. What still requires trust: the <strong>issuer</strong> registering one credential
          per real human, and fewer than {escrow.threshold} of the {escrow.nodes.length} escrow nodes colluding.
        </p>
        <p className="hint">
          Prefer the terminal? <code>npm run quorum:e2e</code> runs the whole security property — including the
          Sybil attack failing — as a scripted walkthrough.
        </p>
      </footer>
    </div>
  )
}

function Dot({ tone, label }: { tone: 'good' | 'warn' | 'bad'; label: string }) {
  return (
    <span className={`sdot ${tone}`}>
      <i />
      {label}
    </span>
  )
}

function Meta({ k, v }: { k: string; v: string }) {
  return (
    <span className="smeta">
      <span className="sk">{k}</span>
      <span className="sv mono">{v}</span>
    </span>
  )
}
