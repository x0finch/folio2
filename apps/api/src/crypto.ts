/**
 * Encryption of the secret config fields (exchange API secrets) at rest: AES-256-GCM with a
 * key derived from ENCRYPTION_SECRET by HKDF. The connection id and user id are bound in as
 * additional data, so a sealed blob copied to another row does not open.
 */

const VERSION = 'v1'
const encoder = new TextEncoder()
const keys = new Map<string, Promise<CryptoKey>>()

function keyFor(secret: string): Promise<CryptoKey> {
  let key = keys.get(secret)
  if (!key) {
    key = crypto.subtle
      .importKey('raw', encoder.encode(secret), 'HKDF', false, ['deriveKey'])
      .then((material) =>
        crypto.subtle.deriveKey(
          {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: encoder.encode('folio-connection-secrets'),
            info: new Uint8Array(),
          },
          material,
          { name: 'AES-GCM', length: 256 },
          false,
          ['encrypt', 'decrypt'],
        ),
      )
    keys.set(secret, key)
  }
  return key
}

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0))

/** Seals a record of secret values for one row. */
export async function seal(
  secret: string,
  values: Record<string, string>,
  context: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(context) },
    await keyFor(secret),
    encoder.encode(JSON.stringify(values)),
  )
  return `${VERSION}.${toBase64(iv)}.${toBase64(new Uint8Array(data))}`
}

/** Opens what `seal` sealed with the same secret and context; throws otherwise. */
export async function open(
  secret: string,
  sealed: string,
  context: string,
): Promise<Record<string, string>> {
  const [version, iv, data] = sealed.split('.')
  if (version !== VERSION || !iv || !data) throw new Error('Unknown sealed format')
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(iv), additionalData: encoder.encode(context) },
    await keyFor(secret),
    fromBase64(data),
  )
  const parsed: unknown = JSON.parse(new TextDecoder().decode(plain))
  if (typeof parsed !== 'object' || parsed === null) throw new Error('Sealed value is not a record')
  return Object.fromEntries(
    Object.entries(parsed).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  )
}
