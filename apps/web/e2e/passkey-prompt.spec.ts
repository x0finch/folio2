import { dismissPasskeyPrompt, enableLock, lockNow, signUpAndLogin } from "./fixtures/app";
import { expect, test } from "./fixtures/test";

// 登录后那个「加个 passkey 吧」的引导。判定本身是纯函数、有单测(shouldPromptForPasskey),这里验的是
// 整页真的弹了 / 真的没弹 —— 三个条件里有两个来自 localStorage 和网络,单测替不了。
// 设置页的登出**带二次确认**(它在日常界面里、误点概率高);锁屏那个刻意没有(那是「我进不去了」的
// 兜底,再挡一道只会添堵)。确认按钮和触发按钮同名,靠 destructive 变体区分。
async function signOutFromSettings(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: /sign out/i }).click();
  await page.locator("button.bg-destructive").click();
  await expect(page).toHaveURL(/\/login/);
}

test.describe("passkey 引导", () => {
  // 走 UI 注册(而不是 fixtures 那条 HTTP 快捷路),因为引导恰恰挂在表单提交成功之后。
  async function signUpThroughForm(page: import("@playwright/test").Page) {
    const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    await page.goto("/login");
    // 切 tab 这下会被 hydration 吞掉:点击落在 React 挂上 handler 之前就没了(不报错、不生效),于是
    // 留在 Sign in 上 —— 两个 tab 都有 email/password 字段,所以后面照样填得进去,直到找不着「Sign up」
    // 按钮才炸,报错位置离真正的原因隔了三行。CI 上就这么挂过一次。
    //
    // 这里**不能**像设置页那样等一个「只有客户端才会发的请求」当探针:登录页那个请求是 passkey 的
    // conditional-UI autofill,而这组里有一条测试故意把 PublicKeyCredential 拿掉 —— 那条路下探针
    // 永远不来。改成重试点击直到 tab 真的切过去:点 tab 是幂等的,重复点没有副作用。
    // (这不是等固定时长:条件一满足立刻往下走。)
    await expect(async () => {
      await page.getByRole("tab", { name: /sign up/i }).click();
      await expect(page.getByRole("button", { name: /^sign up$/i })).toBeVisible({ timeout: 500 });
    }).toPass();
    await page.getByLabel(/email/i).fill(`e2e-${suffix}@folio.test`);
    await page.getByLabel(/password/i).fill("e2e-password-1234");
    await page.getByRole("button", { name: /^sign up$/i }).click();
  }

  test("首次注册且设备支持 → 弹引导", async ({ page, addAuth }) => {
    await addAuth();
    await signUpThroughForm(page);
    await expect(page.getByText(/sign in faster next time/i)).toBeVisible();
  });

  // 设备压根不支持 passkey 时弹引导是纯添堵 —— 点了也加不上。
  test("设备不支持 passkey → 不弹引导,直接进主页", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, "PublicKeyCredential", {
        value: undefined,
        configurable: true,
      });
    });
    await signUpThroughForm(page);

    await expect(page).toHaveURL(/^[^?]*\/(\?.*)?$/);
    await expect(page.getByText(/sign in faster next time/i)).toHaveCount(0);
  });

  test("账户里已经有 passkey → 再登录不再弹引导", async ({ page, addAuth }) => {
    await addAuth();
    // enableLock 会真注册一条 passkey,然后我们登出再用同一个账号登回来。
    await enableLock(page);
    const email = await page.evaluate(async () => {
      const res = await fetch("/api/auth/get-session", { credentials: "include" });
      const session = (await res.json()) as { user?: { email?: string } } | null;
      return session?.user?.email ?? "";
    });
    expect(email).toBeTruthy();

    // 清掉「别再问我」,把引导的另外两个条件排除掉,只留「账户已有 passkey」这一个。
    await page.evaluate(() => localStorage.removeItem("folio_passkey_prompt_dismissed"));
    await signOutFromSettings(page);

    await page.getByLabel(/email/i).fill(email);
    await page.getByLabel(/password/i).fill("e2e-password-1234");
    await page.getByRole("button", { name: /^sign in$/i }).click();

    await expect(page).toHaveURL(/^[^?]*\/(\?.*)?$/);
    await expect(page.getByText(/sign in faster next time/i)).toHaveCount(0);
  });

  test("点过「别再问我」→ 这台设备不再问", async ({ page, addAuth }) => {
    await addAuth();
    await signUpThroughForm(page);
    await expect(page.getByText(/sign in faster next time/i)).toBeVisible();
    await page.getByRole("button", { name: /don't ask again/i }).click();
    await expect(page).toHaveURL(/^[^?]*\/(\?.*)?$/);

    // 「别再问我」是**按设备**记的(passkey 本就每设备注册,某台关掉不该波及别台),所以它落在
    // localStorage 而不是账户上 —— 换个 context 就等于换台设备,还会再问。这里只验本设备不再问。
    await signUpThroughForm(page);
    await expect(page.getByText(/sign in faster next time/i)).toHaveCount(0);
  });
});

test.describe("会话过期与锁屏", () => {
  test("锁屏摆很久、会话已过期 → 按指纹仍能进,不丢现场", async ({ page, addAuth }) => {
    await addAuth();
    await enableLock(page);
    await page.goto("/settings");
    await lockNow(page);

    // 把会话 cookie 删掉,模拟「锁屏摆了一夜,会话已经过期」。
    const cookies = await page.context().cookies();
    await page.context().clearCookies();
    expect(cookies.length).toBeGreaterThan(0);

    // 解锁走的是 signIn.passkey,它会**重建**会话 —— 所以这里应该还进得去,而不是掉回登录页
    // 让用户重新输密码(那就等于锁屏白挡了一场)。
    await page.getByRole("button", { name: /unlock with passkey/i }).click();
    await expect(page.getByRole("switch", { name: /auto-lock/i })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/settings");
  });

  test("未登录的人拿到一台锁着的机器 → 去登录页,不是锁屏", async ({ page }) => {
    await signUpAndLogin(page);
    await dismissPasskeyPrompt(page);
    await page.goto("/settings");
    await signOutFromSettings(page);

    // 登出会清掉锁状态(clearIdleLockState),但就算有人手动塞回去,登录页也不该变成锁屏 ——
    // 锁只挂在已登录区。
    await page.evaluate(() => {
      localStorage.setItem("folio_lock_enabled", "1");
      localStorage.setItem("folio_lock_locked", String(Date.now()));
      localStorage.setItem("folio_lock_device_passkey", "stale-credential");
    });
    await page.goto("/");
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole("button", { name: /unlock with passkey/i })).toHaveCount(0);
  });
});
