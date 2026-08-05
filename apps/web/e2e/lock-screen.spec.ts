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

  // 用例 5:我正在填东西,锁屏了,回来输入是空的。
  //
  // 这是**有意的**代价,不是 bug:锁定时 children 是卸载而不是遮罩盖住,所以 DOM 里不留内容(删掉
  // 遮罩底下也看不到数据),换来的是组件本地态全丢 —— 半填的表单、滚动位置、展开状态。数据本身在
  // 更外层的 QueryClient 缓存里,重挂从缓存出、不重拉。见 ADR 0029 与 lock-screen.tsx 的注释。
  test("锁屏会卸载页面 → 半填的输入回来是空的,DOM 里也不留内容", async ({ page }) => {
    await page.goto("/settings");
    // 拿 passkey 那行的就地重命名当「用户正在输入」的样本 —— beforeEach 开锁时刚建了一条,它的名字是
    // 设备标签(Chrome on …),点一下进编辑态。
    await page
      .getByRole("button", { name: /chrome|chromium/i })
      .first()
      .click();
    // 用 role 定位而不是 input[type=text]:@folio/ui 的 Input 不显式设 type,属性选择器匹配不到。
    const input = page.getByRole("textbox").first();
    await input.fill("半填的内容");
    await expect(input).toHaveValue("半填的内容");

    await travelPastIdle(page, 15);
    await page.reload();
    await expect(page.getByRole("button", { name: /unlock with passkey/i })).toBeVisible();
    // 锁着的时候底下内容压根不在 DOM 里 —— 遮罩不是「盖住」,是替换。
    await expect(page.getByRole("switch", { name: /auto-lock/i })).toHaveCount(0);

    await page.getByRole("button", { name: /unlock with passkey/i }).click();
    await expect(page.getByRole("switch", { name: /auto-lock/i })).toBeVisible();
    // 输入框回到未编辑态,刚才敲的内容没有留下。
    await expect(page.getByRole("textbox")).toHaveCount(0);
    await expect(page.getByText("半填的内容")).toHaveCount(0);
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

  // 本机凭据记录没了(清过站点数据 / 在别的设备上删了那条)→ **照锁**。曾经这里是「绝不上锁」,
  // 理由是别把人关在门外;但记录为空最常见的成因恰恰是清站点数据,那正是最像「有人在动这台机器」的
  // 时刻,放行等于把持仓摊开。而门一直是开着的:锁屏上有登出。
  test("本机没有凭据记录 → 照样上锁,并留着登出这条路", async ({ page }) => {
    await page.goto("/");
    await setLockState(page, { enabled: true, deviceCredential: null });
    await travelPastIdle(page, 15);
    await page.reload();

    await expect(page.getByRole("button", { name: /unlock with passkey/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /sign out/i })).toBeVisible();
    // 别让人对着解锁按钮反复按 —— 先说清这台设备没登记凭据。
    await expect(page.getByText(/no passkey is registered for this device/i)).toBeVisible();
  });

  // 关键:上一条锁住之后真的出得去。登出 → 用邮箱密码登回来 → 进得去内容页,不是「锁屏 → 登出 →
  // 又锁屏」成环(clearIdleLockState 的作用,见 use-idle-lock.ts)。
  test("没有凭据被锁住 → 登出再用密码登回来,能进去", async ({ page }) => {
    const email = await page.evaluate(async () => {
      const res = await fetch("/api/auth/get-session", { credentials: "include" });
      return ((await res.json()) as { user?: { email?: string } } | null)?.user?.email ?? "";
    });
    expect(email).toBeTruthy();

    await page.goto("/");
    await setLockState(page, { enabled: true, deviceCredential: null });
    await travelPastIdle(page, 15);
    await page.reload();
    await expect(page.getByRole("button", { name: /unlock with passkey/i })).toBeVisible();

    await page.getByRole("button", { name: /sign out/i }).click();
    await expect(page).toHaveURL(/\/login/);
    // 锁屏的登出是客户端跳转(signOut → navigate),落地后表单还会再重挂一次 —— 直接填会撞上
    // "element was detached"。reload 一下拿一个干净的挂载,不影响这条要验的东西。
    await page.reload();
    await page.getByLabel(/email/i).fill(email);
    await page.getByLabel(/password/i).fill("e2e-password-1234");
    await page.getByRole("button", { name: /^sign in$/i }).click();

    await expect(page).toHaveURL(/^[^?]*\/(\?.*)?$/);
    await expect(page.getByRole("button", { name: /unlock with passkey/i })).toHaveCount(0);
  });

  // 开关显示的是开关键本身 —— 它就是「真的在锁」。曾经这里显示关闭 + 「当前并未锁定」,那是
  // 「没凭据就放行」时代的说法;现在要说的是「怎么把凭据重新登记上」。
  test("开关键还在但凭据记录没了 → 开关仍显示开启,并提示重新登记", async ({ page }) => {
    await page.goto("/settings");
    await setLockState(page, { enabled: true, deviceCredential: null });
    await page.reload();

    await expect(page.getByRole("switch", { name: /auto-lock/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(page.getByText(/no passkey is registered for this device/i)).toBeVisible();
  });
});
