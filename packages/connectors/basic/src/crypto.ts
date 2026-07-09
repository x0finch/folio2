// CEX 请求签名原语。搬自旧 @folio/balances-basic 的 hmacSha256(纯函数、零依赖)。
// 安全边界(原则 #5):本模块只做【用用户交易所 secret 在取数时签名】—— 纯运算,不碰 SECRETS_KEY、
// 不读 env。SECRETS_KEY 级的加解密(encrypt/decrypt/generateSecret)是 app 层的活,留在 app 里(#37 前)。

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
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
