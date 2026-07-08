import {
  type Balance,
  type BitcoinAddress,
  type BitcoinMeta,
  type BitcoinReceive,
  buildTokenKey,
  defineProvider,
  type FetchContext,
  type ProviderEntry,
  ProviderError,
} from "@folio/balances-basic";
import {
  BitcoinDeriveError,
  blockbookXpubParam,
  isScriptType,
  makeDeriver,
  recommendedScript,
  type ScriptType,
} from "@folio/bitcoin-derive";
import {
  type BlockbookClient,
  BlockbookError,
  createBlockbookClient,
  type XpubToken,
} from "@folio/blockbook-client";
import { EXT_PUBKEY_RE, SATS_PER_BTC } from "./constants";

export type { ScriptType } from "@folio/bitcoin-derive";
export { recommendedScript, SCRIPT_TYPES } from "@folio/bitcoin-derive";

// @folio/balances-provider-bitcoin —— 只读 Bitcoin(onchain_bitcoin)。地址 + xpub 两模式。
// 只做【整合】:取数走 @folio/blockbook-client(Trezor Blockbook,xpub 服务端派生、一次调用),
// token 造型/本地下址派生走 @folio/bitcoin-derive,本包串起值/BitcoinMeta 组装 + 契约映射。
// identifier(public)= BTC 地址或扩展公钥;裸 xpub 用 scriptType(public)选脚本类型(zpub/ypub 前缀已定,忽略)。
// 值不在此算:provider 只产已确认 BTC amount(value=0),交 app 的 revalue 盯市(token 层唯一价源)。

// BTC 身份键:chain:bitcoin/native:btc(仅作身份 + 平台归属 → "Bitcoin")。
export const BTC_TOKEN_KEY = buildTokenKey({ chain: "bitcoin", native: true, symbol: "BTC" });

const toSats = (s: string | undefined): number => {
  const n = Number(s ?? "0");
  return Number.isFinite(n) ? n : 0;
};

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

// 已确认净额 → amount(BTC);未确认 → meta.pendingSats(不进权值)。
// 既无已确认又无未确认 → 空(无持仓);仅未确认仍产一行(amount=0 + pending 徽标)。
function toBtcBalances(
  confirmedSats: number,
  pendingSats: number,
  extra?: Partial<Omit<BitcoinMeta, "pendingSats">>,
): Balance[] {
  if (confirmedSats <= 0 && pendingSats === 0) return [];
  return [
    {
      symbol: "BTC",
      amount: confirmedSats / SATS_PER_BTC,
      value: 0, // 交给 revalue 盯市(amount × BTC 市价)
      kind: "spot",
      tokenKey: BTC_TOKEN_KEY,
      meta: { pendingSats, ...extra } satisfies BitcoinMeta,
    },
  ];
}

// Blockbook xpub 响应 → 分布(仅非零)+ 收款指引(lastUsed 外部最大已用;next 本地派生其后两个)。
function buildXpubMeta(
  ext: string,
  script: ScriptType,
  tokens: XpubToken[],
): { addresses: BitcoinAddress[]; receive: BitcoinReceive } {
  const addresses: BitcoinAddress[] = [];
  let lastExternal: { index: number; address: string } | null = null;

  for (const t of tokens) {
    const parsed = parsePath(t.path);
    if (!parsed) continue;
    const balanceSats = toSats(t.balance);
    if (balanceSats > 0) {
      addresses.push({
        address: t.name,
        path: t.path,
        chain: parsed.chain === 0 ? "receive" : "change",
        balanceSats,
        pendingSats: 0, // Blockbook 不给逐地址未确认;账户级 pending 走顶层
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

  return { addresses, receive: { lastUsed: lastExternal, next } };
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
  const { addresses, receive } = buildXpubMeta(ext, script, res.tokens ?? []);
  return toBtcBalances(toSats(res.balance), toSats(res.unconfirmedBalance), { addresses, receive });
}

// 账户 creds 形状(schema 归 accountType 层;scriptType 为可选枚举)。
type BtcCreds = { identifier: string; scriptType?: ScriptType };

export const bitcoinProvider = defineProvider({
  async fetchBalances(ctx: FetchContext<BtcCreds>): Promise<Balance[]> {
    const id = ctx.creds.identifier;
    const client = createBlockbookClient();
    try {
      if (isExtendedPubkey(id)) return await fetchXpub(client, id, ctx.creds.scriptType);
      const res = await client.getAddress(id);
      return toBtcBalances(toSats(res.balance), toSats(res.unconfirmedBalance));
    } catch (err) {
      throw toProviderError(err);
    }
  },

  // 账户 liveness:地址模式打地址端点;xpub 模式造 token 打 xpub 端点(顺带校验扩展公钥可解析)。任何失败 → false。
  async validateAccount(ctx: FetchContext<BtcCreds>): Promise<boolean> {
    const id = ctx.creds.identifier;
    const client = createBlockbookClient();
    try {
      if (isExtendedPubkey(id)) {
        await client.getXpub(blockbookXpubParam(id, effectiveScript(id, ctx.creds.scriptType)), {
          details: "basic",
        });
      } else {
        await client.getAddress(id);
      }
      return true;
    } catch {
      return false;
    }
  },
});

// 自描述清单(ADR 0009)。公共 Blockbook 实例,无全局设置,开箱即用。
export const entries: ProviderEntry[] = [
  {
    manifest: {
      id: "bitcoin-blockbook",
      accountType: "onchain_bitcoin",
      dataSource: "blockbook",
      configSchema: [],
      defaultEnabled: true,
    },
    create: () => bitcoinProvider,
  },
];
