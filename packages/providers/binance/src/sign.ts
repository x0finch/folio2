// HMAC-SHA256 签名(Web Crypto,Workers 原生,零依赖)。Binance 对 query 串签名、hex 输出,
// 追加为 &signature=<hex>。纯函数 → 可对官方测试向量做 golden 断言。这是 CEX 签名模板的核心,
// 后续交易所(okx/bybit/…)各自的签名复用同一 Web Crypto 思路。
export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
