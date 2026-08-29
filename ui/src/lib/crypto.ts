// Client-side sealing of a report body.
//
// The body is AES-256-GCM encrypted here, in the browser, before anything is
// sent. The ciphertext + iv + key are escrowed by the demo API, which withholds
// the key until the on-chain quorum count is reached. Milestone 2 removes that
// trust: the key is split with Shamir secret-sharing so no single party can
// reconstruct it before quorum.

export interface Sealed {
  ciphertext: string // base64
  iv: string // base64
  key: string // base64 (raw AES key)
}

export interface ReportBody {
  title: string
  details: string
}

const enc = new TextEncoder()
const dec = new TextDecoder()

function toB64(bytes: ArrayBuffer | Uint8Array): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let s = ''
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i])
  return btoa(s)
}

function fromB64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s)
  const u = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i)
  return u
}

export async function sealReport(body: ReportBody): Promise<Sealed> {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(JSON.stringify(body)),
  )
  const raw = await crypto.subtle.exportKey('raw', key)
  return { ciphertext: toB64(ciphertext), iv: toB64(iv), key: toB64(raw) }
}

export async function openReport(s: Sealed): Promise<ReportBody> {
  const key = await crypto.subtle.importKey('raw', fromB64(s.key), { name: 'AES-GCM' }, false, ['decrypt'])
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(s.iv) }, key, fromB64(s.ciphertext))
  return JSON.parse(dec.decode(pt)) as ReportBody
}

/** hex SHA-256 of a string — used only for the "what leaves your device" preview */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(input.normalize('NFKC')))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
