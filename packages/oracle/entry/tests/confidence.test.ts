import type { TokenCandidate } from "@folio/oracle-basic";
import { RESOLUTION_DOMINANCE, RESOLUTION_TOP_RANK } from "@folio/oracle-basic";
import { describe, expect, it } from "vitest";
import { pickByConfidence } from "../src/internal/confidence";

// symbol 那一档的判官:同一个 symbol 有多个候选时,认不认、认哪个。
//
// **为什么单独测。** 它在 mint 里的旁证用例本来是空转的:那些用例给的是 `contract:` 形的 ref,
// 而 #210 的闸在到这个函数之前就把合约挡掉了 —— `candidates.bySymbol` 一次都没被调用,
// 测试绿得没有意义。走到这里的只有原生币与场馆代号,所以下面直接喂候选、直接看判决。
//
// 判错的代价不对称:少认 → 多出一行「认不出的币」,总览里显眼,用户能自己改绑;
// 多认 → 山寨币的金额并进真币,盯市凭空多一笔,且认定冻进快照永不重判。故一律偏保守。

const cand = (ref: string, marketCapRank?: number): TokenCandidate => ({ ref, marketCapRank });

describe("无候选 / 独一份", () => {
  it("没有候选 → 不认", () => {
    expect(pickByConfidence([])).toBeUndefined();
  });

  it("只有一个候选 → 认,哪怕它连排名都没有(没有可混淆的对象)", () => {
    expect(pickByConfidence([cand("src/issued:lonely")])).toBe("src/issued:lonely");
  });
});

describe(`最佳在 top-${RESOLUTION_TOP_RANK} 之内 → 认`, () => {
  it("头部币压过任何长尾同名币", () => {
    const got = pickByConfidence([cand("src/issued:scam", 900), cand("src/issued:bitcoin", 1)]);
    expect(got).toBe("src/issued:bitcoin");
  });

  it("恰好在门上 → 认(门是闭区间)", () => {
    const got = pickByConfidence([
      cand("src/issued:edge", RESOLUTION_TOP_RANK),
      cand("src/issued:other", RESOLUTION_TOP_RANK + 1),
    ]);
    expect(got).toBe("src/issued:edge");
  });

  // 差一名就得走碾压那一档:51 对 52 谁也没碾压谁 → 不认。
  it("差一名出门 → 落到碾压判定,而 51 比 52 算不上碾压 → 不认", () => {
    const got = pickByConfidence([
      cand("src/issued:a", RESOLUTION_TOP_RANK + 1),
      cand("src/issued:b", RESOLUTION_TOP_RANK + 2),
    ]);
    expect(got).toBeUndefined();
  });

  it("排序不看入参顺序 —— 最佳排在后面照样认", () => {
    expect(pickByConfidence([cand("src/issued:z", 999), cand("src/issued:a", 2)])).toBe(
      "src/issued:a",
    );
  });
});

describe("只有最佳有排名 → 无歧义", () => {
  it("次席连排名都没有(不在 warm 里)→ 认最佳,哪怕它在门外", () => {
    const got = pickByConfidence([cand("src/issued:known", 900), cand("src/issued:nameless")]);
    expect(got).toBe("src/issued:known");
  });

  it("全都没排名 → 不认(无从比较,宁可各成一行)", () => {
    expect(pickByConfidence([cand("src/issued:a"), cand("src/issued:b")])).toBeUndefined();
  });
});

describe(`碾压次席 ${RESOLUTION_DOMINANCE} 倍 → 认`, () => {
  // 排名是「越小越好」,所以碾压 = 次席的名次数是最佳的若干倍。
  it("倍数达标 → 认", () => {
    const got = pickByConfidence([
      cand("src/issued:big", 100),
      cand("src/issued:small", 100 * RESOLUTION_DOMINANCE),
    ]);
    expect(got).toBe("src/issued:big");
  });

  it("差一点就不认(比门槛低一名)", () => {
    const got = pickByConfidence([
      cand("src/issued:big", 100),
      cand("src/issued:small", 100 * RESOLUTION_DOMINANCE - 1),
    ]);
    expect(got).toBeUndefined();
  });

  it("只看最佳与次席,第三名再远也不影响", () => {
    const got = pickByConfidence([
      cand("src/issued:a", 100),
      cand("src/issued:b", 120),
      cand("src/issued:c", 99999),
    ]);
    expect(got).toBeUndefined();
  });
});
