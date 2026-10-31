/** OWASP's recommendation for PBKDF2-HMAC-SHA256. */
const PASSWORD_ITERATIONS = 600_000
export const MIN_PASSWORD_LENGTH = 8

export const normalizeEmail = (email: string) => email.trim().toLowerCase()

/**
 * Stretches a password on the device before it is sent, so the server can store it with a
 * cheap hash that fits the Workers free plan's CPU budget (apps/api/src/password.ts). The salt
 * is the normalised email, so every device derives the same key.
 */
export async function derivePasswordKey(
  email: string,
  password: string,
  iterations: number = PASSWORD_ITERATIONS,
): Promise<string> {
  const encoder = new TextEncoder()
  const material = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password.normalize('NFKC')),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: encoder.encode(`folio-password:${normalizeEmail(email)}`),
      iterations,
    },
    material,
    256,
  )
  return Array.from(new Uint8Array(bits), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
