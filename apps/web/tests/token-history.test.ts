import { describe, expect, it } from "vitest";
import {
  buildTokenValueHistory,
  type TokenHistRow,
} from "../src/lib/server/internal/token-history";

const USDC = "tok-usdc"; // 归并键**就是** token_id 本身(ADR 0021 / #201:三级键塌成一级)

const r = (p: {
  acct: string;
  takenAt: number;
  value: number;
  kind?: string;
  tokenId?: string;
  symbol?: string;
}): TokenHistRow => ({
  symbol: p.symbol ?? "USDC",
  amount: p.value,
  value: p.value,
  kind: p.kind ?? "spot",
  account: { id: p.acct, label: "", connectorId: "" },
  tokenId: p.tokenId,
  takenAt: p.takenAt,
});

describe("buildTokenValueHistory", () => {
  it("跨账户阶梯重建:某时刻 = Σ 各账户 ≤该刻最近快照里的该币价值", () => {
    const s = buildTokenValueHistory(
      [
        r({ acct: "A", takenAt: 100, value: 10, tokenId: USDC }),
        r({ acct: "A", takenAt: 200, value: 12, tokenId: USDC }),
        r({ acct: "B", takenAt: 200, value: 5, tokenId: USDC }),
        r({ acct: "B", takenAt: 300, value: 6, tokenId: USDC }),
      ],
      USDC,
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
        r({ acct: "A", takenAt: 100, value: 10, tokenId: USDC }), // 命中 tok-usdc
        r({ acct: "A", takenAt: 100, value: 99, kind: "defi", tokenId: USDC }), // 同 key 但 defi 不 eligible
        r({ acct: "A", takenAt: 100, value: 7, tokenId: "tok-eth", symbol: "ETH" }), // 别的 key
      ],
      USDC,
    );
    expect(s).toEqual([{ t: 100, total: 10 }]);
  });

  it("同账户同快照多行(跨链)→ 汇总", () => {
    const s = buildTokenValueHistory(
      [
        r({ acct: "A", takenAt: 100, value: 10, tokenId: USDC }),
        r({ acct: "A", takenAt: 100, value: 4, tokenId: USDC }),
      ],
      USDC,
    );
    expect(s).toEqual([{ t: 100, total: 14 }]);
  });

  it("perp 权益不计入(#129:只认现货,与聚合同口径);无匹配 → 空序列", () => {
    const equity = buildTokenValueHistory(
      [r({ acct: "H", takenAt: 100, value: 8, kind: "perp_equity", tokenId: USDC })],
      USDC,
    );
    expect(equity).toEqual([]); // 权益不 eligible → 单币历史里也没有它
    expect(buildTokenValueHistory([], USDC)).toEqual([]);
  });
});
