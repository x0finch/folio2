import { Either } from "effect";
import { describe, expect, it } from "vitest";
import { decodeJob } from "@/lib/server/jobs/message";

// 队列消息的形状(FOL-86)。队列是 at-least-once、跨部署版本的 —— 解码是 consumer 唯一的门,
// 解不开的一律 ack 丢弃(见 jobs/consume.ts),所以这道门本身得钉住。

describe("decodeJob", () => {
  const sync = {
    kind: "sync-account",
    userId: "u1",
    portfolioId: "pf1",
    roundId: "r1",
    accountId: "a1",
  };

  it("sync-account 原样解出", () => {
    expect(decodeJob(sync)).toEqual(Either.right(sync));
  });

  // FOL-88 的五件参考层活:都只带 userId。
  it.each(["fx", "platforms", "catalogue", "defi-logos", "prune-notes"])("%s 原样解出", (kind) => {
    expect(decodeJob({ kind, userId: "u1" })).toEqual(Either.right({ kind, userId: "u1" }));
  });

  // 上一个版本投的、已经不存在的 kind(队列跨部署版本):解不开 → consumer ack 丢弃,不重试。
  it("退场的 warm-user → Left", () => {
    expect(Either.isLeft(decodeJob({ kind: "warm-user", userId: "u1" }))).toBe(true);
  });

  it("多出来的字段丢掉 —— 老版本多带的东西不会漏进 consumer", () => {
    expect(decodeJob({ ...sync, extra: 1 })).toEqual(Either.right(sync));
  });

  it.each([
    ["认不出的 kind", { kind: "prices" }],
    ["缺字段", { kind: "sync-account", userId: "u1" }],
    ["空串 id", { ...sync, accountId: "" }],
    ["类型不对", { ...sync, roundId: 42 }],
    ["不是对象", "sync-account"],
    ["null", null],
  ])("%s → Left", (_name, body) => {
    expect(Either.isLeft(decodeJob(body))).toBe(true);
  });

  // 错误那句会进日志 —— 只许有路径与类别,不许回显值(body 里有 userId / accountId,P6.7)。
  it("错误信息不回显值", () => {
    const secretish = "user-id-that-must-not-be-logged";
    const out = decodeJob({ ...sync, userId: secretish, accountId: 7 });
    expect(Either.isLeft(out)).toBe(true);
    if (Either.isLeft(out)) expect(out.left).not.toContain(secretish);
  });
});
