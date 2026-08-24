import { beforeEach, describe, expect, it } from "vitest";
import { handleGetHomeTabStrip } from "@/lib/server/portfolio/tabs";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call } from "../_kit/run";
import { seedAccount, seedSnapshot } from "../_kit/seed";
import { freshUser, otherUser } from "../_kit/user";

// #527 · getHomeTabStrip
const USER = "h-pf-tabs";

let NOW = 0;

beforeEach(async () => {
  blockOutbound();
  await freshUser(USER);
  await freshUser(otherUser(USER));
  NOW = Date.now();
});

describe("getHomeTabStrip", () => {
  it("两个 pin → tab 条里出现这两个,标签是解析好的人话", async () => {
    const pf = await db(USER).portfolios.ensureDefault();
    const acc = await seedAccount(USER, "我的钱包", "bitcoin");
    await db(USER).portfolios.assignAccount(acc.id, pf.id);
    const tag = await db(USER).tags.create({ portfolioId: pf.id, name: "长期" });
    await db(USER).tabPins.create({ kind: "tag", tagId: tag.id });
    await db(USER).tabPins.create({ kind: "account", accountId: acc.id });

    const strip = await call(USER, handleGetHomeTabStrip({}));

    expect(strip.pins.map((p) => p.name).sort()).toEqual(["我的钱包", "长期"]);
  });

  it("没有任何 pin → pins 是空的", async () => {
    await seedAccount(USER, "甲", "bitcoin");

    expect((await call(USER, handleGetHomeTabStrip({}))).pins).toEqual([]);
  });

  it("有 perp 仓 → hasPerps 为真;有 DeFi 仓 → hasDefi 为真", async () => {
    const acc = await seedAccount(USER, "永续", "hyperliquid");
    await seedSnapshot(USER, acc.id, NOW, [
      {
        tokenId: "token-perp",
        amount: 1,
        usdValue: 100,
        kind: "perp_equity",
        // **权益行必须带 meta。** `toPerpView` 只在 `PerpEquityMeta.safeParse` 成功时才置
        // `equity`,而 `hasPerps` 看的正是它 —— 少了 meta,这一栏在界面上就整个不出现。
        // 第一版我没给 meta,于是 hasPerps 是 false,看着像 bug,其实是夹具没喂够。
        meta: { withdrawable: 60, totalMarginUsed: 40, totalNtlPos: 400 },
      },
      {
        tokenId: "token-defi",
        amount: 1,
        usdValue: 200,
        kind: "defi",
        meta: { protocol: "aave", protocolName: "Aave" },
      },
    ]);

    const strip = await call(USER, handleGetHomeTabStrip({}));

    expect(strip.hasPerps).toBe(true);
    expect(strip.hasDefi).toBe(true);
  });

  it("全新用户(零账户零 pin)→ hasAccounts 为假,不报错", async () => {
    const strip = await call(USER, handleGetHomeTabStrip({}));

    expect(strip.hasAccounts).toBe(false);
    expect(strip.hasPerps).toBe(false);
    expect(strip.hasDefi).toBe(false);
    expect(strip.pins).toEqual([]);
  });

  it("pin 指向的账户被删 → 这个 tab 不出现(级联)", async () => {
    const pf = await db(USER).portfolios.ensureDefault();
    const acc = await seedAccount(USER, "要删的", "bitcoin");
    await db(USER).portfolios.assignAccount(acc.id, pf.id);
    await db(USER).tabPins.create({ kind: "account", accountId: acc.id });

    await db(USER).accounts.remove(acc.id);

    expect((await call(USER, handleGetHomeTabStrip({}))).pins).toEqual([]);
  });

  it("切到别的 Portfolio → 不把上一个的持仓带过来", async () => {
    const def = await db(USER).portfolios.ensureDefault();
    const other = await db(USER).portfolios.create({ name: "另一个" });
    const acc = await seedAccount(USER, "甲", "hyperliquid");
    await db(USER).portfolios.assignAccount(acc.id, def.id);
    await seedSnapshot(USER, acc.id, NOW, [
      {
        tokenId: "token-perp",
        amount: 1,
        usdValue: 100,
        kind: "perp_equity",
        meta: { withdrawable: 60, totalMarginUsed: 40, totalNtlPos: 400 },
      },
    ]);

    const strip = await call(USER, handleGetHomeTabStrip({ portfolioId: other.id }));

    expect(strip.hasAccounts).toBe(false);
    expect(strip.hasPerps).toBe(false);
  });

  it("connector pin 的标签不是裸 id,而且带 logo", async () => {
    await seedAccount(USER, "甲", "bitcoin");
    await db(USER).tabPins.create({ kind: "connector", connectorId: "bitcoin" });

    const strip = await call(USER, handleGetHomeTabStrip({}));

    expect(strip.pins[0].name).not.toBe("bitcoin");
    expect(strip.pins[0].logo).toBeTruthy();
  });

  it("别人的 pin 不出现在我的 tab 条里", async () => {
    await db(otherUser(USER)).tabPins.create({ kind: "connector", connectorId: "bitcoin" });

    expect((await call(USER, handleGetHomeTabStrip({}))).pins).toEqual([]);
  });
});
