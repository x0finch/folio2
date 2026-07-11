import {
  BitcoinDeriveError,
  blockbookXpubParam,
  isScriptType,
  makeDeriver,
  recommendedScript,
  SCRIPT_TYPES,
  type ScriptType,
} from "@folio/bitcoin-derive";
import {
  type BlockbookClient,
  BlockbookError,
  createBlockbookClient,
  type XpubToken,
} from "@folio/blockbook-client";
import {
  type BalanceProvider,
  type CredField,
  ProviderError,
  type Spot,
} from "@folio/connectors-basic";
import { buildTokenKey } from "@folio/tokens-basic";
import { z } from "zod";
import {
  ADDR_SHORT_HEAD,
  ADDR_SHORT_MIN,
  ADDR_SHORT_TAIL,
  BTC_ADDRESS_RE,
  EXT_PUBKEY_FULL_RE,
  EXT_PUBKEY_RE,
  MEMPOOL_ADDRESS_URL,
  SATS_PER_BTC,
} from "./constants";

// @folio/connectors-provider-blockbook —— 只读 Bitcoin(bitcoin connector)。地址 + xpub 两模式。
// 只做【整合】:取数走 @folio/blockbook-client(Trezor Blockbook,xpub 服务端派生、一次调用),
// token 造型/本地下址派生走 @folio/bitcoin-derive,本包串起值 + markdown detail 组装 + 契约映射。
// addressOrXpub(public)= BTC 地址或扩展公钥;裸 xpub 用 scriptType(public)选脚本类型(zpub/ypub 前缀已定,忽略)。
// 值不在此算:provider 只产已确认 BTC amount(value=0),交 app 的 revalue 盯市(token 层唯一价源)。
// BTC 明细(未确认/派生分布/收款指引)拼成 markdown 字符串塞 detail(spike markdown-detail):
//   前端 react-markdown 直渲,provider 零结构化 meta。永久英文(detail 不跟随显示币种/语言)。
// 纯包:blockbook-client / bitcoin-derive 均无 cloudflare:workers / env,不碰 SECRETS_KEY(原则 #5)。

// BTC 身份键:chain:bitcoin/native:btc(仅作身份 + 平台归属 → "Bitcoin")。
export const BTC_TOKEN_KEY = buildTokenKey({ chain: "bitcoin", native: true, symbol: "BTC" });

const toSats = (s: string | undefined): number => {
  const n = Number(s ?? "0");
  return Number.isFinite(n) ? n : 0;
};

// sats → BTC 全精度串(核对用精确值,8 位、去尾零)。
const btc = (sats: number): string => {
  const s = (sats / SATS_PER_BTC).toFixed(8);
  return s.replace(/\.?0+$/, "");
};

// 地址中缩:首 ADDR_SHORT_HEAD + 尾 ADDR_SHORT_TAIL;短地址不缩。
const shortAddr = (a: string): string =>
  a.length > ADDR_SHORT_MIN ? `${a.slice(0, ADDR_SHORT_HEAD)}…${a.slice(-ADDR_SHORT_TAIL)}` : a;

// 地址 → markdown 外链(文字截断,URL 用全地址)。
const addrLink = (a: string): string => `[${shortAddr(a)}](${MEMPOOL_ADDRESS_URL}${a})`;

// 生效脚本类型:zpub/ypub 前缀权威(忽略 scriptType);裸 xpub 用所选、缺省按 recommendedScript(native)。
function effectiveScript(ext: string, scriptType: string | undefined): ScriptType {
  if (ext.startsWith("zpub") || ext.startsWith("ypub")) return recommendedScript(ext);
  return isScriptType(scriptType) ? scriptType : recommendedScript(ext);
}

// 派生路径尾段 → { chain, index }。形如 m/84'/0'/0'/0/5 → chain=0(外部)、index=5。
function parsePath(path: string): { chain: number; index: number } | null {
  const parts = path.split("/");
  const index = Number(parts[parts.length - 1]);
  const chain = Number(parts[parts.length - 2]);
  if (!Number.isInteger(index) || !Number.isInteger(chain)) return null;
  return { chain, index };
}

