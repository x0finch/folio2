import { Effect } from "effect";
import { SigningFailure, summaryOf } from "./errors";

// HMAC-SHA256 签名。**这是从 `@folio/connectors-basic` 复制过来的一份,不是搬过去的**:
// 那个包是 connector 的契约基座(`BalanceProvider` / `Balance` / creds 加解密),client 层不许依赖它
// (ADR 0036) —— 一个只会算摘要的函数不值得为它拉进整个契约包。老那份留在原地服务老 provider,
// 等 B 批 provider 包搬空后若没人用了,再跟着删。
//
// 与老那份的区别只有出口形状:`Promise<string>` → `Effect<string, SigningFailure>`。签不出来是
// **凭据问题不是传输故障**(见 errors.ts 里 SigningFailure 的注释)。

const HEX = "0123456789abcdef";

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += HEX[b >> 4] + HEX[b & 15];
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function hmacSha256(
  secret: string,
  message: string,
  encoding: "hex" | "base64",
): Effect.Effect<string, SigningFailure> {
  return Effect.tryPromise({
    try: async () => {
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
    },
    // **不带 cause 里的 secret**:cause 是 WebCrypto 抛的错,不含密钥;`where` 也只说「签名」。
    catch: (cause) => new SigningFailure({ where: "hmac-sha256", cause: summaryOf(cause) }),
  });
}
