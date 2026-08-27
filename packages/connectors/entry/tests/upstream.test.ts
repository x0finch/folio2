import type { ConnectorError } from "@folio/connectors-basic";
import { Either } from "effect";
import { describe, expect, it } from "vitest";
import { bestEffortVerdict } from "../src/upstream";

// 多桶尽力而为的成败裁定。三家 CEX(binance / okx / bybit)共用这一把尺子 —— 它们都把一个账户
// 拆成几个隔离的桶并发拉,失败时都要回答同一个问题:**这轮该交给重试,还是该降级写部分快照。**
const err = (tag: string) => ({ _tag: tag }) as unknown as ConnectorError;
const AUTH = "ConnectorAuthError"; // 权限没勾 —— 等也没用
const SHAPE = "ConnectorFailure"; // 上游变了形状 —— 等也没用
const LIMIT = "ConnectorRateLimitError"; // 限流 —— 等一等会好
const DOWN = "ConnectorUnavailableError"; // 上游挂了 —— 等一等会好

const ok = (name: string) => ({ name, result: Either.right(name) });
const ko = (name: string, tag: string) => ({ name, result: Either.left(err(tag)) });

describe("bestEffortVerdict", () => {
  it("全好 → 尽力而为,失败列表是空的", () => {
    const v = bestEffortVerdict([ok("Trading"), ok("Funding")]);
    expect(Either.isRight(v)).toBe(true);
    if (Either.isRight(v)) expect(v.right).toEqual([]);
  });

  it("部分挂且全是「等也没用」→ 降级,失败列表交给调用方拼 note", () => {
    const v = bestEffortVerdict([ok("Trading"), ko("Savings", AUTH), ko("Staking", SHAPE)]);
    expect(Either.isRight(v)).toBe(true);
    if (Either.isRight(v)) expect(v.right.map((f) => f.name)).toEqual(["Savings", "Staking"]);
  });

  it("部分挂且有「等一等会好」的 → 整体失败,交给重试", () => {
    // 降级写出去的残缺快照会盖掉真实资产,而下一轮本来就能拉到 —— 这正是 FOL-30 的病灶。
    const transient = err(DOWN);
    const v = bestEffortVerdict([
      { name: "Trading", result: Either.right("Trading") },
      { name: "Funding", result: Either.left(transient) },
    ]);
    expect(Either.isLeft(v)).toBe(true);
    if (Either.isLeft(v)) expect(v.left).toBe(transient);
  });

  it("瞬时错混着权限错 → 以瞬时那个失败(它才是重试的理由)", () => {
    const transient = err(LIMIT);
    const v = bestEffortVerdict([
      ko("Savings", AUTH),
      { name: "Trading", result: Either.left(transient) },
      ok("Funding"),
    ]);
    expect(Either.isLeft(v)).toBe(true);
    if (Either.isLeft(v)) expect(v.left).toBe(transient);
  });

  it("几个瞬时错并存 → 优先以限流错失败(它可能带 Retry-After,给重试当依据)", () => {
    const limit = err(LIMIT);
    const v = bestEffortVerdict([
      ko("Trading", DOWN),
      { name: "Funding", result: Either.left(limit) },
    ]);
    expect(Either.isLeft(v)).toBe(true);
    if (Either.isLeft(v)) expect(v.left).toBe(limit);
  });

  it("全军覆没(哪怕全是「等也没用」)→ 整体失败,不写空快照", () => {
    // 整把 key 被吊销:降级的话写出去的是一份**空**快照,把账户的全部资产抹掉。
    const first = err(AUTH);
    const v = bestEffortVerdict([
      { name: "Trading", result: Either.left(first) },
      ko("Funding", AUTH),
    ]);
    expect(Either.isLeft(v)).toBe(true);
    if (Either.isLeft(v)) expect(v.left).toBe(first);
  });

  it("一个桶都没有 → 尽力而为(空账户不是失败)", () => {
    const v = bestEffortVerdict([]);
    expect(Either.isRight(v)).toBe(true);
  });
});
