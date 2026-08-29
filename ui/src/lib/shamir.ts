// Shamir secret sharing over GF(2^8) (AES field, poly 0x11b).
//
// split(secret, t, k) -> k shares; any t reconstruct, any t-1 reveal nothing
// (information-theoretically). Used to fan a report's AES key out to k
// independent escrow nodes so no single node can decrypt.

const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
;(() => {
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    LOG[x] = i
    x = (x << 1) ^ (x & 0x80 ? 0x11b : 0)
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]
})()

const gmul = (a: number, b: number): number => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]])
const gdiv = (a: number, b: number): number => {
  if (b === 0) throw new Error('shamir: divide by zero')
  return a === 0 ? 0 : EXP[(LOG[a] + 255 - LOG[b]) % 255]
}

const evalPoly = (coeffs: number[], x: number): number => {
  let r = 0
  for (let i = coeffs.length - 1; i >= 0; i--) r = gmul(r, x) ^ coeffs[i]
  return r
}

function toB64(u: Uint8Array): string {
  let s = ''
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i])
  return btoa(s)
}
function fromB64(s: string): Uint8Array {
  const bin = atob(s)
  const u = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i)
  return u
}

export const b64encode = toB64
export const b64decode = fromB64

export interface Share {
  x: number // evaluation point, 1..k
  y: string // base64 of the per-byte share vector
}

export function split(secret: Uint8Array, threshold: number, shares: number): Share[] {
  if (threshold < 2 || shares < threshold || shares > 255) throw new Error('shamir: bad (t,k)')
  const ys: number[][] = Array.from({ length: shares }, () => [])
  const rnd = crypto.getRandomValues(new Uint8Array(secret.length * (threshold - 1)))
  let r = 0
  for (const byte of secret) {
    const coeffs = [byte]
    for (let i = 1; i < threshold; i++) coeffs.push(rnd[r++])
    for (let s = 0; s < shares; s++) ys[s].push(evalPoly(coeffs, s + 1))
  }
  return ys.map((y, s) => ({ x: s + 1, y: toB64(Uint8Array.from(y)) }))
}

export function combine(shares: Share[]): Uint8Array {
  if (shares.length < 2) throw new Error('shamir: need >= 2 shares')
  const pts = shares.map((s) => ({ x: s.x, y: fromB64(s.y) }))
  const len = pts[0].y.length
  const out = new Uint8Array(len)
  for (let byte = 0; byte < len; byte++) {
    let acc = 0
    for (let i = 0; i < pts.length; i++) {
      let num = 1
      let den = 1
      for (let j = 0; j < pts.length; j++) {
        if (i === j) continue
        num = gmul(num, pts[j].x)
        den = gmul(den, pts[i].x ^ pts[j].x)
      }
      acc ^= gmul(pts[i].y[byte], gdiv(num, den))
    }
    out[byte] = acc
  }
  return out
}
