import type { TokenRecord } from "@folio/oracle-basic";
import { describe, expect, it } from "vitest";
import { ZERO_DISPLAY_USD } from "../src/lib/core/account-view";
import {
  defiTokenId,
  displayTokenId,
  displayTokenIds,
  fungibleTokenId,
  perpTokenId,
  refreshableTokenIds,
  toEnrichment,
} from "../src/lib/core/tokens";

// 读端那几道门:回答「这一行参不参与」,答案就是它的 token_id 或 null。
// 认定在写快照时由 mint 定死(ADR 0021 / #201),所以这里不再造 `AssetRef` 让参考层现场解析。
const rec = (over: Partial<TokenRecord> = {}): TokenRecord => ({
  id: "tk-btc",
  ref: "coingecko/issued:bitcoin",
  symbol: "BTC",
  name: "Bitcoin",
  infoStale: false,
  ...over,
});

describe("fungibleTokenId(估值现推的门)", () => {
  it("现货带 token_id → 给出来", () => {
    expect(fungibleTokenId({ kind: "spot", tokenId: "tk-1" })).toBe("tk-1");
  });

  it("kind 走 viewKind 归一 —— 遗留的 manual / bitcoin 也算同质", () => {
    expect(fungibleTokenId({ kind: "manual", tokenId: "tk-1" })).toBe("tk-1");
    expect(fungibleTokenId({ kind: "bitcoin", tokenId: "tk-1" })).toBe("tk-1");
  });

  it("没有 token_id(旧快照 / 手记现造的行)→ null,不参与", () => {
    expect(fungibleTokenId({ kind: "spot" })).toBeNull();
    expect(fungibleTokenId({ kind: "spot", tokenId: null })).toBeNull();
  });

  it("defi / perp 不进这个门(它们的价值走 typed meta)", () => {
    expect(fungibleTokenId({ kind: "defi", tokenId: "tk-1" })).toBeNull();
    expect(fungibleTokenId({ kind: "perp", tokenId: "tk-1" })).toBeNull();
  });
});

describe("defiTokenId(只喂展示富化,不喂估值)", () => {
  it("defi 行带 token_id → 给出来(协议行的 24h 聚合要它)", () => {
    expect(defiTokenId({ kind: "defi", tokenId: "tk-1" })).toBe("tk-1");
  });

  it("非 defi → null", () => {
    expect(defiTokenId({ kind: "spot", tokenId: "tk-1" })).toBeNull();
  });
});

describe("perpTokenId(只喂展示富化,不喂估值)", () => {
  it("永续仓位行带 token_id → 给出来(账户行叠标要标的币的图,#133)", () => {
    expect(perpTokenId({ kind: "perp_position", tokenId: "tk-1" })).toBe("tk-1");
  });

  it("**权益行不在内** —— 它是抵押物,不是「持有什么」", () => {
    expect(perpTokenId({ kind: "perp_equity", tokenId: "tk-1" })).toBeNull();
  });

  it("非永续 → null", () => {
    expect(perpTokenId({ kind: "spot", tokenId: "tk-1" })).toBeNull();
  });
});

describe("displayTokenId / displayTokenIds(展示富化的统一门)", () => {
  // enrich 与 refreshStalePrices 必须同门:enrich 标了 stale 而 refresh 够不到的行,
  // 会让 pricesStale 永远清不掉、客户端每次加载空转一次刷新(code review #2)。
  it("同质 ∪ defi ∪ 永续仓位都算展示门内", () => {
    expect(displayTokenId({ kind: "spot", tokenId: "tk-1" })).toBe("tk-1");
    expect(displayTokenId({ kind: "defi", tokenId: "tk-2" })).toBe("tk-2");
    // #133:永续仓位进门,它的图就是靠「刷」那一半取回来的(连接器不报 logo)。
    expect(displayTokenId({ kind: "perp_position", tokenId: "tk-3" })).toBe("tk-3");
  });

  it("永续**权益**行仍在门外(抵押物,叠标不显示,也没人要它的图)", () => {
    expect(displayTokenId({ kind: "perp_equity", tokenId: "tk-4" })).toBeNull();
  });

  it("批量取 id 会去重,也会滤掉没身份的行", () => {
    expect(
      displayTokenIds([
        { kind: "spot", tokenId: "tk-1" },
        { kind: "spot", tokenId: "tk-1" }, // 同币多笔持仓很常见
        { kind: "spot" }, // 没身份
        { kind: "defi", tokenId: "tk-2" },
      ]),
    ).toEqual(["tk-1", "tk-2"]);
  });
});

