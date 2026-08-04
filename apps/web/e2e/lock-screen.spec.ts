import {
  dismissPasskeyPrompt,
  readLockState,
  setLockState,
  signUpAndLogin,
  travelPastIdle,
} from "./fixtures/app";
import type { VirtualAuthenticator } from "./fixtures/authenticator";
import { expect, test } from "./fixtures/test";

// 锁屏本体(#353)。这里的价值在于「遮罩到底盖不盖得住」——单元测试渲染的是组件,验不了刷新、
// 导航、真解锁这些整页行为。
test.describe("锁屏", () => {
  let authenticator: VirtualAuthenticator;

  // 每条测试都从「锁已经开着、且本机确实有一条可用凭据」起步:凭据是怎么来的由 auto-lock-enable
  // 那组负责,这里只管锁起来之后的事。
  test.beforeEach(async ({ page, addAuth }) => {
    await signUpAndLogin(page);
    await dismissPasskeyPrompt(page);
    authenticator = await addAuth();
    await page.goto("/settings");
    await page.getByRole("switch", { name: /auto-lock/i }).click();
    await expect(page.getByRole("switch", { name: /auto-lock/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  // 用例 9:闲置到时间,持仓被遮住了。
  test("闲置超时 → 遮罩盖上,持仓看不见了", async ({ page }) => {
    await page.goto("/");
    await travelPastIdle(page, 15);
    // 任何一次活动检查都会触发比对;切个可见性最省事。
    await page.reload();

    await expect(page.getByRole("button", { name: /unlock with passkey/i })).toBeVisible();
  });

  // 用例 14:刷新页面绕不过锁屏。
  test("锁着的时候刷新,还是锁着 —— 刷新不是后门", async ({ page }) => {
    await page.goto("/");
    await travelPastIdle(page, 15);
    await page.reload();
    await expect(page.getByRole("button", { name: /unlock with passkey/i })).toBeVisible();

    await page.reload();
    await expect(page.getByRole("button", { name: /unlock with passkey/i })).toBeVisible();
  });

  // 用例 11:锁屏上没有密码框 —— 浏览器记住的密码帮不了任何人。
  //
  // 这就是 #353 的起点:锁屏原来收密码,密码管理器一代填,任何人点一下 Unlock 就进去了。
  test("锁屏上没有密码输入框", async ({ page }) => {
    await page.goto("/");
    await travelPastIdle(page, 15);
    await page.reload();
    await expect(page.getByRole("button", { name: /unlock with passkey/i })).toBeVisible();

    expect(await page.locator('input[type="password"]').count()).toBe(0);
    // 隐藏的 username 也该没了 —— 它当初就是为了让密码管理器认出这是登录表单。
    expect(await page.locator('input[autocomplete*="username"]').count()).toBe(0);
  });

  // 用例 10:我按指纹,遮罩掀开,还是原来那个页面,没让我重新登录。
  test("按指纹解锁 → 遮罩掀开,人还在原来那一页", async ({ page }) => {
    await page.goto("/settings");
    await travelPastIdle(page, 15);
    await page.reload();
    await expect(page.getByRole("button", { name: /unlock with passkey/i })).toBeVisible();

    await page.getByRole("button", { name: /unlock with passkey/i }).click();

    await expect(page.getByRole("button", { name: /unlock with passkey/i })).toHaveCount(0);
    // 没被踢去登录页:URL 还在 /settings,内容也回来了。
    expect(new URL(page.url()).pathname).toBe("/settings");
    await expect(page.getByRole("switch", { name: /auto-lock/i })).toBeVisible();
  });

  // 用例 12:指纹认不过去时,我能从锁屏登出。
  test("指纹认不过去 → 仍能从锁屏登出", async ({ page }) => {
    await page.goto("/");
    await travelPastIdle(page, 15);
    await page.reload();
    await expect(page.getByRole("button", { name: /unlock with passkey/i })).toBeVisible();

    await authenticator.setUserVerified(false);
    await page.getByRole("button", { name: /unlock with passkey/i }).click();
    // 解不开也不该把人困住:登出是明摆着的出路。
    await expect(page.getByRole("button", { name: /sign out/i })).toBeVisible();

    await page.getByRole("button", { name: /sign out/i }).click();
    await expect(page).toHaveURL(/\/login/);
  });

  // 用例 13:我从锁屏登出、重新登录,不会一进去又被锁住。
  //
  // 少了 clearIdleLockState 这一步就会死循环:登出没清「已锁」标记,重新登录进 _authed 又立刻判锁。
  test("从锁屏登出再登录 → 不会一进去又被锁", async ({ page }) => {
    await page.goto("/");
    await travelPastIdle(page, 15);
    await page.reload();
    await expect(page.getByRole("button", { name: /unlock with passkey/i })).toBeVisible();

    await page.getByRole("button", { name: /sign out/i }).click();
    await expect(page).toHaveURL(/\/login/);
    // 「已锁」标记必须被清掉,否则下一次登录直接又落在锁屏。
    expect((await readLockState(page)).locked).toBeNull();

    const user = await signUpAndLogin(page);
    expect(user.email).toBeTruthy();
    await page.goto("/");
    await expect(page.getByRole("button", { name: /unlock with passkey/i })).toHaveCount(0);
  });

  // 用例 23:我改成 1 分钟,闲置一分钟就锁。
  test("时长选 1 分钟 → 过 1 分钟就锁(不到就不锁)", async ({ page }) => {
    await page.goto("/settings");
    await page.getByRole("tab", { name: "1", exact: true }).click();
    await expect.poll(async () => (await readLockState(page)).timeout).toBe("1");

    // 才过 30 秒:不该锁。
    await page.evaluate(() =>
      localStorage.setItem("folio_lock_last_active", String(Date.now() - 30_000)),
    );
    await page.reload();
    await expect(page.getByRole("switch", { name: /auto-lock/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /unlock with passkey/i })).toHaveCount(0);

    // 过了 1 分钟:锁。
    await travelPastIdle(page, 1);
    await page.reload();
    await expect(page.getByRole("button", { name: /unlock with passkey/i })).toBeVisible();
  });

  // 反面兜底:没有本机凭据时**绝不上锁**。宁可不锁,也不要把人关在门外 —— 锁上了却没有解锁手段,
  // 用户只剩登出一条路。
  test("本机没有凭据 → 就算开关开着也不上锁", async ({ page }) => {
    await page.goto("/");
    await setLockState(page, { enabled: true, deviceCredential: null });
    await travelPastIdle(page, 15);
    await page.reload();

    await expect(page.getByRole("button", { name: /unlock with passkey/i })).toHaveCount(0);
  });
});
