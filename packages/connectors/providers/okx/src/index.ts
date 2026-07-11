import {
  type BalanceProvider,
  type CredField,
  hmacSha256,
  ProviderError,
  parseRetryAfter,
  type Spot,
} from "@folio/connectors-basic";
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

// @folio/connectors-provider-okx —— 第二个 CEX connector(okx)。复用 @folio/connectors-basic 的 hmacSha256。
// 与 binance 的差异:① 签名是 base64(HMAC(timestamp+METHOD+requestPath, secret));② 需 passphrase;
// ③ 余额自带 eqUsd(无需公开价估值);④ 错误常以 HTTP 200 + code!="0" 返回(含 key/签名错)。
// 每账户密钥(apiKey/secret/passphrase)走 account.creds(加密入库,取数时由分派桥 openCreds 解密后灌入
// ctx.account.creds)—— 不是全局 provider key,故 provider 级 creds(PC)为空。原生 fetch,零依赖。

interface OkxDetail {
  ccy?: string;
  eq?: string;
  eqUsd?: string;
  frozenBal?: string; // 冻结余额(原币,挂单/借贷占用)
}
interface OkxBalanceResponse {
  code?: string;
  msg?: string;
  data?: Array<{ details?: OkxDetail[] }>;
}

// 纯解析:details[] → Spot[]。与 IO 分离,golden test。
// amount=eq、value=eqUsd(OKX 自带)、price=eqUsd/eq;跳过空 ccy / amount≤0;kind:spot。
// 冻结 note(note 重设计,balance 级单个 Note):frozenBal>0 的币,在【它自己那笔 balance】上挂一个
// `Frozen` 段(icon warning;1 行 { label:币种, value:冻结数量, unit:币种 },原币口径)。无冻结 → 无 note。
export function parseBalances(details: OkxDetail[]): Spot[] {
  const out: Spot[] = [];
  for (const d of details ?? []) {
    const ccy = d.ccy;
    if (!ccy) continue;
    const amount = Number(d.eq ?? 0);
    if (!(amount > 0)) continue;
    const frozen = Number(d.frozenBal ?? 0);
    const row: Spot = {
      symbol: ccy,
      amount,
      price: Number(d.eqUsd ?? 0) / amount,
      value: Number(d.eqUsd ?? 0),
      kind: "spot",
    };
    if (frozen > 0) {
      row.note = {
        title: "Frozen",
        icon: "warning",
        content: [{ label: ccy, value: frozen, unit: ccy }],
      };
    }
    out.push(row);
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

// —— 账户级 creds(AC):apiKey(semi)/secret(secret)/passphrase(secret)。apiKey = 标识符
// (明文走 header,非认证秘密)→ semi;secret/passphrase 均为签名秘密 → secret。账户 creds 声明随
// provider(其天然消费者)落此;将来同 connector 多 provider 时提到 entry 共享。——
export const okxAccountCreds = [
  { key: "apiKey", type: "semi", label: "API Key", validator: z.string().trim().min(1) },
  { key: "secret", type: "secret", label: "API Secret", validator: z.string().trim().min(1) },
  { key: "passphrase", type: "secret", label: "Passphrase", validator: z.string().trim().min(1) },
] as const satisfies readonly CredField[];

export const okxProvider: BalanceProvider<Spot, typeof okxAccountCreds> = {
  id: "okx",
  label: "OKX",
  // 无全局 provider key —— 账户自己的 apiKey/secret/passphrase 即凭据,走 account.creds。
  creds: [],

  async fetchBalances(ctx): Promise<{ balances: Spot[] }> {
    const res = await okxGet(BALANCE_PATH, ctx.account.creds);
    ensureHttpOk(res);
    const body = await readBody(res);
    assertCodeOk(body);
    return { balances: parseBalances(body.data?.[0]?.details ?? []) };
  },

  // 校验:签名打 balance,HTTP ok 且 code="0" 即 true(creds 已保证三项非空)。任何失败 → false。
  async validateAccount(ctx): Promise<boolean> {
    try {
      const res = await okxGet(BALANCE_PATH, ctx.account.creds);
      if (!res.ok) return false;
      const body = (await res.json()) as OkxBalanceResponse;
      return body.code === "0";
    } catch {
      return false;
    }
  },
};
