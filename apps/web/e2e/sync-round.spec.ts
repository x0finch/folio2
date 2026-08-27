import { SYNC_CONCURRENCY } from "@folio/sync";
import { type APIRequestContext, expect, test } from "@playwright/test";
import type { SyncRoundView } from "../src/lib/server/sync/status";
import { dismissPasskeyPrompt, signUpAndLogin } from "./fixtures/app";
import {
  accountIdByLabel,
  addBinanceAccount,
  blockPostCreateSync,
  clickSyncPill,
  hoverSyncPill,
  setUpstream,
  snapshotCount,
  unblockPostCreateSync,
  upstream,
  waitForSnapshot,
  waitForSnapshots,
  waitForUpstreamHit,
} from "./fixtures/sync";

// #372 —— 同步这条链路的端到端补验。
//
// 为什么之前一条都没有:e2e 里造不出「能同步成功」的账户 —— 9 个 connector 只有 manual 不联网,
// 而 manual 被排除在同步之外(ADR 0018)。剩下 8 个都要打外部 API,拿真 provider 跑 e2e 等于把第三方
// 可用性绑进 CI。破局点是 Binance 的 base URL **生产就可覆盖**(provider creds,#264):指向本地假
// server 就有了不联网、必定成功、快慢可控的上游,而且走的是生产也在跑的机制,没往生产代码塞测试分支。
//
// 要验的核心是 #371 的承诺:**跑和看是分开的 —— 关掉标签页,同步在服务端照样跑完。**
// ADR 0048 之后这条承诺更强了:连「看」的那一半都不再是一条流,而是对轮记录的轮询,所以关页
// 之后剩下的是一个与任何连接都无关的 `waitUntil` 任务。那条之前只有推理,没跑过一轮真同步。

/** 快照里有一条数量恰好是 amount 的余额。断言余额数量而不是 totalUsd:数量直接来自 provider,不经重估。 */
const holds = (amount: number) => (s: { balances: { amount: number }[] }) =>
  s.balances.some((b) => b.amount === amount);

