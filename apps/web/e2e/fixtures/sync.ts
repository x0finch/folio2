import { type APIRequestContext, expect, type Page } from "@playwright/test";

// 同步链路 e2e 的共用件:操控假上游、加一个能同步成功的账户、读回落库的快照。
//
// 为什么另起一份而不塞进 app.ts:那份装的是闲置锁 / passkey 那套的现场道具(localStorage 键、
// 虚拟认证器),和这里没有交集。

export const FAKE_BINANCE_URL = "http://localhost:3099";

interface UpstreamState {
  /** 每个请求人为拖多久 —— 把同步拖慢到能在中途关标签页。 */
  delayMs: number;
  /** 现货那条 BTC 持仓的数量(字符串,原样进快照)。 */
  spotBtc: string;
  /** BTCUSDT 报价。 */
  btcPrice: string;
  /** 假 server 累计收到的请求数(只增;可置 0)。 */
  hits: number;
}

/**
 * 改假上游的行为,返回改完之后的完整状态。
 *
 * 走 `request` fixture 而不是 `page.request`:它不绑 baseURL,也不随页面关闭失效 ——
 * 「关标签页」那条在页面没了之后还要接着操控上游。
 */
export async function setUpstream(
  request: APIRequestContext,
  patch: Partial<UpstreamState>,
): Promise<UpstreamState> {
  const res = await request.post(`${FAKE_BINANCE_URL}/__control`, { data: patch });
  expect(res.ok(), `fake binance rejected ${JSON.stringify(patch)}: ${await res.text()}`).toBe(
    true,
  );
  return res.json();
}

export async function upstream(request: APIRequestContext): Promise<UpstreamState> {
  return (await request.get(`${FAKE_BINANCE_URL}/__control`)).json();
}

/**
 * 走 UI 加一个 Binance 账户(假 key,打本地假 server)。
 *
 * 为什么走 UI 而不直接调 server function:server fn 的调用地址是编译期产物(带 id 散列),从测试里
 * 拼它等于把一个随构建变的内部细节钉进测试。而「加账户」本身就是个有 UI 的用户动作,点一遍顺带把
 * 创建流覆盖了。
 *
 * **注意**:创建成功后 add-account-modal 会自己在后台补一次 `syncAccount`(见其 handleDone),
 * 所以本函数返回时账户可能已经有一张快照。要量「点下去这一轮」的测试必须先把那次等掉。
 */