interface AddressDist {
  address: string;
  chain: "receive" | "change";
  balanceSats: number;
}
interface ReceiveGuide {
  lastUsed: { index: number; address: string } | null;
  next: { index: number; address: string }[];
}

// 未确认 / 派生分布 / 收款指引 → markdown 字符串(仅非空段落)。全空 → undefined(不塞 detail)。
// 段落:Unconfirmed(仅非零)· Receive addresses(lastUsed + 本地派生 next)· Distribution(仅非零余额)。
// Distribution 按 chain 拆成 *Receive* / *Change* 两个斜体子标题的子列表(仅该子列表有地址才出子标题),
// 每行只写 地址 — 余额(不再在行内写 receive/change)。
export function buildBtcDetail(
  pendingSats: number,
  dist: AddressDist[],
  receive?: ReceiveGuide,
): string | undefined {
  const sections: string[] = [];

  if (pendingSats !== 0) {
    const sign = pendingSats > 0 ? "+" : "";
    sections.push(`**Unconfirmed:** ${sign}${btc(pendingSats)} BTC`);
  }

  if (receive && (receive.lastUsed || receive.next.length > 0)) {
    const lines: string[] = ["**Receive addresses**"];
    if (receive.lastUsed) {
      lines.push(`- Last used (#${receive.lastUsed.index}): ${addrLink(receive.lastUsed.address)}`);
    }
    for (const n of receive.next) lines.push(`- Next #${n.index}: ${addrLink(n.address)}`);
    sections.push(lines.join("\n"));
  }

  if (dist.length > 0) {
    const lines = ["**Distribution**"];
    const sub = (heading: string, chain: AddressDist["chain"]) => {
      const rows = dist.filter((a) => a.chain === chain);
      if (rows.length === 0) return;
      lines.push("", `*${heading}*`);
      for (const a of rows) lines.push(`- ${addrLink(a.address)} — ${btc(a.balanceSats)} BTC`);
    };
    sub("Receive", "receive");
    sub("Change", "change");
    sections.push(lines.join("\n"));
  }

  return sections.length > 0 ? sections.join("\n\n") : undefined;
}

// 已确认净额 → amount(BTC);明细拼进 detail(markdown)。value=0 交 revalue 盯市。
// 既无已确认又无未确认 → 空(无持仓);仅未确认仍产一行(amount=0 + detail 里的 pending)。
function toBtcBalances(
  confirmedSats: number,
  pendingSats: number,
  dist: AddressDist[] = [],
  receive?: ReceiveGuide,
): Spot[] {
  if (confirmedSats <= 0 && pendingSats === 0) return [];
  const detail = buildBtcDetail(pendingSats, dist, receive);
  return [
    {
      symbol: "BTC",
      amount: confirmedSats / SATS_PER_BTC,
      value: 0, // 交给 revalue 盯市(amount × BTC 市价)
      kind: "spot",
      tokenKey: BTC_TOKEN_KEY,
      ...(detail ? { detail } : {}),
    },
  ];
}

// Blockbook xpub 响应 → 分布(仅非零)+ 收款指引(lastUsed 外部最大已用;next 本地派生其后两个)。
function buildXpubDetail(
  ext: string,
  script: ScriptType,
  tokens: XpubToken[],
): { dist: AddressDist[]; receive: ReceiveGuide } {
  const dist: AddressDist[] = [];
  let lastExternal: { index: number; address: string } | null = null;

  for (const t of tokens) {
    const parsed = parsePath(t.path);
    if (!parsed) continue;
    const balanceSats = toSats(t.balance);
    if (balanceSats > 0) {
      dist.push({
        address: t.name,
        chain: parsed.chain === 0 ? "receive" : "change",
        balanceSats,
      });
    }
    // tokens=used → 返回的都是已用地址;取外部链(chain 0)最大下标作 lastUsed。
    if (parsed.chain === 0 && (!lastExternal || parsed.index > lastExternal.index)) {
      lastExternal = { index: parsed.index, address: t.name };
    }
  }

  // next:外部链 lastUsed 之后两个(本地派生,不出网 → 保隐私)。
  const derive = makeDeriver(ext, script);
  const base = lastExternal ? lastExternal.index + 1 : 0;
  const next = [base, base + 1].map((index) => ({ index, address: derive(0, index) }));

  return { dist, receive: { lastUsed: lastExternal, next } };
}