test.describe("同步一轮", () => {
  // 默认 30 秒对这组不够:每条都要注册用户、从 UI 加账户(每次创建还 await 一次真实上游的缓存预热)、
  // 再等一轮同步落库。给整组放宽,而不是让个别条目在拥堵时随机撞穿。
  test.describe.configure({ timeout: 120_000 });

  test("点同步 → 全部账户出快照,报「已同步 N 个」", async ({ page, request }) => {
    await setUpstream(request, { delayMs: 0, spotBtc: "1.50000000" });
    await signUpAndLogin(page);
    await dismissPasskeyPrompt(page);
    await page.goto("/accounts");

    await addBinanceAccount(page, "Spot A");
    await addBinanceAccount(page, "Spot B");
    const idA = await accountIdByLabel(page, "Spot A");
    const idB = await accountIdByLabel(page, "Spot B");

    // 加账户时 modal 自己会在后台补一次同步(add-account-modal 的 handleDone)。先把那两次等掉,
    // 否则下面「点一下同步」量到的可能是它们的尾巴。
    await waitForSnapshot(page, idA, holds(1.5), "Spot A 创建后的首轮同步没落库");
    await waitForSnapshot(page, idB, holds(1.5), "Spot B 创建后的首轮同步没落库");

    // 换个数量 —— 这样「有没有新快照」不靠时间戳猜,数字本身就说明是新抓的。
    await setUpstream(request, { spotBtc: "3.25000000" });

    await page.reload(); // 让页头那枚胶囊拿到「都同步过了」的摘要
    await clickSyncPill(page);

    // 完成信号在面板里(FOL-32),而这一轮的结果是**服务端事实**(ADR 0048):`POST /api/sync`
    // 只回一个刚开的轮(0 / 2),「2 已同步」只可能是轮询把收官后的那一轮读回来的 ——
    // 所以这一条断言本身就是「轮询这条路走通了」的证据。
    await hoverSyncPill(page);
    await expect(page.getByText("2 synced")).toBeVisible({ timeout: 30_000 });
    await waitForSnapshot(page, idA, holds(3.25), "Spot A 这一轮的快照没落库");
    await waitForSnapshot(page, idB, holds(3.25), "Spot B 这一轮的快照没落库");
    // 再钉两下:没有失败区块 + 胶囊收口回「Synced」(这一轮出事会转琥珀「Needs attention」)。
    await expect(page.getByText("Failed this round")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Synced$/ })).toBeVisible({ timeout: 30_000 });
  });

  // 整个 #372 的理由就是这一条。别的挂了都好说,它挂了说明 #371 的核心承诺是假的。
  //
  // **这条钉住的是「连接没了,那一轮不受影响」**:`POST /api/sync` 早就回完了,这一轮活在
  // `waitUntil` 里,而每个账户的结果是写进库的,不是推给某个连接的。以前这条钉的是队列接力
  //(响应体那个 ReadableStream 被取消时不能顺着回压到生产端);现在那条路整个不存在了,
  // 而要验的性质没变。这里跑的是真断连 + 真落库,单测造不出来。
  //
  // **它钉不住的是 `waitUntil` 那一行本身。** 实测过:把 `waitUntil(run)` 注掉,dev 与 preview 两边
  // 这条照样绿 —— Miniflare 不强制「回了响应 worker 就该退出」,那是真 Workers 才有的约束。
  // 所以这条能防住的是设计层面的回归(改回拉动式 / 把跑绑在连接上),防不住有人删掉那行 waitUntil。
  // 别据此以为「绿了就等于线上没问题」。
  test("同步中途关掉标签页 → 服务端照样把这一轮跑完", async ({ page, context, request }) => {
    await setUpstream(request, { delayMs: 0, spotBtc: "1.50000000" });
    await signUpAndLogin(page);
    await dismissPasskeyPrompt(page);
    await page.goto("/accounts");

    await addBinanceAccount(page, "Cold spot");
    const accountId = await accountIdByLabel(page, "Cold spot");
    await waitForSnapshot(page, accountId, holds(1.5), "创建后的首轮同步没落库");

    // 上游改成又慢又不一样:慢到能在中途关标签页,数量变了则事后读到新数字只能是关掉之后写的。
    // hits 归零,好判断这一轮什么时候真的起跑。
    await setUpstream(request, { delayMs: 4_000, spotBtc: "7.00000000", hits: 0 });

    await page.reload();
    await clickSyncPill(page);
    await waitForUpstreamHit(request); // 服务端在拉上游了,而上游还要 4 秒才回

    // 关掉「看」的那一半。之后一切都只能靠服务端自己跑完。
    const closedAt = Date.now();
    await page.close();

    // 换一个页面读(同 context → 同 cookie),证明数据是落库了而不是留在某个页面的内存里。
    const reader = await context.newPage();
    await reader.goto("/accounts");
    const snapshot = await waitForSnapshot(
      reader,
      accountId,
      holds(7),
      "标签页关掉之后这一轮没跑完 —— #371 的核心承诺没兑现",
    );

    // 还要是**关掉之后**写的:takenAt 是写快照那一刻取的(sync/account.ts),不是开跑那一刻。
    expect(
      snapshot.takenAt,
      `快照 takenAt=${snapshot.takenAt} 不晚于关页时刻 ${closedAt} —— 那它就是关之前写的,证不到东西`,
    ).toBeGreaterThan(closedAt);
  });

  // 上面那条证的是「已经起跑的那一轮不会被掐断」。这条更进一步:**关页之后还会继续领新活。**
  //
  // 账户数刻意取 SYNC_CONCURRENCY + 2 —— 一轮同步最多同时拉 6 个账户,所以关页那一刻排在后面的两个
  // **连一个上游请求都还没发出去**。它们事后照样出快照,说明服务端不是「把手上的做完就算」,而是
  // 真的把整条流拉到底。这一条单测替代不了:它要的是「浏览器没了,那一轮还在往前推」这个性质
  // 在真断连下成立。
  //
  // 从 @folio/sync 引常量而不是写死 6:并发上限改了,这条测试跟着改,不会悄悄退化成「8 个全并发」
  // (那就什么都没测到了)。
  const ACCOUNT_COUNT = SYNC_CONCURRENCY + 2;
  test(`关标签页时还有账户没轮到(${ACCOUNT_COUNT} 个 > 并发 ${SYNC_CONCURRENCY})→ 它们也跑完`, async ({
    page,
    context,
    request,
  }) => {
    // 八个账户要一个个从 UI 加进去,这条注定是本文件最慢的一条。
    test.setTimeout(180_000);
    await setUpstream(request, { delayMs: 0, spotBtc: "7.00000000", hits: 0 });
    await signUpAndLogin(page);
    await dismissPasskeyPrompt(page);
    await page.goto("/accounts");

    // 造账户阶段屏蔽创建后的那次后台同步(见 blockPostCreateSync:它慢、会互相堵)。屏蔽之后这八个
    // 账户在被测那一轮之前**一张快照都没有** —— 断言更干净,不必再想办法排除干扰。
    await blockPostCreateSync(page);
    const labels = Array.from({ length: ACCOUNT_COUNT }, (_, i) => `Spot ${i + 1}`);
    for (const label of labels) await addBinanceAccount(page, label);
    await unblockPostCreateSync(page);

    const ids: string[] = [];
    for (const label of labels) ids.push(await accountIdByLabel(page, label));
    expect(
      await snapshotCount(page),
      "这八个账户此刻本该一张快照都没有(创建后的后台同步已屏蔽)",
    ).toBe(0);

    // 上游拖慢:慢到能在中途关标签页,也慢到排在并发窗口之后的两个账户还没轮到。
    await setUpstream(request, { delayMs: 3_000, hits: 0 });

    await page.reload();
    await clickSyncPill(page);
    await waitForUpstreamHit(request);

    const hitsAtClose = (await upstream(request)).hits;
    const closedAt = Date.now();
    await page.close();

    const reader = await context.newPage();
    await reader.goto("/accounts");
    const snapshots = await waitForSnapshots(
      reader,
      ids,
      holds(7),
      `${ACCOUNT_COUNT} 个账户没全部跑完 —— 关页之后服务端就不再领新活了`,
      90_000,
    );

    for (const [i, snapshot] of snapshots.entries()) {
      expect(
        snapshot.takenAt,
        `${labels[i]} 的快照 takenAt=${snapshot.takenAt} 不晚于关页时刻 ${closedAt}`,
      ).toBeGreaterThan(closedAt);
    }

    // 「关页之后才发起的请求」这件事,直接问假上游要数。
    const finalHits = (await upstream(request)).hits;
    expect(
      hitsAtClose,
      "关页之后一个新请求都没发出去 —— 那就没有『继续领新活』这回事",
    ).toBeLessThan(finalHits);
    // 每个账户一轮打固定几个端点 → 关页那一刻「动过手的账户数」不该超过并发上限,
    // 也就是至少还有两个连一次都没打。这一步失败通常意味着并发上限变了,本条测试要重新配数。
    const perAccount = finalHits / ACCOUNT_COUNT;
    expect(
      hitsAtClose / perAccount,
      `关页时已有 ${hitsAtClose / perAccount} 个账户动过上游,超过并发上限 ${SYNC_CONCURRENCY} —— 说明没有「还没轮到」的账户,这条测不到东西了`,
    ).toBeLessThanOrEqual(SYNC_CONCURRENCY);
  });
});

