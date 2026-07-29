import { ProviderError } from "@folio/connectors-basic";
import { describe, expect, it } from "vitest";
import { DUST_USD } from "../src/constants";
import { parseChainIds, parseProtocols, parseTokens } from "../src/parse";
import type { RabbyChain, RabbyProtocol, RabbyToken } from "../src/types";
import tokenList from "./fixtures/cache-token-list.json";
import chainList from "./fixtures/chain-list.json";
import protocolList from "./fixtures/complex-protocol-list.json";

// fixture 是真实响应裁出来的(行原样保留,只挑少数几行),每行为覆盖一条规则而存在:
//   eth ETH  原生币,大额        → 留,evm:1/native
//   op  ETH  另一条链的原生币     → 留,evm:10/native(证明 namer 跟着链走)
//   op  OPP  合约币 $8177        → 留,evm:10/contract:0x…
//   bsc vitalik.eth 合约币 $16214 → 留
//   eth DOJE price=0            → 丢(上游认不出价的垃圾币的典型形状)
//   op  TUX  $0.0025            → 丢(不足 dust 闸)
//   op  TKN  $0.2629            → 留(证明闸的边界不是"只留大额")
//   bb  BB   原生币 ≈$0         → 留(原生币豁免 dust 闸)
const chains = chainList as RabbyChain[];
const tokens = tokenList as RabbyToken[];
const protocols = protocolList as RabbyProtocol[];

describe("parseChainIds", () => {
  it("slug → community_id(就是规范 EVM chainId)", () => {
    const ids = parseChainIds(chains);
    expect(ids.eth).toBe(1);
    expect(ids.op).toBe(10);
    expect(ids.bsc).toBe(56);
    expect(ids.bb).toBe(6001);
  });

  it("缺 id 或 community_id 的条目跳过,不产半个映射", () => {
    const ids = parseChainIds([{ id: "x" }, { community_id: 7 }, { id: "ok", community_id: 8 }]);
    expect(ids).toEqual({ ok: 8 });
  });
});

describe("parseTokens", () => {
  const ids = parseChainIds(chains);

  it("原生币 → native ref,合约币 → contract ref", () => {
    const rows = parseTokens(tokens, ids);
    const refs = rows.map((r) => r.tokenRef);
    expect(refs).toContain("evm:1/native"); // eth ETH
    expect(refs).toContain("evm:10/native"); // op ETH —— namer 跟着链走
    expect(refs).toContain("evm:6001/native"); // bb BB
    expect(refs.some((r) => r.startsWith("evm:10/contract:0x"))).toBe(true);
  });

  it("value = amount × price(上游不给 usd_value)", () => {
    const rows = parseTokens(tokens, ids);
    const eth = rows.find((r) => r.tokenRef === "evm:1/native");
    expect(eth?.amount).toBeCloseTo(6.632200430120325, 12);
    expect(eth?.price).toBeCloseTo(1908.68, 6);
    expect(eth?.value).toBeCloseTo(6.632200430120325 * 1908.68, 6);
  });

  it("dust 闸:不足 $0.01 的合约币丢掉,价格为 0 的也丢", () => {
    const rows = parseTokens(tokens, ids);
    expect(rows.some((r) => r.symbol === "TUX")).toBe(false); // $0.0025
    expect(rows.some((r) => r.symbol === "DOJE")).toBe(false); // price 0
    expect(rows.some((r) => r.symbol === "TKN")).toBe(true); // $0.2629,刚好过闸
  });

  it("原生币豁免 dust 闸 —— 再小也留(否则某条链会整个从视野消失)", () => {
    const rows = parseTokens(tokens, ids);
    const bb = rows.find((r) => r.tokenRef === "evm:6001/native");
    expect(bb).toBeDefined();
    expect(bb?.value).toBeLessThan(DUST_USD);
  });

  it("全是 spot,且不带 meta(Spot schema 没有 meta 字段)", () => {
    for (const r of parseTokens(tokens, ids)) {
      expect(r.kind).toBe("spot");
      expect(r).not.toHaveProperty("meta");
    }
  });

  it("带上 name / logo 喂参考层", () => {
    const rows = parseTokens(tokens, ids);
    const opp = rows.find((r) => r.symbol === "OPP");
    expect(opp?.name).toBeTruthy();
  });

  it("scam / suspicious 直接丢", () => {
    const rows = parseTokens(
      [
        { id: "0x1", chain: "eth", symbol: "S", amount: 1, price: 100, is_scam: true },
        { id: "0x2", chain: "eth", symbol: "T", amount: 1, price: 100, is_suspicious: true },
        { id: "0x3", chain: "eth", symbol: "U", amount: 1, price: 100 },
      ],
      ids,
    );
    expect(rows.map((r) => r.symbol)).toEqual(["U"]);
  });

  it("没有 symbol 的行跳过(产不出能看的行)", () => {
    expect(parseTokens([{ id: "0x1", chain: "eth", amount: 1, price: 100 }], ids)).toEqual([]);
  });

  it("拿不到数字 chainId → 抛错,绝不退化成 slug 兜底形", () => {
    // 失败即不产:产一个 `chain:op` 之类的分叉标识会污染代币索引,比整轮失败重试糟得多。
    expect(() =>
      parseTokens([{ id: "0x1", chain: "nope", symbol: "X", amount: 1, price: 1 }], ids),
    ).toThrow(ProviderError);
  });
});

