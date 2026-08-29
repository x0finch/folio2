import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// **预计算必须排在预热后面。** 这不是风格,是 FOL-35 那一片最贵的一个 bug:
// 存下来的市值与 24h 数字吃的是现推的 `liveValue`(盯市那些行取实时源价),而预热正是把那份价
// 刷新的一步。排在它前面,每一轮存下的都是**上一轮**的价算出来的数,然后挂满 90 分钟 ——
// 没有任何东西会自己纠正,屏幕上也没有任何东西在解释它。
//
// **为什么这条是读源码而不是跑行为**(同 `home-loader.test.ts` 的做法):两条路上「预热」都要
// 真的打上游才会改价,而服务端用例一律 `blockOutbound`。也就是说顺序颠倒在测试环境里
// **观察不到任何差别** —— 跑得出来的行为用例全绿。既然那条缝只在源码里看得见,就在源码里钉它。
// 实测过:把两处顺序各颠倒一次,整套服务端用例一条都不红。

const read = (rel: string) => readFileSync(join(import.meta.dirname, rel), "utf8");

describe("预计算排在预热后面", () => {
  it("手动同步:一轮的收尾里,预热在前、预计算在后", () => {
    const src = read("../src/lib/server/sync/round.ts");
    // `afterRound` 就是预热那一步(sync/deps.ts:`afterRound: warmTokens`)。
    expect(src).toMatch(/Effect\.zipRight\(\s*Effect\.exit\(afterRound\),\s*precomputePortfolio\(/);
  });

  it("cron:sweep 的第三趟在预热之后", () => {
    // cron 的预热不在轮里(它按用户统一做),所以它的预计算也得挪到 sweep 的最后一趟。
    const src = read("../src/server.ts");
    expect(src.indexOf("warmAllUsers(")).toBeGreaterThan(-1);
    expect(src.indexOf("precomputeAllUsers(")).toBeGreaterThan(src.indexOf("warmAllUsers("));
  });

  it("cron 的轮里**不**预计算 —— 那时候价还没热", () => {
    const src = read("../src/lib/server/sync/round.ts");
    // `warm === false` 是 cron 那一支;它那条分支上不该出现预计算。
    expect(src).toMatch(/opts\.warm === false\s*\?\s*undefined/);
  });
});
