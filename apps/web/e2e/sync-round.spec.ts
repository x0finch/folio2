import { SYNC_CONCURRENCY } from "@folio/sync";
import { expect, test } from "@playwright/test";
import { dismissPasskeyPrompt, signUpAndLogin } from "./fixtures/app";
import {
  accountIdByLabel,
  addBinanceAccount,
  blockPostCreateSync,
  clickSyncPill,
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
// 那条之前只有推理(waitUntil 是平台行为、Effect Stream 是拉动式),没跑过一轮真同步。

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

    await expect(page.getByText("Synced 2 accounts.")).toBeVisible({ timeout: 30_000 });
    await waitForSnapshot(page, idA, holds(3.25), "Spot A 这一轮的快照没落库");
    await waitForSnapshot(page, idB, holds(3.25), "Spot B 这一轮的快照没落库");
  });

  // 整个 #372 的理由就是这一条。别的挂了都好说,它挂了说明 #371 的核心承诺是假的。
  //
  // **这条钉住的是「连接被真的掐断,那一轮不受影响」**:客户端 abort 会让 workerd 取消响应体那个
  // ReadableStream,而取消**不能**顺着传回生产端 —— 那正是 #371 用队列接力换来的性质(队列是无界的、
  // 推动式的,读的那头没了不回压)。这里跑的是真断连 + 真落库,单测造不出来。
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
  // 真的把整条流拉到底。这一条单测替代不了:它要的是「没人读了,生产端还在往前推」这个性质在真
  // 断连下成立(队列无界 + 推动式,读的那头没了不回压 —— 见 lib/sync-ndjson.ts)。
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

// 前端读流的两条分类规则。不依赖假 server —— 直接喂假 NDJSON,因为要造的是**服务端不会轻易造出的**
// 组合(缺凭据的账户、用户级失败)。
//
// 「进度是逐条更新而不是一次性跳到 100%」不在这里验:route.fulfill 一次性把整个 body 交出去,
// 造不出分片;那条已由 tests/sync-stream.test.ts(逐行回调)与 tests/use-account-sync.test.tsx
// (故意切成两片喂)覆盖,在这儿重复一遍只会多一处不稳。
test.describe("前端读流", () => {
  const ndjson = (lines: unknown[]) => ({
    status: 200,
    contentType: "application/x-ndjson",
    body: lines.map((l) => `${JSON.stringify(l)}\n`).join(""),
  });

  test("缺凭据的账户算跳过,不算失败", async ({ page, request }) => {
    await setUpstream(request, { delayMs: 0 });
    await signUpAndLogin(page);
    await dismissPasskeyPrompt(page);
    await page.goto("/accounts");
    await addBinanceAccount(page, "Spot A");

    await page.route("**/api/sync", (route) =>
      route.fulfill(
        ndjson([
          { accountId: "a", ok: true },
          { accountId: "b", ok: false, skipped: true },
        ]),
      ),
    );

    await page.reload();
    await clickSyncPill(page);

    // 两条都记进「已同步」,一条都不进失败 —— 用户只是还没填 API key,那不是错误。
    await expect(page.getByText("Synced 2 accounts.")).toBeVisible();
  });

  test("用户级失败(fatal 行)→ 报错,不谎报成功", async ({ page, request }) => {
    await setUpstream(request, { delayMs: 0 });
    await signUpAndLogin(page);
    await dismissPasskeyPrompt(page);
    await page.goto("/accounts");
    await addBinanceAccount(page, "Spot A");

    await page.route("**/api/sync", (route) =>
      route.fulfill(ndjson([{ accountId: "a", ok: true }, { fatal: "account store exploded" }])),
    );

    await page.reload();
    await clickSyncPill(page);

    // 断言整句而不是 /^Synced/ 这种宽匹配:账户行上写着「Synced now」,宽匹配会把它算进来。
    await expect(page.getByText("1 failed — account store exploded")).toBeVisible();
    await expect(page.getByText("Synced 1 account.")).toHaveCount(0);
  });
});