describe("parseProtocols", () => {
  const ids = parseChainIds(chains);

  it("supply 腿为正,borrow 腿 amount 取负、单价保持正", () => {
    // 符号只能挂在 amount 上:下游 revalue 会用 正量 × 正价 重算,挂在 value 上会被抹掉。
    const rows = parseProtocols(protocols, ids);
    const borrow = rows.find((r) => r.amount < 0);
    expect(borrow).toBeDefined();
    expect(borrow?.symbol).toBe("USDT");
    expect(borrow?.price).toBeGreaterThan(0);
    expect(borrow?.value).toBeLessThan(0);
    expect(borrow?.value).toBeCloseTo(borrow!.amount * borrow!.price!, 10);

    const supply = rows.find((r) => r.symbol === "WBTC");
    expect(supply?.amount).toBeGreaterThan(0);
    expect(supply?.value).toBeGreaterThan(0);
  });

  it("全是 defi,meta 带 protocol + positionType", () => {
    const rows = parseProtocols(protocols, ids);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.kind).toBe("defi");
    const lending = rows.find((r) => r.symbol === "WBTC");
    expect(lending?.meta.positionType).toBe("Lending");
    expect(lending?.meta.protocol).toBeTruthy();
  });

  it("认单数的 `token` 形状(老仓库 types.ts 漏了它)", () => {
    const rows = parseProtocols(protocols, ids);
    expect(rows.some((r) => r.meta.positionType === "Vesting")).toBe(true);
  });

  it("reward 腿按正数产(是待领收益,不是负债)", () => {
    const rows = parseProtocols(protocols, ids);
    // fixture 里 compound3 带 reward_token_list
    expect(
      rows.filter((r) => r.meta.positionType === "Lending" && r.amount > 0).length,
    ).toBeGreaterThan(1);
  });

  it("defi 行不过 dust 闸 —— 协议仓位本就是被筛过的,再筛会让净值对不上账", () => {
    const tiny: RabbyProtocol[] = [
      {
        id: "p",
        name: "P",
        portfolio_item_list: [
          {
            name: "Lending",
            detail: {
              supply_token_list: [{ id: "0x1", chain: "eth", symbol: "X", amount: 1e-9, price: 1 }],
            },
          },
        ],
      },
    ];
    expect(parseProtocols(tiny, ids)).toHaveLength(1);
  });

  it("拿不到数字 chainId → 抛错", () => {
    const bad: RabbyProtocol[] = [
      {
        id: "p",
        portfolio_item_list: [
          {
            name: "L",
            detail: {
              supply_token_list: [{ id: "0x1", chain: "nope", symbol: "X", amount: 1, price: 1 }],
            },
          },
        ],
      },
    ];
    expect(() => parseProtocols(bad, ids)).toThrow(ProviderError);
  });
});

describe("对账 —— 上游自己的总值是现成的自检", () => {
  // 实测(vitalik 地址):Σ钱包 + Σ协议净值 = $897,486 vs 上游 total_usd_value = $897,526,差 -0.0%。
  // 说明 cache_token_list 只有钱包持仓、complex_protocol_list 只有协议持仓,两个相加不重复计。
  // 这里用 fixture 做的是**弱版本**断言:两边产出的 tokenRef 允许重合(同一个币可以既在钱包又在协议里),
  // 但两个解析器都不许把对方的行也产出来。
  it("钱包解析不产 defi 行,协议解析不产 spot 行", () => {
    const ids = parseChainIds(chains);
    expect(parseTokens(tokens, ids).every((r) => r.kind === "spot")).toBe(true);
    expect(parseProtocols(protocols, ids).every((r) => r.kind === "defi")).toBe(true);
  });
});