// #245 Part 2:数百币的钱包绝大多数是几乎 $0 的空投/貔貅币,刷价/刷图之前按值砍掉 dust ——
// 省 CGK 配额、也避免 id 太多把 GET 的 URL 撑爆(414)。判据 = 展示那条线(不展示的就不刷)。
describe("refreshableTokenIds(刷前跳过 dust)", () => {
  it("值 ≥ 阈值 → 留;dust(几乎 $0)→ 砍", () => {
    expect(
      refreshableTokenIds([
        { kind: "spot", tokenId: "tk-real", usdValue: 1200 },
        { kind: "spot", tokenId: "tk-dust", usdValue: 0.0001 },
        { kind: "spot", tokenId: "tk-zero", usdValue: 0 },
      ]),
    ).toEqual(["tk-real"]);
  });

  it("同一 token 多笔 → 按聚合值判(单笔 dust 但合起来够 → 留)", () => {
    const half = ZERO_DISPLAY_USD * 0.6; // 单笔低于阈值,两笔加起来越过
    expect(
      refreshableTokenIds([
        { kind: "spot", tokenId: "tk-1", usdValue: half },
        { kind: "spot", tokenId: "tk-1", usdValue: half },
      ]),
    ).toEqual(["tk-1"]);
  });

  it("defi 行同样计入(展示门内),按值过滤", () => {
    expect(
      refreshableTokenIds([
        { kind: "defi", tokenId: "tk-defi", usdValue: 500 },
        { kind: "defi", tokenId: "tk-defi-dust", usdValue: 0.001 },
      ]),
    ).toEqual(["tk-defi"]);
  });

  // 聚合取「绝对值之和」而非「和的绝对值」:同一 token 现货(+)+ defi 借款腿(−,同 tokenId)对冲后
  // 净值≈0,但两条腿都要这个价 —— 绝不能因净值抵消当它不值钱、不刷(否则标脏侧只见现货腿标脏、
  // 刷价侧净值 0 跳过 → 客户端永远空转。code-review 抓到的坑)。
  it("现货 + defi 借款腿对冲(净值≈0)→ 仍留(绝对值之和,不是和的绝对值)", () => {
    expect(
      refreshableTokenIds([
        { kind: "spot", tokenId: "tk-usdc", usdValue: 500 },
        { kind: "defi", tokenId: "tk-usdc", usdValue: -500 }, // 借款腿:同 tokenId、负值
      ]),
    ).toEqual(["tk-usdc"]);
  });

  it("没身份的行不参与(与 displayTokenIds 同门)", () => {
    expect(refreshableTokenIds([{ kind: "spot", usdValue: 999 }])).toEqual([]);
  });

  // **这条钉的是三门同源**(#133):展示门放进永续仓位之后,刷价那侧必须跟着放进来 ——
  // 富化标了脏而刷价够不到的行会让 pricesStale 永远清不掉、客户端每次进页空转一次刷新。
  // 两侧都是按 `displayTokenId` 筛的,所以这件事是结构上成立的,这条只是别让它悄悄退回去。
  it("永续仓位跟着展示门一起进刷价集合(权益行不进)", () => {
    expect(
      refreshableTokenIds([
        { kind: "perp_position", tokenId: "tk-perp", usdValue: 999 },
        { kind: "perp_equity", tokenId: "tk-equity", usdValue: 5000 },
      ]),
    ).toEqual(["tk-perp"]);
  });

  // 无条件保留③:永续仓位行的 `usdValue` **恒为 0**(仓位不贡献净值,名义值住 meta),
  // 所以按值判尘埃对它没有意义。不豁免的话这一整类永远刷不到 → **永远没有图**
  // (实测:28 个永续币只有 6 个有图,而那 6 个是因为用户在别处也持有它们的现货,图是蹭来的)。
  it("永续仓位 → 无条件保留,哪怕 usdValue 是 0(它结构上就是 0)", () => {
    expect(
      refreshableTokenIds([{ kind: "perp_position", tokenId: "tk-perp", usdValue: 0 }]),
    ).toEqual(["tk-perp"]);
  });

  // 无条件保留①:老调用点只带 BalanceLike、没有 usdValue —— 判不了就别错杀。
  it("usdValue 缺失 → 无条件保留(判不了不错杀)", () => {
    expect(refreshableTokenIds([{ kind: "spot", tokenId: "tk-unknown" }])).toEqual(["tk-unknown"]);
  });

  // 无条件保留②:manual 的 usdValue 是拿(可能冷缓存的)现价现造的,0 常只是「还没定价」。
  // 选了币但没填价的手记币恒为 0 —— 不豁免会被当 dust 永不刷价、永远显 $0。
  it("manual 持仓 → 无条件保留,哪怕值算出来是 0", () => {
    expect(
      refreshableTokenIds([
        { kind: "spot", tokenId: "tk-manual", usdValue: 0, platform: "manual" },
      ]),
    ).toEqual(["tk-manual"]);
  });

  it("阈值可传入(默认 = 展示阈值 ZERO_DISPLAY_USD)", () => {
    const rows = [{ kind: "spot" as const, tokenId: "tk-1", usdValue: 5 }];
    expect(refreshableTokenIds(rows, 10)).toEqual([]); // 抬高阈值 → 被砍
    expect(refreshableTokenIds(rows)).toEqual(["tk-1"]); // 默认阈值 → 留
  });
});

