// 凭据加解密原语:Web Crypto AES-GCM(Workers 原生支持)。
// 用标准算法,不手写密码学;本模块【不读 env】——密钥由调用方传入(env.SECRETS_KEY),
// 保持 core 运行时无关、可单测。任何上层只回 has* 布尔,密文/明文不外泄(见 arch-design §3)。

const ALGORITHM = "AES-GCM";
const KEY_BYTES = 32; // 256-bit 密钥
const IV_BYTES = 12; // GCM 推荐 96-bit IV

/** 解密失败 / 密钥或载荷格式非法时抛出。 */
export class CryptoError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "CryptoError";
  }
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

/** 加密明文,返回 base64( 随机IV(12) ‖ 密文+GCMTag )。同明文每次密文不同。 */
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

/** 解密 encrypt 产出的载荷;错误密钥/被篡改数据/格式非法均抛 CryptoError。 */
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

/** 生成一个新的 SECRETS_KEY:base64(32 随机字节)。用于部署初始化。 */
export function generateSecret(): string {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(KEY_BYTES)));
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * HMAC-SHA256 签名(Web Crypto,零依赖)。CEX 请求签名公用件:binance 用 hex、okx 用 base64,
 * 后续交易所复用同一原语。纯函数 → 可对参考实现(openssl dgst -sha256 -hmac)做 golden。
 */
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
