import { dismissPasskeyPrompt, readLockState, signUpAndLogin } from "./fixtures/app";
import { expect, test } from "./fixtures/test";

// 「开启闲置锁」这条路(#353)。单元测试能验「调用参数对不对」,验不了「浏览器会不会真的建出凭据」
// —— 而后者是整套方案的地基:凭据必须落在**这台设备**的认证器里,锁才解得开。
test.describe("开启闲置锁", () => {
  test.beforeEach(async ({ page }) => {
    await signUpAndLogin(page);
    await dismissPasskeyPrompt(page);
  });

  // 用例 1:我从没设过锁,拨开开关,按一下指纹,锁就开了。
  test("拨开开关 → 走一次真 ceremony → 锁开启,凭据落在本机认证器里", async ({ page, addAuth }) => {
    const authenticator = await addAuth();
    await page.goto("/settings");

    const toggle = page.getByRole("switch", { name: /auto-lock/i });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await toggle.click();

    await expect(toggle).toHaveAttribute("aria-checked", "true");
    const state = await readLockState(page);
    expect(state.enabled).not.toBeNull();
    // 关键断言:存下来的必须是认证器里那条凭据的 id —— 证明这不是个「本地打了个勾」的假开关。
    const creds = await authenticator.credentials();
    expect(creds).toHaveLength(1);
    expect(state.deviceCredential).toBe(creds[0]?.credentialId);
  });

  // 用例 3:拨开开关不会先弹一个「确定要开吗」的确认框。
  test("拨开开关不弹自家的确认框 —— 系统的指纹提示已经说清楚了", async ({ page, addAuth }) => {
    await addAuth();
    await page.goto("/settings");
    await page.getByRole("switch", { name: /auto-lock/i }).click();
    await expect(page.getByText(/turn on auto-lock\?/i)).toHaveCount(0);
  });

  // 用例 2:这台机器没有指纹/面容时,开关**直接禁用并说明原因**,而不是让人点了没反应。
  //
  // 为什么必须禁用:这种情况下浏览器**不返回失败** —— 它停在系统那层等一个够格的认证器(真机上就是
  // 「用其他设备」的二维码界面),ceremony 一直挂着,于是我们的错误提示永远不出现。用户按了开关、
  // 关掉系统弹窗,什么都没发生也没有任何解释。所以改成上游拦住:进页面就问一次
  // isUserVerifyingPlatformAuthenticatorAvailable,没有就禁用 + 写清为什么。
  //
  // 用「认证器不支持用户验证」造这个状态,而不是 setUserVerified(false):后者在 CDP 里表达的是
  // 「用户还没按」,ceremony 会挂到 60s 超时。虚拟认证器**没有**「用户点了取消」这个原语(取消是
  // 浏览器 UI 的行为,CDP 只能描述认证器的能力)。
  test("这台机器没有生物识别 → 开关禁用并说明原因", async ({ page, addAuth }) => {
    const authenticator = await addAuth({
      hasUserVerification: false,
      isUserVerified: false,
    });
    await page.goto("/settings");

    const toggle = page.getByRole("switch", { name: /auto-lock/i });
    await expect(toggle).toBeDisabled();
    await expect(page.getByText(/no fingerprint or face unlock/i)).toBeVisible();

    // 禁用不是摆设:凭据没建出来,本地也什么都没写。
    expect(await authenticator.credentials()).toHaveLength(0);
    const state = await readLockState(page);
    expect(state.enabled).toBeNull();
    expect(state.deviceCredential).toBeNull();
  });

  // 用例 6:我清了浏览器数据再拨开开关,它没报错卡住,而是让我验一次,验完就开了。
  //
  // 账户里已经有 passkey 了 → **先验证,压根不碰注册**。这条同时钉住顺序:反过来先注册的话,同一个
  // 认证器会被 excludeCredentials 拒(better-auth 服务端硬编码),而平台通常先弹一次系统窗口、验完
  // 才说「已经有了」—— 用户白按一次指纹还得再验一遍。同一个 iCloud 钥匙串在 Mac 和 iPhone 之间就是
  // 同一个认证器,所以这是换设备打开开关的常规路径。
  test("本地记录丢了 → 先验证、认领回原来那条,不新建凭据", async ({ page, addAuth }) => {
    const authenticator = await addAuth();
    await page.goto("/settings");

    // 先正常开一次,让认证器里有一条凭据。
    await page.getByRole("switch", { name: /auto-lock/i }).click();
    await expect(page.getByRole("switch", { name: /auto-lock/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    const firstCred = (await authenticator.credentials())[0]?.credentialId;
    expect(firstCred).toBeTruthy();

    // 模拟「清了站点数据 / 换了浏览器 profile」:本地记录没了,凭据还在认证器里。
    await page.evaluate(() => {
      localStorage.removeItem("folio_lock_device_passkey");
      localStorage.removeItem("folio_lock_enabled");
    });
    await page.reload();

    // 抓请求来证明走的是哪条路:验证发生了,而注册选项压根没请求过。
    const verified = page.waitForResponse((r) =>
      r.url().includes("/passkey/verify-authentication"),
    );
    const registerOptions: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/passkey/generate-register-options")) registerOptions.push(r.url());
    });

    await page.getByRole("switch", { name: /auto-lock/i }).click();
    await expect(page.getByRole("switch", { name: /auto-lock/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await verified;
    expect(registerOptions).toHaveLength(0); // 没有白跑一次注册

    // 认领的正是原来那条,认证器里也没多出凭据。
    expect((await readLockState(page)).deviceCredential).toBe(firstCred);
    expect(await authenticator.credentials()).toHaveLength(1);
  });

  // 「验证也被用户取消,于是开关维持关闭」**这里测不了**:取消是浏览器 UI 的行为,而 CDP 只能描述
  // 认证器的能力 —— setUserVerified(false) 的语义是「还没按」,ceremony 会挂到 60s 超时而不是当场被拒。
  //
  // 这个分支由单元测试守着(tests/settings-passkey-lock.test.tsx 里「验证没过、注册也没成 → 不写标记,
  // 开关维持关闭」),那里能直接让 signIn.passkey 返回 error。两层各测各自够得到的那一半,别装作
  // 都覆盖了。

  // 用例 4 + 5:关掉再打开**要重新验一次**(#353 后续决定:开启闲置锁是把「遮住持仓」交给生物识别,
  // 该由此刻在键盘前的人证明,不能由上次留下的一条 localStorage 记录代劳),而原来选的时长要留着。
  test("关掉再打开:要重新验一次,但时长保持原样", async ({ page, addAuth }) => {
    const authenticator = await addAuth();
    await page.goto("/settings");

    const toggle = page.getByRole("switch", { name: /auto-lock/i });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");

    // 选一个非默认档,好验证它没被重置。
    await page.getByRole("tab", { name: "5", exact: true }).click();
    await expect.poll(async () => (await readLockState(page)).timeout).toBe("5");

    await toggle.click(); // 关
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    expect((await readLockState(page)).deviceCredential).toBeTruthy(); // 凭据记录留着

    // 再开:必须真的又验一遍。
    const verified = page.waitForResponse((r) =>
      r.url().includes("/passkey/verify-authentication"),
    );
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await verified;

    const state = await readLockState(page);
    expect(state.timeout).toBe("5"); // 时长是偏好,没被重置回 15
    // 验证不是注册 —— 全程只有一条凭据,不会因为反复开关攒出一堆。
    expect(await authenticator.credentials()).toHaveLength(1);
  });

  // 用例 22:锁关着的时候,时长那排是灰的、点不动。
  test("锁关着时时长行灰化且点不动", async ({ page, addAuth }) => {
    await addAuth();
    await page.goto("/settings");

    const gate = page.locator('[aria-disabled="true"]').filter({ has: page.getByRole("tablist") });
    await expect(gate).toBeVisible();
    await expect(gate).toHaveClass(/pointer-events-none/);
  });
});
