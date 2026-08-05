import { enableLock, KEYS, lockNow, readLockState } from "./fixtures/app";
import { expect, test } from "./fixtures/test";

// 对抗视角:拿着锁屏找漏子。
//
// **先摆明边界**:这层锁只封前端 DOM,ADR 0029 把「懂技术的人能绕」写成了明确取舍(威胁模型是防
// 顺手偷看,不是防设备丢失)。所以这个文件里有两类测试,别混:
// ① 真该拦住的 —— 换页面、后退、打印、键盘焦点。这些是普通用户碰得到的路径,漏了就是真漏。
// ② 固化取舍的 —— 手改 localStorage、直接打后端接口。这些**测的是「就到这儿为止」**,免得将来有人
//    读了代码以为它防得住,或者反过来把取舍无意扩大。断言写的是现状,不是期望。
test.describe("绕过锁屏的尝试", () => {
  test.beforeEach(async ({ page, addAuth }) => {
    await addAuth();
    await enableLock(page);
  });

  test("锁着的时候改地址栏去别的页面 → 还是锁着", async ({ page }) => {
    await page.goto("/");
    await lockNow(page);

    // 锁挂在整个已登录区,不是某一页 —— 换条路进来一样锁。
    await page.goto("/accounts");
    await expect(page.getByRole("button", { name: /unlock with passkey/i })).toBeVisible();
    await page.goto("/insights");
    await expect(page.getByRole("button", { name: /unlock with passkey/i })).toBeVisible();
  });

  test("锁着的时候按后退 → 还是锁着", async ({ page }) => {
    await page.goto("/");
    await page.goto("/settings"); // 攒一条历史
    await lockNow(page);

    await page.goBack();
    // 从历史(含 bfcache)恢复的页面也要落回锁屏 —— 恢复时会重新比对时间戳。
    await expect(page.getByRole("button", { name: /unlock with passkey/i })).toBeVisible();
  });

  // 遮罩是 fixed 定位的,而打印会把整个文档铺开 —— 这是最容易漏出内容的一条路。
  // 这里靠 children 被卸载兜底(不是靠 print 样式),所以打印视图下底下压根没有东西可铺。
  test("锁着的时候打印 → 打出来的是锁屏,不是持仓", async ({ page }) => {
    await page.goto("/settings");
    await lockNow(page);

    await page.emulateMedia({ media: "print" });
    await expect(page.getByRole("button", { name: /unlock with passkey/i })).toBeVisible();
    // 设置页的内容在打印视图下也不该冒出来。
    await expect(page.getByRole("switch", { name: /auto-lock/i })).toHaveCount(0);
    await expect(page.getByText(/provider api keys/i)).toHaveCount(0);
    await page.emulateMedia({ media: null });
  });

  test("锁着的时候按 Tab → 焦点走不到遮罩底下", async ({ page }) => {
    await page.goto("/settings");
    await lockNow(page);

    // 连按几次,把可聚焦元素走一圈。
    for (let i = 0; i < 8; i++) await page.keyboard.press("Tab");

    // 焦点必须落在锁屏自己的东西上(解锁 / 登出 / 语言 / 主题),而不是底层页面 —— 底层已经卸载,
    // 所以真正的断言是「设置页那些控件压根不存在」。
    const focusedText = await page.evaluate(
      () => (document.activeElement as HTMLElement | null)?.innerText ?? "",
    );
    expect(focusedText).not.toMatch(/sign out this device|provider|valuation/i);
    await expect(page.getByRole("switch", { name: /auto-lock/i })).toHaveCount(0);
  });

  test("锁着的时候底层滚动被锁住", async ({ page }) => {
    await page.goto("/settings");
    await lockNow(page);

    // 锁定期间 html/body 都要 overflow:hidden —— 否则滚轮会穿透到底下的 App(scroll chaining)。
    const overflow = await page.evaluate(() => ({
      root: getComputedStyle(document.documentElement).overflow,
      body: getComputedStyle(document.body).overflow,
    }));
    expect(overflow.root).toBe("hidden");
    expect(overflow.body).toBe("hidden");
  });

  // ↓↓↓ 以下是「固化取舍」,断言的是现状。改动这些断言等于改动威胁模型,应当先改 ADR 0029。 ↓↓↓

  // 这条原来写的是「清掉『已锁』标记就绕过了」,**断言的是一件假的事**:只清那个标记不够,重载后
  // 挂载时还会拿「最后活跃」时间戳比一次,陈旧就重新锁上。它当初能过是因为断言偶尔抢在 hydration
  // 之前采到了服务端渲染的那一帧 —— CI 上被 flaky 闸门抓出来才发现。拆成两条,各说一件真事。
  test("只清「已锁」标记不够 → 重载后挂载比对会重新锁上", async ({ page }) => {
    await page.goto("/settings");
    await lockNow(page);

    await page.evaluate((keys) => localStorage.removeItem(keys.locked), KEYS);
    await page.reload();

    // 跨标签用的那个共享标记只是其中一半;真正判「该不该锁」的是时间戳。
    await expect(page.getByRole("button", { name: /unlock with passkey/i })).toBeVisible();
  });

  test("把闲置锁的本地状态清干净能绕过 —— ADR 0029 明确接受的代价", async ({ page }) => {
    await page.goto("/settings");
    await lockNow(page);

    // 会绕的人不会只删一个键。两个都清掉 = 「刚刚才活跃过、也没人锁着」。
    await page.evaluate((keys) => {
      localStorage.removeItem(keys.locked);
      localStorage.removeItem(keys.lastActive);
    }, KEYS);
    await page.reload();

    // 绕过了。锁只封前端 DOM,这条路要堵得做服务端锁 —— 见 ADR 0029 的 Considered Options。
    await expect(page.getByRole("switch", { name: /auto-lock/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /unlock with passkey/i })).toHaveCount(0);
  });

  test("把「最后活跃」改到未来 → 不会锁(时钟回拨保守不锁)", async ({ page }) => {
    await page.goto("/settings");
    await page.evaluate(
      (keys) => localStorage.setItem(keys.lastActive, String(Date.now() + 60 * 60_000)),
      KEYS,
    );
    await page.reload();

    // shouldLock 见到 now < lastActiveAt 就保守不锁 —— 这是为了时钟异常时不误锁打扰用户,
    // 代价是手改时间戳能绕。同上,属已知取舍。
    await expect(page.getByRole("button", { name: /unlock with passkey/i })).toHaveCount(0);
    expect((await readLockState(page)).locked).toBeNull();
  });

  test("锁着的时候直接打后端接口 → 照样拿得到数据(服务端没有这层锁)", async ({ page }) => {
    await page.goto("/settings");
    await lockNow(page);

    // 前端锁不给服务端加任何限制,会话也没销毁(「解锁」不是重新登录)。想堵这条得做服务端锁,
    // 那是另一件事,不在 ADR 0029 的范围里。
    const status = await page.evaluate(async () => {
      const res = await fetch("/api/export", { credentials: "include" });
      return res.status;
    });
    expect(status).toBe(200);
  });
});

test.describe("还没登录的时候", () => {
  test("没登录直接访问首页 → 去登录页,不会冒出锁屏", async ({ page }) => {
    // 上一个人留下的锁状态也不该让登录页变成锁屏 —— 锁只挂在已登录区。
    await page.goto("/login");
    await page.evaluate((keys) => {
      localStorage.setItem(keys.enabled, "1");
      localStorage.setItem(keys.deviceCredential, "someones-old-credential");
      localStorage.setItem(keys.locked, "1");
    }, KEYS);

    await page.goto("/");
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole("button", { name: /unlock with passkey/i })).toHaveCount(0);
  });
});
