import {
  type Balance,
  type BalanceProvider,
  defineProvider,
  hmacSha256,
  type ProviderEntry,
  ProviderError,
  parseRetryAfter,
} from "@folio/balances-basic";
import { z } from "zod";
import {
  AUTH_ERROR_CODES,
  BALANCE_PATH,
  HEADER_KEY,
  HEADER_PASSPHRASE,
  HEADER_SIGN,
  HEADER_TIMESTAMP,
  OKX_API_BASE,
} from "./constants";

// @folio/balances-provider-okx —— 第二个 CEX(exchange_okx)。复用 @folio/balances-basic 的 hmacSha256 公共件。
// 与 binance 的差异:① 签名是 base64(HMAC(timestamp+METHOD+requestPath, secret));② 需 passphrase;
// ③ 余额自带 eqUsd(无需公开价估值);④ 错误常以 HTTP 200 + code!="0" 返回(含 key/签名错)。
// 每账户密钥走 ctx.creds(加密入库),不是全局 key → 不声明 usesGlobalKeys。原生 fetch,零依赖。

interface OkxDetail {
  ccy?: string;
  eq?: string;
  eqUsd?: string;
}
interface OkxBalanceResponse {
  code?: string;
  msg?: string;
  data?: Array<{ details?: OkxDetail[] }>;
}

// 纯解析:details[] → Balance[]。与 IO 分离,golden test。
// amount=eq、value=eqUsd(OKX 自带)、price=eqUsd/eq;跳过空 ccy / amount≤0;kind:spot。
export function parseBalances(details: OkxDetail[]): Balance[] {
  const out: Balance[] = [];
  for (const d of details ?? []) {
    const ccy = d.ccy;
    if (!ccy) continue;
    const amount = Number(d.eq ?? 0);
    if (!(amount > 0)) continue;
    out.push({
      symbol: ccy,
      amount,
      price: amount > 0 ? Number(d.eqUsd ?? 0) / amount : undefined,
      value: Number(d.eqUsd ?? 0),
      kind: "spot",
    });
  }
  return out;
}

// 签名 GET:prehash = timestamp + 'GET' + requestPath;SIGN = base64(HMAC-SHA256)。
async function okxGet(
  path: string,
  creds: { apiKey: string; secret: string; passphrase: string },
): Promise<Response> {
  const ts = new Date().toISOString();
  const sign = await hmacSha256(creds.secret, `${ts}GET${path}`, "base64");
  try {
    return await fetch(`${OKX_API_BASE}${path}`, {
      headers: {
        [HEADER_KEY]: creds.apiKey,
        [HEADER_SIGN]: sign,
        [HEADER_TIMESTAMP]: ts,
        [HEADER_PASSPHRASE]: creds.passphrase,
        "Content-Type": "application/json",
      },
    });
  } catch (cause) {
    throw new ProviderError("UPSTREAM_ERROR", "okx request failed", { cause });
  }
}

// HTTP 层错误(OKX 也用 429 限流;auth 错通常是 200+code,见 assertCodeOk)。
function ensureHttpOk(res: Response): void {
  if (res.ok) return;
  if (res.status === 401 || res.status === 403) {
    throw new ProviderError("AUTH_FAILED", `okx auth failed (${res.status})`);
  }
  if (res.status === 429) {
    throw new ProviderError("RATE_LIMITED", "okx rate limited", {
      retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
    });
  }
  throw new ProviderError("UPSTREAM_ERROR", `okx upstream error (${res.status})`);
}

// 业务层错误(HTTP 200 + code!="0"):凭据类 code → AUTH_FAILED,其余 → UPSTREAM_ERROR。
function assertCodeOk(body: OkxBalanceResponse): void {
  if (body.code === "0") return;
  const code = body.code ?? "unknown";
  const msg = body.msg || "okx error";
  if (AUTH_ERROR_CODES.has(code)) {
    throw new ProviderError("AUTH_FAILED", `okx auth failed (code ${code}: ${msg})`);
  }
  throw new ProviderError("UPSTREAM_ERROR", `okx error (code ${code}: ${msg})`);
}

async function readBody(res: Response): Promise<OkxBalanceResponse> {
  try {
    return (await res.json()) as OkxBalanceResponse;
  } catch (cause) {
    throw new ProviderError("PARSE_ERROR", "okx returned invalid JSON", { cause });
  }
}

export const okxProvider = defineProvider({
  accountType: "exchange_okx",
  inputs: [
    // apiKey = 标识符(明文走 header,非认证秘密)→ semi:导出打码保留供补录识别。
    { key: "apiKey", type: "semi", label: "API Key", validator: z.string().trim().min(1) },
    { key: "secret", type: "secret", label: "API Secret", validator: z.string().trim().min(1) },
    { key: "passphrase", type: "secret", label: "Passphrase", validator: z.string().trim().min(1) },
  ],

  async fetchBalances(ctx): Promise<Balance[]> {
    const res = await okxGet(BALANCE_PATH, ctx.creds);
    ensureHttpOk(res);
    const body = await readBody(res);
    assertCodeOk(body);
    return parseBalances(body.data?.[0]?.details ?? []);
  },

  // 校验:签名打 balance,HTTP ok 且 code="0" 即 true(creds 已保证三项非空)。任何失败 → false。
  async validate(ctx): Promise<boolean> {
    try {
      const res = await okxGet(BALANCE_PATH, ctx.creds);
      if (!res.ok) return false;
      const body = (await res.json()) as OkxBalanceResponse;
      return body.code === "0";
    } catch {
      return false;
    }
  },
});

export const providers: BalanceProvider[] = [okxProvider];

// 自描述清单(ADR 0009)。凭据是每账户 API key(inputs),无全局设置。
export const entries: ProviderEntry[] = [
  {
    manifest: {
      id: "okx-api",
      accountType: "exchange_okx",
      dataSource: "okx",
      configSchema: [],
      defaultEnabled: true,
    },
    create: () => okxProvider,
  },
];