// 面板怎么念一轮的结果。**直接把 `POST /api/sync` 的回包换掉** —— 服务端不会轻易造出这几种组合
// (缺凭据的账户、整轮没跑起来、worker 死在半路),而回包就是那一轮此刻的样子,前端拿它直接落缓存。
//
// 收官/中断的轮不会再触发轮询(`refetchInterval` 只在「在跑」时开),所以造出来的这一份就是
// 面板一直读的那一份,不必再去拦 server fn 的地址(那是编译期产物,认不出是哪一个)。
test.describe("面板读轮", () => {
  // 有类型标注:面板真按 `SyncRoundView` 的字段读,fixture 走形(字段改名 / 新增必填)要在
  // 编译期红,不是在浏览器里静默显示成空面板。
  const roundView = (over: Partial<SyncRoundView>) => ({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      roundId: "e2e-round",
      state: "done",
      trigger: "manual",
      startedAt: Date.now() - 1000,
      finishedAt: Date.now(),
      total: 2,
      settled: 2,
      synced: 1,
      failed: [],
      needsKeys: 0,
      current: null,
      unresolved: 0,
      error: null,
      ...over,
    } satisfies SyncRoundView),
  });

  const withOneAccount = async (
    page: Parameters<typeof dismissPasskeyPrompt>[0],
    request: APIRequestContext,
  ) => {
    await setUpstream(request, { delayMs: 0 });
    await signUpAndLogin(page);
    await dismissPasskeyPrompt(page);
    await page.goto("/accounts");
    await addBinanceAccount(page, "Spot A");
  };

  test("缺凭据的账户算「需要凭据」,不算失败", async ({ page, request }) => {
    await withOneAccount(page, request);
    await page.route("**/api/sync", (route) => route.fulfill(roundView({ needsKeys: 1 })));

    await page.reload();
    await clickSyncPill(page);

    // 缺凭据是三段里自己的一段 —— 用户只是还没填 API key,那不是错误。
    // 锚定整串:Playwright 的字符串 name 是子串匹配,裸 "Synced" 会连账户行的「Synced now」
    // 一起命中,strict mode 直接炸(本地实跑抓到)。
    await expect(page.getByRole("button", { name: /^Synced$/ })).toBeVisible({ timeout: 30_000 });
    await hoverSyncPill(page);
    await expect(page.getByText("1 need keys")).toBeVisible();
    await expect(page.getByText("Failed this round")).toHaveCount(0);
  });

  test("整轮没跑起来 → 报错,不谎报成功", async ({ page, request }) => {
    await withOneAccount(page, request);
    await page.route("**/api/sync", (route) =>
      route.fulfill(roundView({ synced: 0, settled: 0, error: "account store exploded" })),
    );

    await page.reload();
    await clickSyncPill(page);

    await expect(page.getByRole("button", { name: /^Needs attention$/ })).toBeVisible({
      timeout: 30_000,
    });
    await hoverSyncPill(page);
    await expect(page.getByText("Failed this round")).toBeVisible();
    await expect(page.getByText("account store exploded")).toBeVisible();
  });

  // 中断 = 未收官且心跳断了(worker 死在半路,ADR 0048)。没有它这一档,一轮假同步在面板上
  // 与「一切正常」长得一模一样,而屏幕上的数其实是旧的。
  test("中断的一轮 → 说出来,不装作没事", async ({ page, request }) => {
    await withOneAccount(page, request);
    await page.route("**/api/sync", (route) =>
      route.fulfill(roundView({ state: "interrupted", finishedAt: null, settled: 1, synced: 1 })),
    );

    await page.reload();
    await clickSyncPill(page);

    await expect(page.getByRole("button", { name: /^Needs attention$/ })).toBeVisible({
      timeout: 30_000,
    });
    await hoverSyncPill(page);
    await expect(page.getByText("stopped partway")).toBeVisible();
  });
});
