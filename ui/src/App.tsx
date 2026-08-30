import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'
import { FileReport } from './components/FileReport'
import { EscrowBoard } from './components/EscrowBoard'
import { ClaimSlot } from './components/ClaimSlot'
import { ClaimCredential } from './components/ClaimCredential'
import { getHealth, getState, type Health, type State } from './lib/api'

const CLAIM_TOKEN =
  typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('claim') : null

function clearClaimParam() {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  url.searchParams.delete('claim')
  window.history.replaceState({}, '', url.pathname + url.search)
}

const BOOT_LABEL: Record<string, string> = {
  starting: 'starting API…',
  'syncing-wallet': 'syncing devnet wallet…',
  'funding-dust': 'preparing transaction fees (DUST)…',
  deploying: 'deploying the Quorum contract…',
  'registering-identities': 'issuer registering identity credentials…',
  ready: 'ready',
  error: 'boot error',
}

type Theme = 'light' | 'dark'

function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem('quorum-theme')
    if (saved === 'light' || saved === 'dark') return saved
  } catch {
    /* storage blocked — fall through */
  }
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: light)').matches) {
    return 'light'
  }
  return 'dark'
}

export default function App() {
  const [health, setHealth] = useState<Health | null>(null)
  const [state, setState] = useState<State | null>(null)
  const [stateErr, setStateErr] = useState('')
  const [howOpen, setHowOpen] = useState(false)
  const pollRef = useRef<number | null>(null)

  const [theme, setTheme] = useState<Theme>(initialTheme)
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    try {
      localStorage.setItem('quorum-theme', theme)
    } catch {
      /* storage blocked — the attribute still applies for this session */
    }
  }, [theme])

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
  const caseCount = state?.bucketCount ?? 0
  const buckets = state?.buckets ?? []
  const maxProgress = Math.min(threshold, Math.max(0, 0, ...buckets.map((b) => b.count)))
  const anyUnlocked = buckets.some((b) => b.unlocked)
  const escrow = state?.escrow ??
    health?.escrow ?? {
      threshold: 2,
      count: 3,
      nodes: [1, 2, 3].map((i) => ({ index: i, url: `http://localhost:${8800 + i}` })),
    }

  const openHow = () => {
    setHowOpen(true)
    setTimeout(() => document.getElementById('how')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 40)
  }

  return (
    <div className="app" id="top">
      <div className="topbar">
        <a className="logo" href="#top" aria-label="Quorum — home">
          <Logo />
          <span className="logo-word">Quorum</span>
        </a>
        <ThemeToggle theme={theme} onToggle={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))} />
      </div>

      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">Anonymous · corroborated · on-chain</p>
          <h1 className="hero-title">Report what you can’t report alone.</h1>
          <p className="hero-sub">
            A report stays sealed until <strong>{threshold} independent people</strong> name the same person.
            Then every corroborating account opens at once — and no one had to go first.
          </p>
          <div className="hero-actions">
            <a className="btn btn-primary btn-lg" href="#start">
              Get started
            </a>
            <button type="button" className="btn btn-ghost btn-lg" onClick={openHow}>
              How it works
            </button>
          </div>
          <ConnStrip
            health={health}
            ready={ready}
            threshold={threshold}
            memberCount={memberCount}
            caseCount={caseCount}
          />
        </div>
        <Gauge value={maxProgress} max={threshold} unlocked={anyUnlocked} />
      </section>

      <HowItWorks open={howOpen} onToggle={() => setHowOpen((o) => !o)} escrowN={escrow.nodes.length} escrowT={escrow.threshold} />

      <main className="flow" id="start">
        <Stepper hasKey={memberCount > 0} hasCase={caseCount > 0} hasUnlock={anyUnlocked} />

        {!ready ? (
          <div className="card gate">
            <div className="spinner" />
            <div>
              <strong>Bringing up the local devnet stack.</strong>
              <p>
                {health
                  ? BOOT_LABEL[health.boot.phase] ?? health.boot.phase
                  : 'Waiting for the Quorum API on :8787. Start it with '}
                {!health && <code>npm run quorum:api</code>}
              </p>
              <p className="hint">
                First run deploys the contract and funds fees — 2–3 min. Later runs rejoin instantly.
              </p>
              {health?.boot.phase === 'error' && (
                <p className="boot-err">API boot failed: {health.boot.detail}</p>
              )}
            </div>
          </div>
        ) : (
          <div className="grid">
            <div className="col">
              {CLAIM_TOKEN ? (
                <ClaimCredential
                  token={CLAIM_TOKEN}
                  onClaimed={() => {
                    clearClaimParam()
                    refresh()
                  }}
                />
              ) : (
                <ClaimSlot
                  identities={state?.identities ?? []}
                  members={state?.members ?? []}
                  issuance={state?.issuance}
                  onClaimed={refresh}
                />
              )}
              <FileReport
                threshold={threshold}
                members={state?.members ?? []}
                escrow={escrow}
                onChange={refresh}
              />
            </div>
            <div className="col">
              {stateErr && <div className="card err-card">Couldn’t read chain state: {stateErr}</div>}
              <EscrowBoard buckets={buckets} threshold={threshold} escrow={escrow} />
            </div>
          </div>
        )}
      </main>

      <footer className="site-foot">
        <span>
          Quorum — anonymous allegation escrow, built on{' '}
          <a href="https://midnight.network" target="_blank" rel="noreferrer">
            Midnight
          </a>
          .
        </span>
        <span className="foot-links">
          <button type="button" className="linkish" onClick={openHow}>
            How it works
          </button>
          <span className="dim">·</span>
          <code>npm run quorum:e2e</code>
          <span className="dim">·</span>
          <span className="dim">Local devnet</span>
        </span>
      </footer>
    </div>
  )
}

