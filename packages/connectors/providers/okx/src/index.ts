import {
  type BalanceProvider,
  type CredField,
  hmacSha256,
  isCredentialRejection,
  ProviderError,
  type Spot,
} from "@folio/connectors-basic";
import { tokenRef } from "@folio/oracle-ref";
import { createHttpClient } from "@folio/shared";
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
// ctx.account.creds)—— 不是全局 provider key。provider 级 creds(PC)不装凭据,只声明 base URL 覆盖
// 的 env key(#264,见 provider.creds)。原生 fetch,零依赖。

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

// 原币数量展示格式化(最多 8 位小数 + 千分位)。仅 note 文案用。
const fmtAmount = (n: number): string => n.toLocaleString("en-US", { maximumFractionDigits: 8 });

// 纯解析:details[] → Spot[]。与 IO 分离,golden test。
// 场馆命名者 = connectorId(与 manifest 的 `id` 同源,不许两处各写一遍)。
const PROVIDER_ID = "okx";

// amount=eq、value=eqUsd(OKX 自带)、price=eqUsd/eq;跳过空 ccy / amount≤0;kind:spot。
// 冻结 note(note 重设计,balance 级单个 Note):frozenBal>0 的币,在【它自己那笔 balance】上挂一个
// `Frozen` 段(icon warning;content 一行内联文案 `${冻结数量} ${币种} · ${占该币总持有的百分比}`,
// 如 `0.5 ETH · 25%`,原币口径)。无冻结 → 无 note。
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
      // 场馆命名:OKX 管这个币叫 `ccy`。symbol 大写归一由本 provider 负责(见 @folio/oracle-ref)。
      tokenRef: tokenRef.issued(PROVIDER_ID, ccy.trim().toUpperCase()),
    };
    if (frozen > 0) {
      const pct = amount > 0 ? Math.round((frozen / amount) * 100) : 0;
      row.note = {
        title: "Frozen",
        icon: "warning",
        content: `${fmtAmount(frozen)} ${ccy} · ${pct}%`,
      };
    }
    out.push(row);
  }
  return out;
}

// 出网:签名头 + 失败归类走共享的 http 包装(@folio/shared)。**没有限频器** —— 额度按账户自己
// 那把 key 算、一次同步只发 1 个请求,队永远是空的,装了拦不到任何东西(见 tests/no-gate.test.ts)。
//
// prehash = timestamp + 'GET' + requestPath;SIGN = base64(HMAC-SHA256)。
type OkxCreds = { apiKey: string; secret: string; passphrase: string };

// —— base URL 覆盖(#264)——
// 远程(CF Workers)出口 IP 被 OKX 按地区拒时,由 app 层从 env 注入代理 base;不设即原样直连。
// connector 不读 env、不知代理存在(原则 #5):只把 ctx.creds.OKX_API_BASE 当**不透明整串**用,缺省回退默认。
// key 由 provider.creds(PC)声明 → app 的 env 注入据此读值灌进 ctx.creds(不进 UI 表单)。
const OKX_BASE_KEY = "OKX_API_BASE";
function pickOkxBase(cfg: Record<string, unknown>): string {
  const v = cfg[OKX_BASE_KEY];
  return typeof v === "string" && v.trim() ? v.trim() : OKX_API_BASE;
}

// 请求 client 工厂:base 按请求可覆盖,故不再模块级绑死单例。签名头 / 失败归类不变。
const makeRequest = (baseUrl: string) =>
  createHttpClient<OkxCreds>({
    baseUrl,
    headers: async (path, options) => {
      const creds = options?.context;
      if (!creds) throw new ProviderError("INVALID_CREDENTIALS", "okx: missing credentials");
      const ts = new Date().toISOString();
      return {
        [HEADER_KEY]: creds.apiKey,
        [HEADER_SIGN]: await hmacSha256(creds.secret, `${ts}GET${path}`, "base64"),
        [HEADER_TIMESTAMP]: ts,
        [HEADER_PASSPHRASE]: creds.passphrase,
        "Content-Type": "application/json",
      };
    },
    // OKX 的 auth 错通常是 200 + code(见下面 assertCodeOk),所以这里只管 HTTP 层。
    toFailure: ({ kind, where, status, retryAfterMs, cause }) => {
      if (kind === "network")
        return new ProviderError("UPSTREAM_ERROR", "okx request failed", { cause });
      if (kind === "auth") return new ProviderError("AUTH_FAILED", `okx auth failed (${status})`);
      if (kind === "rate-limited")
        return new ProviderError("RATE_LIMITED", "okx rate limited", { retryAfterMs });
      if (kind === "parse")
        return new ProviderError("PARSE_ERROR", `okx returned invalid JSON (${where})`, { cause });
      return new ProviderError("UPSTREAM_ERROR", `okx upstream error (${status})`);
    },
  });

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

// —— 账户级 creds(AC):apiKey(semi)/secret(secret)/passphrase(secret)。apiKey = 标识符
// (明文走 header,非认证秘密)→ semi;secret/passphrase 均为签名秘密 → secret。账户 creds 声明随
// provider(其天然消费者)落此;将来同 connector 多 provider 时提到 entry 共享。——
export const okxAccountCreds = [
  { key: "apiKey", type: "semi", label: "API Key", validator: z.string().trim().min(1) },
  { key: "secret", type: "secret", label: "API Secret", validator: z.string().trim().min(1) },
  { key: "passphrase", type: "secret", label: "Passphrase", validator: z.string().trim().min(1) },
] as const satisfies readonly CredField[];

export const okxProvider: BalanceProvider<Spot, typeof okxAccountCreds> = {
  id: PROVIDER_ID,
  label: "OKX",
  // 无全局 provider key —— 账户自己的 apiKey/secret/passphrase 即凭据,走 account.creds。
  // PC 在此仅作 **env 注入声明**(非真凭据):app 层据此 key 从 env 读值灌进 ctx.creds,供 base URL
  // 覆盖(#264)。不进 UI 表单(那只认 account.creds)、不加密/不导出;值可能含代理密钥 → 不可 echo/log。
  creds: [
    {
      key: OKX_BASE_KEY,
      type: "public",
      label: "API base URL",
      validator: z.string().trim().url(),
    },
  ],

  async fetchBalances(ctx): Promise<{ balances: Spot[] }> {
    const request = makeRequest(pickOkxBase(ctx.creds as Record<string, unknown>));
    const body = (await request(BALANCE_PATH, {
      context: ctx.account.creds,
    })) as OkxBalanceResponse;
    assertCodeOk(body); // HTTP 200 + code!="0" 是 OKX 表达错误的主要方式,包管不到这一层
    return { balances: parseBalances(body.data?.[0]?.details ?? []) };
  },

  // 校验:签名打 balance。走 fetchBalances 同一条判据(assertCodeOk):HTTP 层失败由 request 抛,
  // 业务码 code!="0" 由 assertCodeOk 分类(凭据类 → AUTH_FAILED,其余 → UPSTREAM_ERROR)。
  // 凭据被拒 → false;够不到上游 → 抛(契约见 connector.ts / errors.ts)。creds 已保证三项非空。
  async validateAccount(ctx): Promise<boolean> {
    const request = makeRequest(pickOkxBase(ctx.creds as Record<string, unknown>));
    try {
      const body = (await request(BALANCE_PATH, {
        context: ctx.account.creds,
      })) as OkxBalanceResponse;
      assertCodeOk(body);
      return true;
    } catch (err) {
      if (isCredentialRejection(err)) return false;
      throw err;
    }
  },
};
