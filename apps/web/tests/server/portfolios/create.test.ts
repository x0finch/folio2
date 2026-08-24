import { beforeEach, describe, expect, it } from "vitest";
import { CreatePortfolioInput, handleCreatePortfolio } from "@/lib/server/portfolios/create";
import { handleListPortfolios } from "@/lib/server/portfolios/list";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call } from "../_kit/run";
import { freshUser } from "../_kit/user";

// #527 · createPortfolio
const USER = "h-pfs-create";

beforeEach(async () => {
  blockOutbound();
  await freshUser(USER);
});

describe("createPortfolio", () => {
  it("建一个 → 出现在列表里,而且不是默认", async () => {
    await db(USER).portfolios.ensureDefault();

    const { id } = await call(USER, handleCreatePortfolio({ name: "长线仓" }));

    const out = await call(USER, handleListPortfolios());
    const made = out.portfolios.find((p) => p.id === id);
    expect(made?.name).toBe("长线仓");
    expect(made?.isDefault).toBe(false);
  });

  it("名字两头带空格 → schema trim 之后才进 handler", () => {
    expect(CreatePortfolioInput.parse({ name: "  长线仓  " }).name).toBe("长线仓");
  });

  it("名字空串 / 纯空格 → schema 拒", () => {
    expect(CreatePortfolioInput.safeParse({ name: "" }).success).toBe(false);
    expect(CreatePortfolioInput.safeParse({ name: "    " }).success).toBe(false);
  });

  it("建出来的不会顶掉已有的默认", async () => {
    const def = await db(USER).portfolios.ensureDefault();

    await call(USER, handleCreatePortfolio({ name: "另一个" }));

    expect((await call(USER, handleListPortfolios())).defaultId).toBe(def.id);
  });

  // **规则未定,故挂起(#527 待定项)。** 现在同名会建出两个独立 Portfolio;选择器上会并排出现
  // 两个一模一样的名字,用户分不出哪个是哪个。是允许(它们确实是两个不同容器)还是拒,得你定。
  it.skip("重名 → 待定:允许还是拒", () => {});

  // 同上:双击的结果完全由重名规则决定。
  it.skip("双击提交两次 → 待定:随重名规则一并定", () => {});

  it("名字 200 字 → 现在照收(schema 没有上限)", async () => {
    // 这条钉的是现状。没有 max 约束,所以超长名字会原样落库,由界面自己截断显示。
    // 如果哪天加了上限,这条会红 —— 那正是提醒把它改成断言「拒」的时刻。
    const long = "长".repeat(200);

    const { id } = await call(USER, handleCreatePortfolio({ name: long }));

    const made = (await call(USER, handleListPortfolios())).portfolios.find((p) => p.id === id);
    expect(made?.name).toHaveLength(200);
  });
});
