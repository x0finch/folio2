// Pure crypto: keys are always passed in by the caller; this module never reads env.

const ALGORITHM = "AES-GCM";
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // 96-bit IV, as GCM recommends

export class CryptoError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "CryptoError";
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function importKey(secret: string): Promise<CryptoKey> {
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = base64ToBytes(secret);
  } catch (cause) {
    throw new CryptoError("SECRETS_KEY must be base64 of 32 bytes", { cause });
  }
  if (raw.length !== KEY_BYTES) {
    throw new CryptoError("SECRETS_KEY must be base64 of 32 bytes");
  }
  return crypto.subtle.importKey("raw", raw, { name: ALGORITHM }, false, ["encrypt", "decrypt"]);
}

/** Returns base64(random IV(12) ‖ ciphertext+GCM tag). */
export async function encrypt(plaintext: string, secret: string): Promise<string> {
  const key = await importKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const data = new TextEncoder().encode(plaintext);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: ALGORITHM, iv }, key, data));
  const payload = new Uint8Array(iv.length + cipher.length);
  payload.set(iv, 0);
  payload.set(cipher, iv.length);
  return bytesToBase64(payload);
}

export async function decrypt(payload: string, secret: string): Promise<string> {
  const key = await importKey(secret);
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = base64ToBytes(payload);
  } catch (cause) {
    throw new CryptoError("decrypt failed: invalid payload encoding", { cause });
  }
  if (bytes.length <= IV_BYTES) {
    throw new CryptoError("decrypt failed: payload too short");
  }
  const iv = bytes.subarray(0, IV_BYTES);
  const cipher = bytes.subarray(IV_BYTES);
  try {
    const plain = await crypto.subtle.decrypt({ name: ALGORITHM, iv }, key, cipher);
    return new TextDecoder().decode(plain);
  } catch (cause) {
    throw new CryptoError("decrypt failed: invalid key or corrupted data", { cause });
  }
}

export function generateSecret(): string {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(KEY_BYTES)));
}

/** Binance signs with hex, OKX with base64. */
export async function hmacSha256(
  secret: string,
  message: string,
  encoding: "hex" | "base64",
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)),
  );
  return encoding === "hex" ? bytesToHex(sig) : bytesToBase64(sig);
}
