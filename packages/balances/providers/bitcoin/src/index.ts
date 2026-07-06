import {
  type Balance,
  type BalanceProvider,
  type BitcoinAddress,
  type BitcoinMeta,
  type BitcoinReceive,
  buildTokenKey,
  defineProvider,
  ProviderError,
} from "@folio/balances-basic";
import {
  BitcoinDeriveError,
  deriveAddresses,
  isScriptType,
  recommendedScript,
  SCRIPT_TYPES,
} from "@folio/bitcoin-derive";
import {
  type AddressResponse,
  createMempoolClient,
  type MempoolClient,
  MempoolError,
} from "@folio/mempool-client";
import { z } from "zod";
import {
  ADDRESS_CAP,
  BTC_ADDRESS_RE,
  ESPLORA_BASE_ENV,
  EXT_PUBKEY_FULL_RE,
  EXT_PUBKEY_RE,
  GAP_LIMIT,
  SATS_PER_BTC,
} from "./constants";

export type { ScriptType } from "@folio/bitcoin-derive";
export { recommendedScript, SCRIPT_TYPES } from "@folio/bitcoin-derive";

// @folio/balances-provider-bitcoin —— 只读 Bitcoin(onchain_bitcoin)。地址 + xpub 两模式。
// 只做【整合】:余额取数走 @folio/mempool-client(Esplora),扩展公钥派生走 @folio/bitcoin-derive(generator),
// 本包串起 gap 扫描 + 值/meta 组装 + 契约映射(其错误 → ProviderError)。
// identifier(public)= BTC 地址或扩展公钥;扩展公钥用 scriptType(public)选脚本类型。自托管节点经
// globalKeys[BITCOIN_ESPLORA_BASE] 覆写(传给 client baseUrl)。值不在此算:provider 只产已确认 BTC amount
// (value=0),交 app 的 revalue 盯市(token 层唯一价源)。

// BTC 身份键:chain:bitcoin/native:btc(仅作身份 + 平台归属 → "Bitcoin")。
export const BTC_TOKEN_KEY = buildTokenKey({ chain: "bitcoin", native: true, symbol: "BTC" });

const netSats = (s?: { funded_txo_sum?: number; spent_txo_sum?: number }): number =>
  (s?.funded_txo_sum ?? 0) - (s?.spent_txo_sum ?? 0);
// used 判定:曾收到过(已确认或在途)→ 用于 gap 扫描是否继续(在途收款也算用过)。
const isUsed = (res: AddressResponse): boolean =>
  (res.chain_stats?.funded_txo_count ?? 0) > 0 || (res.mempool_stats?.funded_txo_count ?? 0) > 0;

// 已确认净额 → amount(BTC);未确认净额 → meta.pendingSats(不进权值)。
// 既无已确认又无未确认且未截断 → 空(无持仓);仅未确认仍产一行(amount=0 + pending 徽标)。
function toBtcBalances(
  confirmedSats: number,
  pendingSats: number,
  extra?: Partial<Omit<BitcoinMeta, "pendingSats">>,
): Balance[] {
  if (confirmedSats <= 0 && pendingSats === 0 && !extra?.truncated) return [];
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

// 纯解析:单地址 Esplora 响应 → Balance[]。与 IO 分离,便于 golden test。
export function addressToBalances(res: AddressResponse): Balance[] {
  return toBtcBalances(netSats(res.chain_stats), netSats(res.mempool_stats));
}

const isExtendedPubkey = (id: string): boolean => EXT_PUBKEY_RE.test(id);

// 派生库/客户端的错误 → provider 契约(sync 据 ProviderError 重试)。
function toProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof MempoolError) {
    return new ProviderError(err.code, err.message, { retryAfterMs: err.retryAfterMs, cause: err });
  }
  if (err instanceof BitcoinDeriveError) {
    return new ProviderError("INVALID_CREDENTIALS", err.message, { cause: err });
  }
  return new ProviderError("UPSTREAM_ERROR", "bitcoin provider failed", { cause: err });
}

interface ScanResult {
  confirmedSats: number;
  pendingSats: number;
  truncated: boolean;
  addresses: BitcoinAddress[]; // 仅非零
  receive: BitcoinReceive;
}

