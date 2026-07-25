import type { TokenGroup } from "@folio/oracle";
import { describe, expect, it } from "vitest";
import { buildTokenValueHistory, type TokenHistRow } from "../src/lib/token-history";

const usdc: TokenGroup = { id: "usdc", displaySymbol: "USDC", name: "USD Coin" };

const r = (p: {
  acct: string;
  takenAt: number;
  value: number;
  group?: TokenGroup;
  kind?: string;
  isMargin?: boolean;
  tokenId?: string;
  symbol?: string;
}): TokenHistRow => ({
  symbol: p.symbol ?? "USDC",
  amount: p.value,
  value: p.value,
  kind: p.kind ?? "spot",
  isMargin: p.isMargin,
  account: { id: p.acct, label: "", connectorId: "" },
  group: p.group,
  tokenId: p.tokenId,
  takenAt: p.takenAt,
});

describe("buildTokenValueHistory", () => {
  it("跨账户阶梯重建:某时刻 = Σ 各账户 ≤该刻最近快照里的该币价值", () => {
    const s = buildTokenValueHistory(
      [
        r({ acct: "A", takenAt: 100, value: 10, group: usdc }),
        r({ acct: "A", takenAt: 200, value: 12, group: usdc }),
        r({ acct: "B", takenAt: 200, value: 5, group: usdc }),
        r({ acct: "B", takenAt: 300, value: 6, group: usdc }),
      ],
      "group:usdc",
    );
    // t100: A=10;t200(同刻并入):A=12,B=5→17;t300:A=12(沿用)+B=6→18
    expect(s).toEqual([
      { t: 100, total: 10 },
      { t: 200, total: 17 },
      { t: 300, total: 18 },
    ]);
  });

  it("只算匹配本 key 的 eligible 行:别的币 / defi 仓位排除", () => {
    const s = buildTokenValueHistory(
      [
        r({ acct: "A", takenAt: 100, value: 10, group: usdc }), // 命中 group:usdc
        r({ acct: "A", takenAt: 100, value: 99, kind: "defi", group: usdc }), // 同 key 但 defi 不 eligible
        r({ acct: "A", takenAt: 100, value: 7, tokenId: "tok-eth", symbol: "ETH" }), // 别的 key
      ],
      "group:usdc",
    );
    expect(s).toEqual([{ t: 100, total: 10 }]);
  });

  it("同账户同快照多行(跨链)→ 汇总", () => {
    const s = buildTokenValueHistory(
      [
        r({ acct: "A", takenAt: 100, value: 10, group: usdc }),
        r({ acct: "A", takenAt: 100, value: 4, group: usdc }),
      ],
      "group:usdc",
    );
    expect(s).toEqual([{ t: 100, total: 14 }]);
  });

  it("perp 权益(isMargin)计入;无匹配 → 空序列", () => {
    const margin = buildTokenValueHistory(
      [r({ acct: "H", takenAt: 100, value: 8, kind: "perp_equity", isMargin: true, group: usdc })],
      "group:usdc",
    );
    expect(margin).toEqual([{ t: 100, total: 8 }]);
    expect(buildTokenValueHistory([], "group:usdc")).toEqual([]);
  });
});