export async function addBinanceAccount(page: Page, label: string) {
  // 点到 modal 真开为止。**不是为了等一段时间** —— 账户页刚 goto 完时 React 可能还没挂上 handler,
  // 那一下点击会被**静静吞掉**(不报错、不生效),失败要到十几秒后才以「找不到 Binance」的形式出现
  // (app.ts 的 gotoHydrated 注释里记了这个现象;账户页没有「只可能由客户端发出」的请求可等,
  // 所以这里改成重试点击)。
  //
  // 开着的时候**绝不再点**:modal 的遮罩就是一个覆盖全屏的「关闭」按钮,再点会被它截住,
  // 于是整个重试循环卡在「点击被拦」上直到超时(第一版就是这样挂的)。
  //
  // 名字用 /Binance$/i 而不是精确 "Binance",两头都有理由:格子的可读名是「首字母 + 名字」
  // (LogoAvatar 兜底首字母那个 span 一直在 DOM 里),实测 `B Binance`,所以不能精确匹配;
  // 而裸子串会连账户页上已有的 Binance 账户行一起命中(它的名字是「标签 Binance 上次同步 …」),
  // strict mode 直接报两个元素 —— 所以锚在结尾。忽略大小写顺带兼容 connector 目录还没到位、
  // 名字暂时是小写 id 的那一瞬。
  const grid = page.getByRole("button", { name: /Binance$/i });
  const scrim = page.getByRole("button", { name: "Close modal" });

  // 上一次的 modal 得先彻底退场。它是带退场动画的 MorphingModal:遮罩还挂着的那几百毫秒里,
  // 下面的循环会以为「已经开着了」而不去点开,然后在等一个不存在的网格 —— 连着加八个账户时
  // 这一下真的会撞上(第一版就是加到第五个开始挂)。
  await expect(scrim).toHaveCount(0, { timeout: 10_000 });

  await expect(async () => {
    if ((await scrim.count()) === 0) {
      await page.getByRole("button", { name: "Add account" }).click();
    }
    await expect(grid).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  await grid.click();

  await page.locator("#add-label").fill(label);
  await page.locator("#add-apiKey").fill("e2e-fake-api-key");
  await page.locator("#add-secret").fill("e2e-fake-api-secret");

  const form = page.locator("form").filter({ has: page.locator("#add-label") });
  const failure = form.locator("p.text-destructive"); // AccountForm 的 mutation.isError 那行红字

  // **回车提交,不点那个按钮。** modal 的遮罩是一个覆盖全屏的「关闭」按钮,而网格→表单是个 morph
  // 动画:点击的命中测试通过之后、真正的鼠标事件落下之前,布局还在动,那一下会被遮罩接走 ——
  // 表现是 modal 关了、账户没建、连报错都没有(连着加八个时稳定复现,第 5 到第 8 个之间某一个中招)。
  // 回车走的是表单的 onSubmit,不经过坐标命中,而且它本身也是真实的用户动作。
  await page.locator("#add-secret").press("Enter");

  // 创建会**真的**打一次假 server 校验凭据(validateAccount)—— 所以这一步顺带证明了 worker 确实
  // 指着假 server。
  //
  // 认**含这个标签的那个按钮**(账户行),不认「页面上任何一处这个标签」:同步面板的「未同步」
  // 清单里也写着同一个标签,裸文本匹配会命中两个元素(那清单不在按钮里,所以按按钮筛就干净了)。
  //
  // 不按可读名匹配:行的可读名是一长串拼接(标签 + Binance + 上次同步 + 金额 + 涨跌),
  // 账户一多它的开头就不一定是标签,`^标签` 会莫名匹配不上(实测第七个账户开始中招)。
  // 「这个按钮里有这段文字」是稳的。
  //
  // 同时盯那行红字:被拒时直接把上游给的理由抛出来。不然失败只表现成「账户行没出现」,
  // 真正的原因(比如没指向假 server → binance auth failed)藏在一行没人看的字里。
  const row = page.getByRole("button").filter({ has: page.getByText(label, { exact: true }) });
  await expect(async () => {
    // 先 count() 再取文字。**别直接 textContent()**:匹配不到元素时它会一直等到 actionTimeout
    // (本仓配的是 15 秒)才抛,而「没有红字」恰恰是常态 —— 于是每加一个账户白烧 15 秒,
    // 八个账户那条一路涨到两分多钟。count() 是立刻返回的。
    const rejected = (await failure.count()) > 0 ? await failure.first().textContent() : null;
    expect(
      rejected,
      `加账户被拒:${rejected} —— 若是 binance auth failed,说明 app 没指向假 server,起服务要带 CLOUDFLARE_ENV=test(见 playwright.config.ts)`,
    ).toBeNull();
    await expect(row).toHaveCount(1, { timeout: 1_000 });
  }).toPass({ timeout: 25_000 });
}

/**
 * 屏蔽「创建账户之后那次后台同步」——只在一次性造很多账户时用。
 *
 * 为什么要屏蔽:`add-account-modal` 的 handleDone 会 `void syncAccount(...)`,而那个 server fn 是
 * **await 完 `warmTokensForUser` 才返回**的 —— 预热要打真实的价格 / 汇率 / logo 上游。连着造八个账户
 * 时这些请求堆在一起把 worker 堵住,后一个账户的创建从两秒涨到十几秒(实测)。造账户不是被测对象,
 * 没必要为它付这个钱;而且屏蔽之后这些账户在被测那一轮之前**一张快照都没有**,断言反而更干净。
 *
 * 按请求体分辨而不是按 URL:server fn 的地址带编译期散列,认不出是哪一个。而 `syncAccount` 的入参
 * 只有 accountId,`createAccount` 带的是 connectorId/label/values —— 这就够分了。
 */
export async function blockPostCreateSync(page: Page) {
  await page.route("**/_serverFn/**", async (route) => {
    const body = route.request().postData() ?? "";
    if (body.includes("accountId") && !body.includes("connectorId")) return route.abort();
    return route.fallback();
  });
}

export async function unblockPostCreateSync(page: Page) {
  await page.unroute("**/_serverFn/**");
}

/**
 * 点页头那枚同步胶囊 = 跑整轮同步(见 sync-status.tsx 的 StatusSegment onClick),
 * 返回时 `POST /api/sync` 已经发出。
 *
 * 同样要重试点击:reload 之后头几百毫秒的点击会被吞(见 addBinanceAccount 的注释)。
 * 重复点不会多跑一轮 —— useAccountSync 的 `sync()` 在 isPending 时直接 return。
 *
 * **只等请求发出,不等响应头**:实测 vite dev 下这条 NDJSON 响应是**攒完才发**的
 * (量到响应头 6.4s 才到,而那一轮总共就跑了 6.4s),所以「响应头到手」在本地并不等于「刚起跑」,
 * 反而等于「已经跑完」。要判断服务端真的在干活,问假上游收到请求没有(setUpstream hits)。
 */
// 悬停页头那枚胶囊,开同步面板(FOL-32 后桌面 popover 走 hover)。等到面板标题出现才算开着。
export async function hoverSyncPill(page: Page) {
  const pill = page.getByRole("button", { name: /^(Synced|Needs attention|Syncing…)$/ });
  await pill.hover();
  await expect(page.getByText("Sync status")).toBeVisible();
}

export async function clickSyncPill(page: Page) {
  const pill = page.getByRole("button", { name: /^(Synced|Needs attention|Syncing…)$/ });
  await expect(async () => {
    const sent = page.waitForRequest(
      (r) => r.url().includes("/api/sync") && r.method() === "POST",
      { timeout: 3_000 },
    );
    await pill.click();
    await sent;
  }).toPass({ timeout: 30_000 });
}

/** 等假上游真的开始收请求 —— 服务端这一轮在干活了。配合 `setUpstream(request, { hits: 0 })` 用。 */
export async function waitForUpstreamHit(request: APIRequestContext) {
  await expect
    .poll(async () => (await upstream(request)).hits, {
      message: "假上游一个请求都没收到 —— 服务端这一轮没起跑",
      timeout: 15_000,
    })
    .toBeGreaterThan(0);
}

export interface ExportedSnapshot {
  accountId: string;
  takenAt: number;
  totalUsd: number;
  balances: { amount: number; usdValue: number; kind: string }[];
}

interface ExportedAccount {
  id: string;
  label: string;
}

interface Exported {
  accounts: ExportedAccount[];
  snapshots: ExportedSnapshot[];
}

/**
 * 从 `/api/export` 读回这个用户的账户与落库快照。
 *
 * 为什么读导出而不读界面:导出是个稳定的 HTTP 端点,回的是**库里的原值**(数量、估值、takenAt),
 * 不经格式化、不受选中 Portfolio / 折叠状态影响。而「同步跑完了没有」问的正是库里有没有那一行。
 *
 * 用 `context().request` 而不是 `page.request`:页面关掉之后还要接着读 —— 那正是核心那条测试。
 */
async function exportData(page: Page): Promise<Exported> {
  const res = await page.context().request.get("/api/export");
  expect(res.ok(), `export failed: ${res.status()}`).toBe(true);
  const records = (await res.text())
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  return {
    accounts: records.filter((r) => r.type === "account"),
    snapshots: records.filter((r) => r.type === "snapshot"),
  };
}

/** 这个用户当前落库的快照总数。 */
export async function snapshotCount(page: Page): Promise<number> {
  return (await exportData(page)).snapshots.length;
}

export async function accountIdByLabel(page: Page, label: string): Promise<string> {
  const { accounts } = await exportData(page);
  const hit = accounts.find((a) => a.label === label);
  if (!hit) throw new Error(`导出里没有名为 ${label} 的账户:${JSON.stringify(accounts)}`);
  return hit.id;
}

/**
 * 轮到**每个**给定账户都出现一张满足条件的快照,按入参顺序返回它们。
 *
 * 用 `expect.poll` 而不是等一段时长:条件一满足立刻返回;不满足时把还差哪些账户打进报错,
 * 「一个都没有」「差最后两个」看一眼就分得清 —— 而后者正是并发那条测试要区分的失败形态。
 *
 * 一轮只读一次导出(不是每个账户读一次):八个账户就是八倍请求,而它们的答案本来就在同一份导出里。
 */
export async function waitForSnapshots(
  page: Page,
  accountIds: string[],
  predicate: (s: ExportedSnapshot) => boolean,
  message: string,
  timeout = 25_000,
): Promise<ExportedSnapshot[]> {
  let matches: (ExportedSnapshot | undefined)[] = [];
  await expect
    .poll(
      async () => {
        const { snapshots } = await exportData(page);
        matches = accountIds.map((id) => snapshots.find((s) => s.accountId === id && predicate(s)));
        const missing = accountIds.filter((_, i) => !matches[i]);
        return missing.length === 0 ? "matched" : `still missing ${missing.length}: ${missing}`;
      },
      { message, timeout },
    )
    .toBe("matched");
  const found = matches.filter((s): s is ExportedSnapshot => s !== undefined);
  if (found.length !== accountIds.length) throw new Error(message);
  return found;
}

/** 单个账户的版本(上面那条的常用形态)。 */
export async function waitForSnapshot(
  page: Page,
  accountId: string,
  predicate: (s: ExportedSnapshot) => boolean,
  message: string,
): Promise<ExportedSnapshot> {
  const [snapshot] = await waitForSnapshots(page, [accountId], predicate, message);
  if (!snapshot) throw new Error(message);
  return snapshot;
}