// xpub gap 扫描:把 bitcoin-derive 的地址 generator 与 mempool-client 的 getAddress 组合。
// 外部(0)+ 找零(1)两链,各连续 GAP_LIMIT 个未用即停;两链合计超 ADDRESS_CAP 提前停并标 truncated。
// 逐地址顺序查(gap 逻辑需前一地址结果决定是否续);汇总净额 + 产分布 + 收款指引。
async function scanXpub(
  client: MempoolClient,
  ext: string,
  scriptType: string | undefined,
): Promise<ScanResult> {
  const script = isScriptType(scriptType) ? scriptType : recommendedScript(ext);
  let confirmedSats = 0;
  let pendingSats = 0;
  let scanned = 0;
  let truncated = false;
  const addresses: BitcoinAddress[] = [];
  const external: { index: number; address: string; used: boolean }[] = []; // 外部链按下标序,算收款指引

  for (const chain of [0, 1]) {
    let gap = 0;
    // 同步 generator → for...of;惰性,只派生扫到的。网络 await 在体内,与迭代无关(故非 for await)。
    for (const { index, address, path } of deriveAddresses(ext, script, chain)) {
      if (scanned >= ADDRESS_CAP) {
        truncated = true;
        break;
      }
      const res = await client.getAddress(address);
      const confirmed = netSats(res.chain_stats);
      const pending = netSats(res.mempool_stats);
      confirmedSats += confirmed;
      pendingSats += pending;
      if (confirmed > 0 || pending !== 0) {
        addresses.push({
          address,
          path,
          chain: chain === 0 ? "receive" : "change",
          balanceSats: confirmed,
          pendingSats: pending,
        });
      }
      if (chain === 0) external.push({ index, address, used: isUsed(res) });
      gap = isUsed(res) ? 0 : gap + 1;
      scanned++;
      if (gap >= GAP_LIMIT) break; // 连续 GAP_LIMIT 个未用 → 该链到头
    }
    if (truncated) break;
  }

  // 收款指引:lastUsed = 外部链最大已用下标;next = 其后未用的头两个(external 已按下标序)。
  const used = external.filter((e) => e.used);
  const lastUsed = used.length > 0 ? used[used.length - 1] : null;
  const lastIndex = lastUsed ? lastUsed.index : -1;
  const next = external
    .filter((e) => e.index > lastIndex && !e.used)
    .slice(0, 2)
    .map((e) => ({ index: e.index, address: e.address }));

  return {
    confirmedSats,
    pendingSats,
    truncated,
    addresses,
    receive: {
      lastUsed: lastUsed ? { index: lastUsed.index, address: lastUsed.address } : null,
      next,
    },
  };
}

export const bitcoinProvider = defineProvider({
  accountType: "onchain_bitcoin",
  usesGlobalKeys: [ESPLORA_BASE_ENV], // 可选自托管 base;不设/空则用公共默认
  inputs: [
    {
      key: "identifier",
      type: "public",
      label: "Bitcoin address or xpub",
      desc: "address (1…/3…/bc1…) or xpub/ypub/zpub",
      validator: z.string().refine((v) => BTC_ADDRESS_RE.test(v) || EXT_PUBKEY_FULL_RE.test(v), {
        message: "expected a BTC address or extended public key",
      }),
    },
    {
      // 仅扩展公钥模式用(单地址忽略);缺省由 recommendedScript 按前缀兜底。
      key: "scriptType",
      type: "public",
      label: "Address type",
      validator: z.enum(SCRIPT_TYPES).optional(),
    },
  ],

  async fetchBalances(ctx): Promise<Balance[]> {
    const id = ctx.creds.identifier;
    const client = createMempoolClient({ baseUrl: ctx.globalKeys[ESPLORA_BASE_ENV] });
    try {
      if (isExtendedPubkey(id)) {
        const { confirmedSats, pendingSats, truncated, addresses, receive } = await scanXpub(
          client,
          id,
          ctx.creds.scriptType,
        );
        return toBtcBalances(confirmedSats, pendingSats, { truncated, addresses, receive });
      }
      return addressToBalances(await client.getAddress(id));
    } catch (err) {
      throw toProviderError(err);
    }
  },

  // 轻量探活:地址模式打地址端点;xpub 模式派生首地址探端点(顺带校验扩展公钥可解析)。任何失败 → false。
  async validate(ctx): Promise<boolean> {
    const id = ctx.creds.identifier;
    const client = createMempoolClient({ baseUrl: ctx.globalKeys[ESPLORA_BASE_ENV] });
    try {
      let probe = id;
      if (isExtendedPubkey(id)) {
        const script = isScriptType(ctx.creds.scriptType)
          ? ctx.creds.scriptType
          : recommendedScript(id);
        const first = deriveAddresses(id, script, 0).next().value;
        if (!first) return false;
        probe = first.address;
      }
      await client.getAddress(probe);
      return true;
    } catch {
      return false;
    }
  },
});

// 与方案 A 摊平约定一致:sync 收集各包的 providers 数组后 .flat() 传入 buildRegistry。
export const providers: BalanceProvider[] = [bitcoinProvider];
