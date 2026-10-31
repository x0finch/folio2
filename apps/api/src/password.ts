/**
 * Server side of password storage. Passwords never reach the server: the app stretches them
 * with PBKDF2-SHA256 (600,000 iterations, salted with the email) and sends the 256-bit
 * result. That input is already expensive to guess, so the server only adds a random salt
 * and SHA-256, which fits the 10ms CPU budget of the Workers free plan where scrypt would not.
 * A leaked database still costs an attacker the full PBKDF2 work per guess.
 */

const DERIVED_KEY = /^[0-9a-f]{64}$/
const VERSION = 'v1'

const hex = (bytes: ArrayBuffer | Uint8Array) =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')

async function digest(salt: string, key: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}:${key}`)))
}

/** Rejects raw passwords, so a client that forgot to stretch them cannot store weak hashes. */
export function isDerivedKey(value: string): boolean {
  return DERIVED_KEY.test(value)
}

export async function hashPassword(derivedKey: string): Promise<string> {
  if (!isDerivedKey(derivedKey)) throw new Error('Expected a derived password key')
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)))
  return `${VERSION}$${salt}$${await digest(salt, derivedKey)}`
}

export async function verifyPassword({
  hash,
  password,
}: {
  hash: string
  password: string
}): Promise<boolean> {
  const [version, salt, expected] = hash.split('$')
  if (version !== VERSION || !salt || !expected || !isDerivedKey(password)) return false
  const actual = await digest(salt, password)
  // Constant-time comparison of equal-length hex strings.
  let diff = actual.length ^ expected.length
  for (let i = 0; i < actual.length; i += 1) {
    diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i % expected.length)
  }
  return diff === 0
}
