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

  // 用例 2:验证过不去时,开关弹回关闭,什么都没变。
  //
  // 用「认证器根本不支持用户验证」来制造失败,而不是 setUserVerified(false):后者在 CDP 里表达的是
  // 「用户还没按」——ceremony 会挂着等到 60s 超时,不是当场被拒。虚拟认证器**没有**「用户点了取消」
  // 这个原语(取消是浏览器 UI 的行为,CDP 只能描述认证器的能力),所以这里换成能忠实表达的那一种。
  //
  // 这条是唯一能证明 `userVerification: "required"` 在**注册**环节真被强制的测试:没有 UV 能力的
  // 认证器进不来,凭据压根建不出来。(解锁那一环的 required 强制不了 —— better-auth 的认证 options
  // 硬编码 "preferred",服务端 verify 又写着 requireUserVerification: false,见 ADR 0029 的后续修正。)
  //
  // **不断言错误提示**:实测这种情况下浏览器不会返回失败,而是停在系统那层等一个够用的认证器
  // (真实世界里就是「用其他设备」那个二维码界面),ceremony 一直挂着,所以我们的 toast 永远不出现。
  // 能断言的是结果:凭据没建出来、开关没开、本地什么都没写。
  test("认证器不支持用户验证 → 凭据建不出来,锁开不起来", async ({ page, addAuth }) => {
    const authenticator = await addAuth({
      hasUserVerification: false,
      isUserVerified: false,
    });
    await page.goto("/settings");

    const toggle = page.getByRole("switch", { name: /auto-lock/i });
    await toggle.click();
    // 给 ceremony 一点时间去「成功」——它不该成功。
    await page.waitForTimeout(2_000);

    await expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(await authenticator.credentials()).toHaveLength(0);
    const state = await readLockState(page);
    expect(state.enabled).toBeNull();
    expect(state.deviceCredential).toBeNull();
  });

  // 用例 6:我清了浏览器数据再拨开开关,它没报错卡住,而是让我验一次,验完就开了。
  //
  // 这条是本轮最重要的回归测试。同一个认证器上重复注册会被 excludeCredentials 拒掉(better-auth
  // 服务端硬编码,没有开关),而同一个 iCloud 钥匙串在 Mac 和 iPhone 之间就是**同一个认证器**——
  // 所以「换设备打开开关」必然撞上它。撞上时退到一次断言,拿回本机实际用掉的那条凭据。
  test("本机已有凭据但本地记录丢了 → 转验证一次,照样开得起来", async ({ page, addAuth }) => {
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

    await page.getByRole("switch", { name: /auto-lock/i }).click();
    await expect(page.getByRole("switch", { name: /auto-lock/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    // 认领的应当正是原来那条 —— 而且没有多建一条。
    expect((await readLockState(page)).deviceCredential).toBe(firstCred);
    expect(await authenticator.credentials()).toHaveLength(1);
  });

  // 用例 7(「退到验证时用户取消,开关维持关闭」)**这里测不了**,原因同上:要让注册被
  // excludeCredentials 拒,凭据就必须留在认证器里;而凭据留着的前提下,虚拟认证器没有任何办法把随后
  // 那次断言变成「当场被拒」—— 只能挂着等超时。移除认证器则连注册都不会被拒,场景就变了。
  //
  // 这个分支由单元测试守着(tests/settings-passkey-lock.test.tsx「验证也被取消 → 不写标记,开关维持
  // 关闭」),那里能直接让 signIn.passkey 返回 error。两层各测各自够得到的那一半,别装作都覆盖了。

  // 用例 4 + 5:关掉再打开不用再按指纹,而且原来选的时长还在。
  test("关掉再打开:不再跑 ceremony,时长保持原样", async ({ page, addAuth }) => {
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
    expect((await readLockState(page)).deviceCredential).toBeTruthy(); // 凭据留着

    await toggle.click(); // 再开
    await expect(toggle).toHaveAttribute("aria-checked", "true");

    const state = await readLockState(page);
    expect(state.timeout).toBe("5"); // 时长没被重置回 15
    // 全程只建过一条凭据 —— 关开关不该让人再验一次。
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
