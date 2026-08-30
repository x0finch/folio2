import { expect, test } from "@playwright/test";
import { dismissPasskeyPrompt, signUpAndLogin } from "./fixtures/app";
import { addBinanceAccount, blockPostCreateSync } from "./fixtures/sync";

// 首页「首次同步中」的加载态(FOL-44 验收项)。
//
// **为什么非 e2e 不可。** 判据是 `isFirstSyncPending`(有账户、还没有任何快照),它把 hero 从
// 「渲染 $0.00」切成「大数字位骨架 + 标题 Syncing…」(见 hero/index.tsx 的 `data.pending` 分支与
// portfolio-hero.tsx 的 `syncing`)。这条链跨 server fn → select → 组件三层:server 判 pending →
// 查询 select 带上它 → hero 读它切态。任一环把 pending 丢了,表现就是「把还不知道画成 $0」——
// 一个静默的、看起来「没坏只是没钱」的错。单测各管一头(overview-model 验 select 出 pending、
// 组件测被 cloudflare:workers 依赖链挡住),没有一层盖住「真渲染出的是骨架还是 $0」。
//
// 做法:建一个账户但**掐掉它建成后那次自动同步**(blockPostCreateSync)→ 一张快照都没有 →
// 首页恒定停在 pending 态,断言稳定不靠时序。
test.describe("首页:首次同步中的加载态", () => {
  test.describe.configure({ timeout: 120_000 });

  test("有账户、还没有任何快照 → hero 显示「Syncing…」而不是把 $0 画出来", async ({ page }) => {
    await signUpAndLogin(page);
    await dismissPasskeyPrompt(page);
    // 账户建成后 add-account-modal 会自己补一次 syncAccount(见 fixtures/sync.ts)——掐掉它,
    // 账户就永远停在「零快照」,pending 态不会被一张迟来的快照解除。
    await blockPostCreateSync(page);
    await page.goto("/accounts");
    await addBinanceAccount(page, "E2E FirstSync");

    await page.goto("/");

    // 首次同步中:标题是 `firstSyncing`(= "Syncing…"),大数字位是骨架。这个标签只在
    // pending 分支渲染(portfolio-hero.tsx 第 117 行 syncing=true),是 pending 态的精确信号。
    // `.first()`:掐掉同步后页头胶囊不会是「Syncing…」,但用 first 兜住万一的重名,不让 strict 报错。
    await expect(page.getByText("Syncing…").first()).toBeVisible({ timeout: 30_000 });
  });
});