/* ── brand ──────────────────────────────────────────────────── */
function Logo() {
  return (
    <svg className="logo-mark" viewBox="0 0 28 28" fill="none" aria-hidden="true">
      <circle cx="10.6" cy="11" r="6.1" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="17.4" cy="11" r="6.1" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="14" cy="16.6" r="6.1" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="14" cy="12.9" r="2.1" fill="var(--accent)" />
    </svg>
  )
}

/* ── connection + key stats ─────────────────────────────────── */
function ConnStrip({
  health,
  ready,
  threshold,
  memberCount,
  caseCount,
}: {
  health: Health | null
  ready: boolean
  threshold: number
  memberCount: number
  caseCount: number
}) {
  return (
    <div className="connstrip">
      {!health && <Dot tone="warn" label="connecting to API…" />}
      {health && !ready && <Dot tone="warn" label={BOOT_LABEL[health.boot.phase] ?? health.boot.phase} />}
      {ready && (
        <>
          <Dot tone="good" label="connected" />
          <Meta k="threshold" v={String(threshold)} />
          <Meta k="reporters" v={String(memberCount)} />
          <Meta k="cases" v={String(caseCount)} />
          {health && <ContractChip address={health.contractAddress} />}
        </>
      )}
    </div>
  )
}

/* ── hero gauge ─────────────────────────────────────────────── */
function Gauge({ value, max, unlocked }: { value: number; max: number; unlocked: boolean }) {
  const r = 54
  const circ = 2 * Math.PI * r
  const pct = max > 0 ? Math.min(1, value / max) : 0
  return (
    <div className={`gauge${unlocked ? ' is-open' : ''}`} aria-hidden="true">
      <svg viewBox="0 0 140 140">
        <circle className="gauge-track" cx="70" cy="70" r={r} />
        <circle
          className="gauge-arc"
          cx="70"
          cy="70"
          r={r}
          strokeDasharray={circ}
          strokeDashoffset={circ * (1 - pct)}
          transform="rotate(-90 70 70)"
        />
      </svg>
      <div className="gauge-face">
        <span className="gauge-num">
          {value}
          <span className="gauge-den">/{max}</span>
        </span>
        <span className="gauge-cap">{unlocked ? 'a case is open' : 'to unlock a case'}</span>
      </div>
    </div>
  )
}

/* ── stepper ────────────────────────────────────────────────── */
function Stepper({
  hasKey,
  hasCase,
  hasUnlock,
}: {
  hasKey: boolean
  hasCase: boolean
  hasUnlock: boolean
}) {
  const steps = [
    { n: 1, label: 'Get a reporter key', done: hasKey },
    { n: 2, label: 'File a report', done: hasCase },
    { n: 3, label: 'Corroborate & reveal', done: hasUnlock },
  ]
  const activeIdx = steps.findIndex((s) => !s.done)
  return (
    <ol className="stepper">
      {steps.map((s, i) => (
        <li
          key={s.n}
          className={`${s.done ? 'done' : ''} ${i === activeIdx ? 'active' : ''}`.trim()}
        >
          <span className="step-dot">{s.done ? '✓' : s.n}</span>
          <span className="step-label">{s.label}</span>
        </li>
      ))}
    </ol>
  )
}

/* ── how it works (collapsible) ─────────────────────────────── */
function HowItWorks({
  open,
  onToggle,
  escrowN,
  escrowT,
}: {
  open: boolean
  onToggle: () => void
  escrowN: number
  escrowT: number
}) {
  return (
    <section className={`how${open ? ' open' : ''}`} id="how">
      <button type="button" className="how-head" onClick={onToggle} aria-expanded={open}>
        <span>How it works</span>
        <span className="how-chev" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div className="how-body">
          <div className="how-grid">
            <article>
              <h3>
                <span className="how-n">1</span> One person, one reporter
              </h3>
              <p>
                You prove control of an allow-listed email once. That mints a single credential, spent
                immediately to enrol a passphrase-only reporter key. Your email is never linked to the key.
              </p>
            </article>
            <article>
              <h3>
                <span className="how-n">2</span> File without being identified
              </h3>
              <p>
                Filing proves your key is one of the enrolled reporters — without revealing which one — and
                burns a one-time marker, so a key counts once per person named.
              </p>
            </article>
            <article>
              <h3>
                <span className="how-n">3</span> Opens only at quorum
              </h3>
              <p>
                The report body is encrypted in your browser; its key is split across {escrowN} independent
                holders ({escrowT}-of-{escrowN}). Each releases its share only after its own on-chain check
                that enough reporters named the same person.
              </p>
            </article>
          </div>
          <p className="how-note">
            Still trusted: whoever curates the email allow-list (one address per real person), and fewer than{' '}
            {escrowT} of {escrowN} share-holders colluding. Everything else is enforced by the contract in
            zero knowledge.
          </p>
        </div>
      )}
    </section>
  )
}

/* ── small primitives ──────────────────────────────────────── */
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

function ContractChip({ address }: { address: string }) {
  const [copied, setCopied] = useState(false)
  const short = `${address.slice(0, 6)}…${address.slice(-4)}`
  const copy = () => {
    navigator.clipboard?.writeText(address).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      },
      () => {},
    )
  }
  return (
    <button type="button" className="smeta chip" onClick={copy} title="Copy contract address">
      <span className="sk">contract</span>
      <span className="sv mono">{copied ? 'copied' : short}</span>
    </button>
  )
}

function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  const dark = theme === 'dark'
  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={onToggle}
      aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      title={dark ? 'Light mode' : 'Dark mode'}
    >
      {dark ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32l1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      )}
    </button>
  )
}
