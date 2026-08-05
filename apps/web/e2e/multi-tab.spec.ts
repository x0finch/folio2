import {
  dismissPasskeyPrompt,
  enableLock,
  gotoHydrated,
  KEYS,
  lockNow,
  readLockState,
} from "./fixtures/app";
import { expect, test } from "./fixtures/test";

// 同一个人开着好几个标签 —— 这块之前一条测试都没有,而它正是「换个标签就绕过了」最可能藏身的地方。
//
// 同一个 browser context 里的两个 page 共享 cookie 和 localStorage,storage 事件也跨 page 触发,
// 所以这里能真实地测到跨标签同步(而不是模拟)。
test.describe("多个标签页", () => {
  test("一个标签锁上了 → 另一个标签也锁上", async ({ page, addAuth }) => {
    await addAuth();
    await enableLock(page);

    const other = await page.context().newPage();
    await gotoHydrated(other, "/settings");
    await expect(other.getByRole("switch", { name: /auto-lock/i })).toBeVisible();

    // 第一个标签闲置到锁上。
    await page.goto("/");
    await lockNow(page);

    // 另一个标签必须跟着锁 —— 否则换个标签就等于绕过。它靠 storage 事件收到「已锁」这个变化。
    await expect(other.getByRole("button", { name: /unlock with passkey/i })).toBeVisible();
    await other.close();
  });

  test("锁着的时候新开一个标签直接进 → 也是锁的", async ({ page, addAuth }) => {
    await addAuth();
    await enableLock(page);
    await page.goto("/");
    await lockNow(page);

    // 新标签挂载时会比对时间戳,不该因为「刚打开」就放行。
    const fresh = await page.context().newPage();
    await fresh.goto("/");
    await expect(fresh.getByRole("button", { name: /unlock with passkey/i })).toBeVisible();
    await fresh.close();
  });

  // 方向是**不对称的,而且是刻意的**(use-idle-lock.ts 里写明):锁要同步 —— 否则「一个标签锁了、
  // 复制网址新开一个就没锁」就是现成的旁路;解锁不同步 —— 每个已锁的标签各自要求一次在场证明,
  // 比一处解锁全场放行更保守。这条测试钉住这个不对称,免得日后有人当 bug「顺手修掉」。
  test("在一个标签解锁 → 另一个标签仍然锁着(刻意不同步解锁)", async ({ page, addAuth }) => {
    await addAuth();
    await enableLock(page);

    const other = await page.context().newPage();
    await other.goto("/settings");

    await page.goto("/settings");
    await lockNow(page);
    await expect(other.getByRole("button", { name: /unlock with passkey/i })).toBeVisible();

    await page.getByRole("button", { name: /unlock with passkey/i }).click();
    await expect(page.getByRole("switch", { name: /auto-lock/i })).toBeVisible();

    // 另一个标签还挡着 —— 它也得自己验一次。
    await expect(other.getByRole("button", { name: /unlock with passkey/i })).toBeVisible();
    // 共享的锁标志已被第一个标签清掉,所以这不是「被别人锁死」,只是它自己还没验。
    expect((await readLockState(other)).locked).toBeNull();

    // 「它自己点一下也能解开」这半**在这个环境里验不了**:CDP 虚拟认证器绑在单个页面的 target 上,
    // 新标签没有认证器,也没法把凭据共享过去。真机上是同一个系统钥匙串,不存在这个问题。
    await other.close();
  });

  test("锁屏摆着,在另一个标签登出 → 不会卡在解不开也退不出的锁屏", async ({ page, addAuth }) => {
    await addAuth();
    await enableLock(page);
    await page.goto("/");
    await lockNow(page);

    const other = await page.context().newPage();
    await other.goto("/settings");
    // 另一个标签此刻也是锁屏(上一条测过)。**先等锁屏真的出现**再点登出:设置页自己也有一个同名的
    // 登出按钮(账户卡里那个),服务端就渲染出来了 —— 不等的话可能点在那一个上,而它要弹二次确认。
    await expect(other.getByRole("button", { name: /unlock with passkey/i })).toBeVisible();
    await other.getByRole("button", { name: /sign out/i }).click();
    await expect(other).toHaveURL(/\/login/);

    // 第一个标签:会话没了。它可能还显示着锁屏,但**必须能走掉** —— 点登出要落到登录页,
    // 而不是卡在一个既解不开(没会话)又退不出的界面上。
    // 两条路都算通过:路由守卫发现没会话就直接送去登录页,或者它还停在锁屏、那就得能从锁屏走掉。
    // 用 toPass 是因为不知道会走哪条,而不是为了等一段时间 —— 条件一满足立刻返回。
    await page.reload();
    await expect(async () => {
      if (!page.url().includes("/login")) {
        const signOut = page.getByRole("button", { name: /sign out/i });
        if (await signOut.count()) await signOut.first().click();
      }
      expect(page.url()).toMatch(/\/login/);
    }).toPass();
    await other.close();
  });

  test("一个标签开着锁,另一个标签把那条凭据删了 → 标记两边都清,锁两边都还在", async ({
    page,
    addAuth,
  }) => {
    await addAuth();
    await enableLock(page);
    const before = await readLockState(page);
    expect(before.deviceCredential).toBeTruthy();

    // 另一个标签走 UI 删掉本机那条。
    const other = await page.context().newPage();
    await other.goto("/settings");
    await other
      .locator("div")
      .filter({ has: other.getByRole("button", { name: /^remove$/i }) })
      .filter({ has: other.getByText(/^this device$/i) })
      .last()
      .getByRole("button", { name: /^remove$/i })
      .click();
    await expect(other.getByText(/remove passkey\?/i)).toBeVisible();
    await other.locator("button.bg-destructive").click();
    await expect(other.getByText(/passkey removed/i)).toBeVisible();

    // 删除那一侧立刻清标记(同一 context 共享 storage,所以第一个标签也看得到)。
    await expect.poll(async () => (await readLockState(other)).deviceCredential).toBeNull();

    // 第一个标签重新进设置页:锁**照旧开着** —— 删一条凭据不代表用户要撤掉锁,而且解锁看的是
    // 系统钥匙串而不是这个标记。同时给出「怎么重新登记」那句提示。
    await page.reload();
    await expect(page.getByRole("switch", { name: /auto-lock/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(page.getByText(/no passkey is registered for this device/i)).toBeVisible();
    await other.close();
  });
});

test.describe("手快、网慢", () => {
  test("飞快连点开关两下 → 只跑一次流程,只建一条凭据", async ({ page, addAuth }) => {
    const authenticator = await addAuth();
    await page.goto("/login");
    await dismissPasskeyPrompt(page);
    const { signUpAndLogin } = await import("./fixtures/app");
    await signUpAndLogin(page);
    await dismissPasskeyPrompt(page);
    await gotoHydrated(page, "/settings");

    const toggle = page.getByRole("switch", { name: /auto-lock/i });
    // 两下之间不给任何等待:第二下要么被 disabled 挡住,要么落在 busy 置上之前那个窗口里。
    await toggle.click();
    await toggle.click({ force: true, noWaitAfter: true }).catch(() => {});

    await expect(toggle).toHaveAttribute("aria-checked", "true");
    // 无论如何都不该攒出第二条凭据。
    expect(await authenticator.credentials()).toHaveLength(1);
  });

  test("反复开关十几次 → 凭据数量不涨", async ({ page, addAuth }) => {
    const authenticator = await addAuth();
    await enableLock(page);

    const toggle = page.getByRole("switch", { name: /auto-lock/i });
    for (let i = 0; i < 6; i++) {
      // 每一步都等状态真的落到 localStorage 再点下一下 —— 只看 aria 会撞上「开」那一步的异步尾巴
      // (claim 里还要 await 刷新列表),下一次点击就会打在半完成的状态上。
      await toggle.click(); // 关
      await expect.poll(async () => (await readLockState(page)).enabled).toBeNull();
      await toggle.click(); // 开(每次都会重新验证)
      await expect.poll(async () => (await readLockState(page)).enabled).not.toBeNull();
    }

    // 重新开启走的是验证而不是注册,所以凭据永远只有一条 —— 这条同时防住「每次开锁都新注册」这种回归。
    expect(await authenticator.credentials()).toHaveLength(1);
  });

  test("验证过了但紧接着刷新列表失败 → 开关与本地记录不打架", async ({ page, addAuth }) => {
    await addAuth();
    await enableLock(page);
    const enabled = await readLockState(page);

    // 关掉,然后把列表接口打断,再重新开启。
    const toggle = page.getByRole("switch", { name: /auto-lock/i });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");

    await page.route("**/passkey/list-user-passkeys", (route) => route.abort("failed"));
    // 等两件**确定会发生的事**,而不是等一个拍脑袋的时长:
    // ① 列表拉不动 → 代码退到注册 → `generate-register-options` 必然发出。
    //    (别等 `verify-registration`:这台认证器上已经有一条凭据了,服务端下发的 excludeCredentials
    //    会让浏览器当场拒掉,压根走不到 verify —— 我一开始就等错了这个,15 秒超时。)
    // ② 收尾时 finally 里 setBusy(false),开关从 ceremony 期间的 disabled 变回可用 = 流程真跑完了。
    const registerStarted = page.waitForResponse((r) =>
      r.url().includes("passkey/generate-register-options"),
    );
    await toggle.click();
    await registerStarted;
    await expect(toggle).toBeEnabled();

    // 列表拉不动时:要么老老实实没开(报错),要么开了 —— 但**不能**出现「开关开着却没有凭据记录」
    // 这种自相矛盾的状态,那正是「显示受保护实际没有」的来源。
    const after = await readLockState(page);
    const switchOn = await toggle.getAttribute("aria-checked");
    if (switchOn === "true") {
      expect(after.deviceCredential).toBeTruthy();
    } else {
      expect(after.enabled).toBeNull();
    }
    // 而且原来那条凭据记录不该被这次失败清掉。
    expect(after.deviceCredential ?? enabled.deviceCredential).toBeTruthy();
    await page.unroute("**/passkey/list-user-passkeys");
  });
});

test.describe("本地记录被改坏 / 存不进去", () => {
  test("本地存储写不进去(隐私模式)→ 不崩,且不假装开成功", async ({ page, addAuth }) => {
    await addAuth();
    const { signUpAndLogin } = await import("./fixtures/app");
    await signUpAndLogin(page);
    await dismissPasskeyPrompt(page);

    // 让 setItem 一律抛错(隐私模式 / 配额写满都是这个表现),但读取仍可用。
    await page.addInitScript(() => {
      const proto = Object.getPrototypeOf(localStorage);
      proto.setItem = () => {
        throw new DOMException("QuotaExceededError");
      };
    });
    await gotoHydrated(page, "/settings");

    const toggle = page.getByRole("switch", { name: /auto-lock/i });
    // 同上:等注册真的开始 + 等 busy 清掉,不等固定时长。写不进 localStorage 不影响 ceremony 本身,
    // 所以这两个信号照样会到。
    const registerStarted = page.waitForResponse((r) =>
      r.url().includes("passkey/generate-register-options"),
    );
    await toggle.click();
    await registerStarted;
    await expect(toggle).toBeEnabled();

    // 关键是别把页面搞崩、也别显示成「已开启」——写不进去就等于下次打开还得重来,那就别谎报。
    await expect(page.getByRole("switch", { name: /auto-lock/i })).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  test("把本机记录改成账户里另一条真实凭据 → 自纠不清它,但标记会挂错行", async ({
    page,
    addAuth,
  }) => {
    await addAuth();
    await enableLock(page);

    // 再用加号(不限认证器)从一个 USB 钥匙加一条,凑出两行。
    const usb = await addAuth({ transport: "usb", hasResidentKey: false });
    await page.getByRole("button", { name: /add passkey/i }).click();
    await expect(page.getByText(/passkey added/i)).toBeVisible();
    const usbCred = (await usb.credentials())[0]?.credentialId;
    expect(usbCred).toBeTruthy();

    // 把本机标记指向那条 USB 凭据(它确实在账户列表里,所以自纠找不出问题)。
    await page.evaluate(({ keys, id }) => localStorage.setItem(keys.deviceCredential, id), {
      keys: KEYS,
      id: usbCred as string,
    });
    await page.reload();

    // 自纠只管「这条还在不在账户里」,不管「它是不是真的在本机」——所以标记留着,badge 挂到了 USB 那行。
    // 这只是显示不准,不会把人锁在门外:解锁走的是系统的凭据选择,不看这个标记。
    expect((await readLockState(page)).deviceCredential).toBe(usbCred);
    await expect(page.getByText(/^this device$/i)).toHaveCount(1);

    // 兜底确认锁仍然解得开(平台认证器那条凭据还在)。
    await page.goto("/");
    await lockNow(page);
    await page.getByRole("button", { name: /unlock with passkey/i }).click();
    await expect(page.getByRole("button", { name: /unlock with passkey/i })).toHaveCount(0);
  });
});
