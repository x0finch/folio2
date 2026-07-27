import type { TokenRecord } from "@folio/oracle2";
import { describe, expect, it } from "vitest";
import {
  defiTokenId,
  displayTokenId,
  displayTokenIds,
  fungibleTokenId,
  toEnrichment,
} from "../src/lib/tokens";

// 读端的三个门:回答「这一行参不参与」,答案就是它的 token_id 或 null。
// 认定在写快照时由 mint 定死(ADR 0021 / #201),所以这里不再造 `AssetRef` 让参考层现场解析。
const rec = (over: Partial<TokenRecord> = {}): TokenRecord => ({
  id: "tk-btc",
  ref: "coingecko/bitcoin",
  symbol: "BTC",
  name: "Bitcoin",
  infoStale: false,
  ...over,
});

describe("fungibleTokenId(估值现推的门)", () => {
  it("现货带 token_id → 给出来", () => {
    expect(fungibleTokenId({ symbol: "USDC", kind: "spot", tokenId: "tk-1" })).toBe("tk-1");
  });

  it("kind 走 viewKind 归一 —— 遗留的 manual / bitcoin 也算同质", () => {
    expect(fungibleTokenId({ symbol: "BTC", kind: "manual", tokenId: "tk-1" })).toBe("tk-1");
    expect(fungibleTokenId({ symbol: "BTC", kind: "bitcoin", tokenId: "tk-1" })).toBe("tk-1");
  });

  it("没有 token_id(旧快照 / 手记现造的行)→ null,不参与", () => {
    expect(fungibleTokenId({ symbol: "USDC", kind: "spot" })).toBeNull();
    expect(fungibleTokenId({ symbol: "USDC", kind: "spot", tokenId: null })).toBeNull();
  });

  it("defi / perp 不进这个门(它们的价值走 typed meta)", () => {
    expect(fungibleTokenId({ symbol: "X", kind: "defi", tokenId: "tk-1" })).toBeNull();
    expect(fungibleTokenId({ symbol: "BTC", kind: "perp", tokenId: "tk-1" })).toBeNull();
  });
});

describe("defiTokenId(只喂展示富化,不喂估值)", () => {
  it("defi 行带 token_id → 给出来(协议行的 24h 聚合要它)", () => {
    expect(defiTokenId({ symbol: "X", kind: "defi", tokenId: "tk-1" })).toBe("tk-1");
  });

  it("非 defi → null", () => {
    expect(defiTokenId({ symbol: "X", kind: "spot", tokenId: "tk-1" })).toBeNull();
  });
});

describe("displayTokenId / displayTokenIds(展示富化的统一门)", () => {
  // enrich 与 refreshStalePrices 必须同门:enrich 标了 stale 而 refresh 够不到的行,
  // 会让 pricesStale 永远清不掉、客户端每次加载空转一次刷新(code review #2)。
  it("同质 ∪ defi 都算展示门内", () => {
    expect(displayTokenId({ symbol: "A", kind: "spot", tokenId: "tk-1" })).toBe("tk-1");
    expect(displayTokenId({ symbol: "B", kind: "defi", tokenId: "tk-2" })).toBe("tk-2");
    expect(displayTokenId({ symbol: "C", kind: "perp_position", tokenId: "tk-3" })).toBeNull();
  });

  it("批量取 id 会去重,也会滤掉没身份的行", () => {
    expect(
      displayTokenIds([
        { symbol: "A", kind: "spot", tokenId: "tk-1" },
        { symbol: "A", kind: "spot", tokenId: "tk-1" }, // 同币多笔持仓很常见
        { symbol: "B", kind: "spot" }, // 没身份
        { symbol: "C", kind: "defi", tokenId: "tk-2" },
      ]),
    ).toEqual(["tk-1", "tk-2"]);
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
      name: "Bitcoin",
      logo: "/api/logo/token/tk-btc",
      unitPrice: 65000,
      change24h: 1.5,
      marketCapRank: 1,
    });
  });

  it("上游还没认出来的币(ref 为 null)只有连接器自带图 → 照样代理", () => {
    expect(toEnrichment(rec({ ref: null, id: "tk-orphan", providerLogo: "prov-L" }))).toEqual({
      name: "Bitcoin",
      logo: "/api/logo/token/tk-orphan",
      unitPrice: undefined,
      change24h: undefined,
      marketCapRank: undefined,
    });
  });

  it("一张图都没有 → 不给 logo(客户端显首字母,不发请求)", () => {
    expect(toEnrichment(rec())).toEqual({
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
