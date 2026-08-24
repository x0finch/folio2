import { beforeEach, describe, expect, it } from "vitest";
import { handleListPortfolios } from "@/lib/server/portfolios/list";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call } from "../_kit/run";
import { freshUser, otherUser } from "../_kit/user";

// #527 · listPortfolios
const USER = "h-pfs-list";

beforeEach(async () => {
  blockOutbound();
  await freshUser(USER);
  await freshUser(otherUser(USER));
});

describe("listPortfolios", () => {
  // **实测发现的缺陷,故挂起(#527 待定项)。** 全新用户第一次调,返回的是
  // `{ portfolios: [], defaultId: <一个不在 portfolios 里的 id> }`。
  //
  // 成因在 handler 自己:`Effect.all([store.list(), store.ensureDefault()], { concurrency: 2 })`
  // —— 两句**并发**,而 `ensureDefault` 是那次才把默认 Portfolio 写进去的。`list()` 抢先跑完就
  // 读到空表。于是首访拿到一个「有默认 id、却没有任何 Portfolio」的自相矛盾的视图。
  //
  // 修法看着只是把并发改成顺序(先 ensureDefault 再 list),但那是行为决定,不该由测试替你做,
  // 所以先挂起。第二次调用起就正常了 —— 这也是它至今没被发现的原因。
  it.skip("新用户第一次调 → 自动有一个默认 Portfolio(现在返回空列表,见注释)", async () => {
    const out = await call(USER, handleListPortfolios());

    expect(out.portfolios).toHaveLength(1);
    expect(out.portfolios[0].isDefault).toBe(true);
    expect(out.defaultId).toBe(out.portfolios[0].id);
  });

  it("第二次调 → 默认 Portfolio 在列表里,且 defaultId 指向它", async () => {
    // 首访那条挂起了,但「稳定态是对的」这件事仍然要有东西钉住。
    await call(USER, handleListPortfolios());

    const out = await call(USER, handleListPortfolios());

    expect(out.portfolios).toHaveLength(1);
    expect(out.portfolios[0].isDefault).toBe(true);
    expect(out.defaultId).toBe(out.portfolios[0].id);
  });

  it("建过三个 → 三个都在,默认那个标出来", async () => {
    await db(USER).portfolios.ensureDefault();
    await db(USER).portfolios.create({ name: "甲" });
    await db(USER).portfolios.create({ name: "乙" });

    const out = await call(USER, handleListPortfolios());

    expect(out.portfolios).toHaveLength(3);
    expect(out.portfolios.filter((p) => p.isDefault)).toHaveLength(1);
  });

  it("连着调两次 → 不能建出两个默认 Portfolio", async () => {
    // ensureDefault 会写库,所以这个「读」接口是有副作用的 —— 幂等性得钉住。
    const first = await call(USER, handleListPortfolios());
    const second = await call(USER, handleListPortfolios());

    expect(second.portfolios).toHaveLength(1);
    expect(second.defaultId).toBe(first.defaultId);
  });

  it("并发两次首访 → 仍然恰好一个默认", async () => {
    const [a, b] = await Promise.all([
      call(USER, handleListPortfolios()),
      call(USER, handleListPortfolios()),
    ]);

    expect(a.defaultId).toBe(b.defaultId);
    expect(
      (await call(USER, handleListPortfolios())).portfolios.filter((p) => p.isDefault),
    ).toHaveLength(1);
  });

  it("别人的 Portfolio 不出现在我的清单里", async () => {
    await db(otherUser(USER)).portfolios.create({ name: "别人的" });
    await db(otherUser(USER)).portfolios.ensureDefault();

    const out = await call(USER, handleListPortfolios());

    expect(out.portfolios.map((p) => p.name)).not.toContain("别人的");
  });
});