describe("toEnrichment(logo 一律走代理,不直引第三方 CDN)", () => {
  it("上游图 → 代理 URL", () => {
    expect(
      toEnrichment(
        rec({
          logo: "upstream-L",
          providerLogo: "prov-L",
          price: { unitPrice: 65000, change24h: 1.5, marketCapRank: 1, asOf: 0, stale: false },
        }),
      ),
    ).toEqual({
      symbol: "BTC",
      name: "Bitcoin",
      logo: "/api/logo/token/tk-btc",
      unitPrice: 65000,
      change24h: 1.5,
      marketCapRank: 1,
    });
  });

  it("上游还没认出来的币(ref 为 null)只有连接器自带图 → 照样代理", () => {
    expect(toEnrichment(rec({ ref: null, id: "tk-orphan", providerLogo: "prov-L" }))).toEqual({
      symbol: "BTC",
      name: "Bitcoin",
      logo: "/api/logo/token/tk-orphan",
      unitPrice: undefined,
      change24h: undefined,
      marketCapRank: undefined,
    });
  });

  it("一张图都没有 → 不给 logo(客户端显首字母,不发请求)", () => {
    expect(toEnrichment(rec())).toEqual({
      symbol: "BTC",
      name: "Bitcoin",
      logo: undefined,
      unitPrice: undefined,
      change24h: undefined,
      marketCapRank: undefined,
    });
  });

  it("没有价 → 价那几项一律 undefined,不当成 0", () => {
    const e = toEnrichment(rec({ logo: "L" }));
    expect(e.unitPrice).toBeUndefined();
    expect(e.change24h).toBeUndefined();
    expect(e.marketCapRank).toBeUndefined();
  });
});
