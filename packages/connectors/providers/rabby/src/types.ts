// Rabby(实为 DeBank 后端)响应的**最小形状** —— 只声明我们真正取用的字段。
// api.rabby.io 没有公开契约,所以这里刻意窄:字段越少,上游改形状时被牵连的面越小。

// /v1/chain/list —— `community_id` 就是规范 EVM chainId(抽查 15 条全中:eth=1 bsc=56 arb=42161 …)。
export interface RabbyChain {
  id?: string; // 链 slug,与持仓行的 `chain` 同口径
  community_id?: number;
}

// /v1/user/cache_token_list 的一行。**只收地址、一次回全链**,是替代 Zerion positions 的那一发。
// 注意:没有 usd_value 字段 —— 价值要自己 amount × price 算。
export interface RabbyToken {
  id?: string; // 合约地址(0x…),**原生 gas 币时等于链 slug**
  chain?: string;
  symbol?: string;
  name?: string;
  logo_url?: string | null;
  amount?: number;
  price?: number | null; // 上游认不出价的币给 0(不是 null)——实测 2302 行里 814 行如此
  is_scam?: boolean;
  is_suspicious?: boolean;
}

// /v1/user/complex_protocol_list —— 同样一次回全链的 DeFi 仓位。
interface RabbyProtocolItem {
  name?: string; // 仓位类型的展示名:Lending / Vesting / Liquidity Pool …
  detail?: {
    // 实测出现过的形状(fixture 钉的):三个列表 + 单数的 `token`。
    // 其余键(description / health_rate / unlock_at / end_at)是纯展示,不产行。
    supply_token_list?: RabbyToken[];
    reward_token_list?: RabbyToken[];
    borrow_token_list?: RabbyToken[]; // 负债腿。**amount 是正数**,取负由我们做
    token?: RabbyToken;
  };
}

export interface RabbyProtocol {
  id?: string;
  name?: string;
  logo_url?: string; // 协议顶层 logo(与 per-token logo_url 不同层);#126 采集为 meta.protocolLogo
  portfolio_item_list?: RabbyProtocolItem[];
}
