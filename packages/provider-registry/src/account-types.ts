import type { AccountType, ProviderInput } from "@folio/balances-basic";
import { SCRIPT_TYPES } from "@folio/bitcoin-derive";
import { z } from "zod";

// accountType 数据约束层(ADR 0009 层 1):每个账户类型声明它的【账户输入 schema】+ 产出的数据形状。
// 这是"这个类型的账户长什么样"的唯一事实源 —— 与用哪个 provider 取数无关(换 provider,账户输入不变)。
// provider(层 2)只管自己的全局 config + 怎么取数,不再声明账户输入。
// 校验器就地内联(EVM/BTC 地址正则等 —— 账户输入的形状约束属本层,与 provider 取数逻辑分离)。

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BTC_ADDRESS_RE = /^(bc1[a-z0-9]{11,87}|[13][a-km-zA-HJ-NP-Z1-9]{25,39})$/;
const EXT_PUBKEY_FULL_RE = /^(xpub|ypub|zpub)[1-9A-HJ-NP-Za-km-z]{100,115}$/;

const evmAddress: ProviderInput = {
  key: "identifier",
  type: "public",
  label: "EVM Address",
  desc: "0x + 40 hex",
  validator: z.string().regex(EVM_ADDRESS_RE, "expected 0x + 40 hex"),
};
const walletAddress: ProviderInput = {
  key: "identifier",
  type: "public",
  label: "Wallet Address",
  validator: z.string().trim().min(1),
};
// CEX per-account 凭据(输入 5:属账户,非 provider 全局 config)。apiKey=semi(明文走 header)。
const cexKeys: ProviderInput[] = [
  { key: "apiKey", type: "semi", label: "API Key", validator: z.string().trim().min(1) },
  { key: "secret", type: "secret", label: "API Secret", validator: z.string().trim().min(1) },
];

export interface AccountTypeSpec {
  // 账户级输入(表单渲染 + 加账户校验;creds 形状由其校验输出决定)。
  readonly accountInputs: readonly ProviderInput[];
  // 该类型产出的数据 facet(当前只有 balance;transaction 将来加)。
  readonly facets: readonly ("balance" | "transaction")[];
}

// 类型 → 约束。缺席的类型 = 尚不支持。provider 经 manifest.accountType 注册进这些类型(层 2)。
export const ACCOUNT_TYPE_SPECS: Partial<Record<AccountType, AccountTypeSpec>> = {
  onchain_evm: { accountInputs: [evmAddress], facets: ["balance"] },
  onchain_solana: { accountInputs: [walletAddress], facets: ["balance"] },
  onchain_sui: { accountInputs: [walletAddress], facets: ["balance"] },
  onchain_cosmos: { accountInputs: [walletAddress], facets: ["balance"] },
  onchain_bitcoin: {
    accountInputs: [
      {
        key: "identifier",
        type: "public",
        label: "Bitcoin address or xpub",
        desc: "address (1…/3…/bc1…) or xpub/ypub/zpub",
        validator: z.string().refine((v) => BTC_ADDRESS_RE.test(v) || EXT_PUBKEY_FULL_RE.test(v), {
          message: "expected a BTC address or extended public key",
        }),
      },
      // 仅裸 xpub 用(zpub/ypub 前缀已定);缺省由 provider 的 recommendedScript 兜底。
      {
        key: "scriptType",
        type: "public",
        label: "Address type",
        validator: z.enum(SCRIPT_TYPES).optional(),
      },
    ],
    facets: ["balance"],
  },
  exchange_binance: { accountInputs: cexKeys, facets: ["balance"] },
  exchange_okx: {
    accountInputs: [
      ...cexKeys,
      {
        key: "passphrase",
        type: "secret",
        label: "Passphrase",
        validator: z.string().trim().min(1),
      },
    ],
    facets: ["balance"],
  },
  perp_hyperliquid: { accountInputs: [evmAddress], facets: ["balance"] },
  manual: {
    accountInputs: [
      { key: "symbol", type: "public", label: "Symbol", validator: z.string().trim().min(1) },
      { key: "amount", type: "public", label: "Amount", validator: z.coerce.number() },
      { key: "unitPrice", type: "public", label: "Unit price (USD)", validator: z.coerce.number() },
      {
        key: "identifier",
        type: "public",
        label: "CoinGecko ID",
        validator: z.string().optional(),
      },
      { key: "fixed", type: "public", label: "Lock fixed value", validator: z.string().optional() },
    ],
    facets: ["balance"],
  },
};

export function accountInputs(type: AccountType): readonly ProviderInput[] {
  return ACCOUNT_TYPE_SPECS[type]?.accountInputs ?? [];
}