const isExtendedPubkey = (id: string): boolean => EXT_PUBKEY_RE.test(id);

// 客户端/派生错误 → provider 契约(sync 据 ProviderError 重试)。
function toProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof BlockbookError) {
    return new ProviderError(err.code, err.message, { retryAfterMs: err.retryAfterMs, cause: err });
  }
  if (err instanceof BitcoinDeriveError) {
    return new ProviderError("INVALID_CREDENTIALS", err.message, { cause: err });
  }
  return new ProviderError("UPSTREAM_ERROR", "bitcoin provider failed", { cause: err });
}

async function fetchXpub(client: BlockbookClient, ext: string, scriptType: string | undefined) {
  const script = effectiveScript(ext, scriptType);
  const res = await client.getXpub(blockbookXpubParam(ext, script)); // details=tokenBalances&tokens=used
  const { dist, receive } = buildXpubDetail(ext, script, res.tokens ?? []);
  return toBtcBalances(toSats(res.balance), toSats(res.unconfirmedBalance), dist, receive);
}

// —— 账户级 creds(AC):BTC 地址或扩展公钥,public(明文落库、可导出重建)——
// addressOrXpub:地址(1…/3…/bc1…)或 xpub/ypub/zpub;scriptType:仅裸 xpub 用(zpub/ypub 前缀已定、单地址无关),缺省由 recommendedScript 兜底。
// 账户 creds 声明随 provider(其天然消费者)落此;将来同 connector 多 provider 时提到 entry 共享。
export const bitcoinAccountCreds = [
  {
    key: "addressOrXpub",
    type: "public",
    label: "Bitcoin address or xpub",
    desc: "address (1…/3…/bc1…) or xpub/ypub/zpub",
    validator: z.string().refine((v) => BTC_ADDRESS_RE.test(v) || EXT_PUBKEY_FULL_RE.test(v), {
      message: "expected a BTC address or extended public key",
    }),
  },
  {
    key: "scriptType",
    type: "public",
    label: "Address type",
    validator: z.enum(SCRIPT_TYPES).optional(),
  },
] as const satisfies readonly CredField[];

// —— provider 级 creds(PC):空 —— Blockbook 公共实例免 key,开箱即用。
const providerCreds = [] as const satisfies readonly CredField[];

export const blockbookProvider: BalanceProvider<
  Spot,
  typeof bitcoinAccountCreds,
  typeof providerCreds
> = {
  id: "blockbook",
  label: "Blockbook",
  creds: providerCreds,

  async fetchBalances(ctx): Promise<Spot[]> {
    const id = ctx.account.creds.addressOrXpub;
    const client = createBlockbookClient();
    try {
      if (isExtendedPubkey(id)) return await fetchXpub(client, id, ctx.account.creds.scriptType);
      const res = await client.getAddress(id);
      return toBtcBalances(toSats(res.balance), toSats(res.unconfirmedBalance));
    } catch (err) {
      throw toProviderError(err);
    }
  },

  // 轻量探活:地址模式打地址端点;xpub 模式造 token 打 xpub 端点(顺带校验扩展公钥可解析)。任何失败 → false。
  async validateAccount(ctx): Promise<boolean> {
    const id = ctx.account.creds.addressOrXpub;
    const client = createBlockbookClient();
    try {
      if (isExtendedPubkey(id)) {
        await client.getXpub(
          blockbookXpubParam(id, effectiveScript(id, ctx.account.creds.scriptType)),
          { details: "basic" },
        );
      } else {
        await client.getAddress(id);
      }
      return true;
    } catch {
      return false;
    }
  },
};
