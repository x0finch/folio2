import {
  type Balance,
  type BalanceProvider,
  buildTokenKey,
  defineProvider,
  ProviderError,
} from "@folio/balances-basic";
import { z } from "zod";
import {
  ADDRESS_PATH,
  BTC_ADDRESS_RE,
  ESPLORA_BASE_DEFAULT,
  EXT_PUBKEY_RE,
  SATS_PER_BTC,
} from "./constants";
import { ensureOk, esploraGet } from "./source";

// @folio/balances-provider-bitcoin —— 只读 Bitcoin(onchain_bitcoin)。阶段 1:单地址模式。
// identifier(public)走 ctx.creds.identifier;数据源 Esplora(mempool.space 公共实例),免密钥。零依赖,原生 fetch。
// (自托管节点覆写 BITCOIN_ESPLORA_BASE 留阶段 2 连同 app 侧接线一起上,阶段 1 不留惰性 plumbing。)
// 值不在此算:provider 只产 amount(已确认 BTC),value=0 交给 app 的 revalue 盯市(token 层唯一价源)。

// BTC 身份键:chain:bitcoin/native:btc(仅作身份 + 平台归属 → "Bitcoin")。
export const BTC_TOKEN_KEY = buildTokenKey({ chain: "bitcoin", native: true, symbol: "BTC" });

// 挂在那条 BTC Balance 上的 meta(阶段 1 仅未确认额;阶段 2 叠加派生分布/收款地址)。
export interface BitcoinMeta {
  pendingSats: number; // 账户净未确认(± mempool)
}

// Esplora /address/:addr 的最小形状(仅取用到的字段)。
interface AddressStats {
  funded_txo_sum?: number;
  spent_txo_sum?: number;
}
export interface AddressResponse {
  chain_stats?: AddressStats;
  mempool_stats?: AddressStats;
}

const netSats = (s?: AddressStats): number => (s?.funded_txo_sum ?? 0) - (s?.spent_txo_sum ?? 0);

// 纯解析:Esplora 地址响应 → Balance[]。与 IO 分离,便于 golden test。
// 已确认 = chain_stats 净额(≥1 确认,进权威 amount);未确认 = mempool_stats 净额(走 meta,不进值)。
// 既无已确认又无未确认 → 空(无持仓);仅未确认(confirmed=0,pending≠0)仍产一行(amount=0 + pending 徽标)。
export function addressToBalances(res: AddressResponse): Balance[] {
  const confirmedSats = netSats(res.chain_stats);
  const pendingSats = netSats(res.mempool_stats);
  if (confirmedSats <= 0 && pendingSats === 0) return [];
  return [
    {
      symbol: "BTC",
      amount: confirmedSats / SATS_PER_BTC,
      value: 0, // 交给 revalue 盯市(amount × BTC 市价)
      kind: "spot",
      tokenKey: BTC_TOKEN_KEY,
      meta: { pendingSats } satisfies BitcoinMeta,
    },
  ];
}

const isExtendedPubkey = (id: string): boolean => EXT_PUBKEY_RE.test(id);

export const bitcoinProvider = defineProvider({
  accountType: "onchain_bitcoin",
  inputs: [
    {
      key: "identifier",
      type: "public",
      label: "Bitcoin Address",
      desc: "BTC address (1…/3…/bc1…)",
      validator: z.string().regex(BTC_ADDRESS_RE, "expected a BTC address"),
    },
  ],

  async fetchBalances(ctx): Promise<Balance[]> {
    const id = ctx.creds.identifier;
    // 阶段 2 才支持扩展公钥派生;阶段 1 明确不支持(validateCredentials 也拒 → 双保险)。
    if (isExtendedPubkey(id)) {
      throw new ProviderError("UNSUPPORTED", "extended pubkey not yet supported");
    }
    const res = await esploraGet(ESPLORA_BASE_DEFAULT, ADDRESS_PATH(id));
    ensureOk(res);
    let json: AddressResponse;
    try {
      json = (await res.json()) as AddressResponse;
    } catch (cause) {
      throw new ProviderError("PARSE_ERROR", "esplora returned invalid JSON", { cause });
    }
    return addressToBalances(json);
  },

  // 轻量探活:打地址端点,res.ok 即可(地址格式已由 validateCredentials 保证)。任何失败 → false。
  async validate(ctx): Promise<boolean> {
    const id = ctx.creds.identifier;
    if (isExtendedPubkey(id)) return false;
    try {
      const res = await esploraGet(ESPLORA_BASE_DEFAULT, ADDRESS_PATH(id));
      return res.ok;
    } catch {
      return false;
    }
  },
});

// 与方案 A 摊平约定一致:sync 收集各包的 providers 数组后 .flat() 传入 buildRegistry。
export const providers: BalanceProvider[] = [bitcoinProvider];
