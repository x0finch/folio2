import { beforeEach, describe, expect, it } from "vitest";
import { handleListPortfolios } from "@/lib/server/portfolios/list";
import { handleRenamePortfolio, RenamePortfolioInput } from "@/lib/server/portfolios/rename";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call } from "../_kit/run";
import { freshUser, otherUser } from "../_kit/user";

// #527 · renamePortfolio
const USER = "h-pfs-rename";

const nameOf = async (userId: string, id: string) =>
  (await call(userId, handleListPortfolios())).portfolios.find((p) => p.id === id)?.name;

beforeEach(async () => {
  blockOutbound();
  await freshUser(USER);
  await freshUser(otherUser(USER));
});

describe("renamePortfolio", () => {
  it("改完列表里是新名字", async () => {
    await db(USER).portfolios.ensureDefault();
    const pf = await db(USER).portfolios.create({ name: "旧名" });

    await call(USER, handleRenamePortfolio({ portfolioId: pf.id, name: "新名" }));

    expect(await nameOf(USER, pf.id)).toBe("新名");
  });

  it("改默认那个的名字 → 它还是默认", async () => {
    const def = await db(USER).portfolios.ensureDefault();

    await call(USER, handleRenamePortfolio({ portfolioId: def.id, name: "我的主仓" }));

    const out = await call(USER, handleListPortfolios());
    expect(out.defaultId).toBe(def.id);
    expect(out.portfolios.find((p) => p.id === def.id)?.name).toBe("我的主仓");
  });

  it("改成空串 / 纯空格 → schema 拒", () => {
    expect(RenamePortfolioInput.safeParse({ portfolioId: "p", name: "" }).success).toBe(false);
    expect(RenamePortfolioInput.safeParse({ portfolioId: "p", name: "  " }).success).toBe(false);
  });

  it("改别人的 Portfolio → 对方那个名字一个字没变", async () => {
    const theirs = await db(otherUser(USER)).portfolios.create({ name: "他们的" });

    await call(USER, handleRenamePortfolio({ portfolioId: theirs.id, name: "被我改了" }));

    expect(await nameOf(otherUser(USER), theirs.id)).toBe("他们的");
  });

  it("改一个不存在的 id → 不抛,也不凭空建一条", async () => {
    await db(USER).portfolios.ensureDefault();

    await call(USER, handleRenamePortfolio({ portfolioId: "没有这个", name: "x" }));

    expect((await call(USER, handleListPortfolios())).portfolios).toHaveLength(1);
  });
});
