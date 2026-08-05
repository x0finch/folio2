import { dismissPasskeyPrompt, gotoHydrated, readLockState, signUpAndLogin } from "./fixtures/app";
import { type AddAuth, expect, test } from "./fixtures/test";

const autoLockToggle = /auto-lock/i;

// Passkeys 卡:两个添加入口刻意不同,以及删除和闲置锁的联动(#353)。
test.describe("Passkeys 卡", () => {
  test.beforeEach(async ({ page }) => {
    await signUpAndLogin(page);
    await dismissPasskeyPrompt(page);
  });

  // 用例 19:我只想用 passkey 登录、不想要锁屏,点右上角加号就能加。
  // 用例 20:加号加的 passkey 不会顺手把锁打开。
  test("加号能加 passkey,但不碰闲置锁", async ({ page, addAuth }) => {
    const authenticator = await addAuth();
    await page.goto("/settings");

    await page.getByRole("button", { name: /add passkey/i }).click();
    await expect(page.getByText(/passkey added/i)).toBeVisible();

    expect(await authenticator.credentials()).toHaveLength(1);
    const state = await readLockState(page);
    // 这条路证明不了「凭据在本机」(可能是安全钥匙、也可能是扫码用了别人的手机),所以不写标记。
    expect(state.deviceCredential).toBeNull();
    expect(state.enabled).toBeNull();
    await expect(page.getByRole("switch", { name: autoLockToggle })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  // 加号刻意**不限** authenticatorAttachment —— 这是硬件安全钥匙在整个应用里唯一的入口。
  test("加号收得下硬件安全钥匙(USB 认证器)", async ({ page, addAuth }) => {
    const key = await addAuth({ transport: "usb", hasResidentKey: false });
    await page.goto("/settings");

    await page.getByRole("button", { name: /add passkey/i }).click();
    await expect(page.getByText(/passkey added/i)).toBeVisible();
    expect(await key.credentials()).toHaveLength(1);
  });

  // 反过来:只插着 USB 钥匙时,闲置锁那个开关**直接是禁用的** —— 它限定本机认证器,而 USB 钥匙
  // 满足不了(凭据不在本机钥匙串里就解不开锁)。这也是同一件事的另一面:能力检测在上游就拦住了,
  // 不会让人点下去然后停在系统的「用其他设备」界面上毫无反应。
  test("只有 USB 钥匙时闲置锁开关是禁用的", async ({ page, addAuth }) => {
    const key = await addAuth({ transport: "usb", hasResidentKey: false });
    await gotoHydrated(page, "/settings");

    await expect(page.getByRole("switch", { name: autoLockToggle })).toBeDisabled();
    await expect(page.getByText(/no fingerprint or face unlock/i)).toBeVisible();
    expect(await key.credentials()).toHaveLength(0);
    expect((await readLockState(page)).enabled).toBeNull();
  });

  // 用例 15:列表里能看出哪条是我这台机器的。
  test("本机那条带「This device」badge,别的没有", async ({ page, addAuth }) => {
    await addTwoRows(page, addAuth);
    // 两行里**只有**本机那条带 badge —— 这才是这个 badge 的意义所在(列表本来看不出来:passkey
    // 会跨设备同步、名字还能改)。
    await expect(page.getByText(/^this device$/i)).toHaveCount(1);
    await expect(page.getByRole("button", { name: /^remove$/i })).toHaveCount(2);
  });

  // 用例 16:我删掉这台机器那条,标记被清掉,但锁还开着 —— 锁是我自己开的,系统不替我撤;
  // 真解不开也有锁屏上的登出。
  test("删掉本机那条 → 清标记并提示重新登记,锁与时长都不动", async ({ page, addAuth }) => {
    await addAuth();
    await gotoHydrated(page, "/settings");
    await page.getByRole("switch", { name: autoLockToggle }).click();
    await expect(page.getByRole("switch", { name: autoLockToggle })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await page.getByRole("tab", { name: "5", exact: true }).click();
    await expect.poll(async () => (await readLockState(page)).timeout).toBe("5");

    await removeRowWithBadge(page);

    await expect.poll(async () => (await readLockState(page)).deviceCredential).toBeNull();
    await expect(page.getByRole("switch", { name: autoLockToggle })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(page.getByText(/no passkey is registered for this device/i)).toBeVisible();
    const state = await readLockState(page);
    expect(state.enabled).not.toBeNull(); // 锁不跟着关
    expect(state.timeout).toBe("5"); // 时长是偏好,不该被连带清掉
  });

  // 用例 17:我删掉另一台设备那条,锁照样开着。
  //
  // 反面同样重要:早先用布尔标记时做不到这种区分,只能退而用「删光了才关」;而「删任何一条都关」
  // 会让人白验一次(重复注册被拒 → 又得走验证)。
  test("删掉别的凭据 → 闲置锁不受影响", async ({ page, addAuth }) => {
    await addTwoRows(page, addAuth);
    const before = await readLockState(page);

    await removeRowWithoutBadge(page);

    await expect(page.getByRole("switch", { name: autoLockToggle })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect((await readLockState(page)).deviceCredential).toBe(before.deviceCredential);
  });

  // 用例 18:我在另一台设备上删了这台的凭据,回来一进设置页,标记被清掉 —— 但锁还开着。
  test("存的凭据在服务端已不存在 → 进设置页清掉标记,锁不跟着关", async ({ page, addAuth }) => {
    await addAuth();
    await gotoHydrated(page, "/settings");
    await page.getByRole("switch", { name: autoLockToggle }).click();
    await expect(page.getByRole("switch", { name: autoLockToggle })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    // 模拟「别的设备把它删了」:本地标记指向一条服务端没有的凭据。那边的删除动作管不到这里的
    // localStorage,所以只能靠本页进来时比对一次。
    await page.evaluate(() =>
      localStorage.setItem("folio_lock_device_passkey", "cred-that-no-longer-exists"),
    );
    await page.reload();

    // 先等自纠真的落地,再看开关 —— 顺序要紧:挂载首帧 useIdleTimeout 还没读到 localStorage
    // (SSR 安全,首帧恒关),此时的 false 是初始态,先断言开关会读到一个还没结论的值。
    await expect.poll(async () => (await readLockState(page)).deviceCredential).toBeNull();
    // **锁保持开着**:凭据记录过期不代表用户要撤掉锁,而且解锁看的是系统钥匙串、不是这个标记。
    await expect(page.getByRole("switch", { name: autoLockToggle })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  // 用例 21:我有两个账号,登录页选 passkey 时能分清哪条是哪个账号。
  //
  // 系统的凭据选择弹窗在浏览器 UI 里,Playwright 看不见 —— 但它显示的名字来自服务端下发的
  // `user.name`,所以在这一层断言就够:它必须能标识**账号**,不能是「Chrome on macOS」这种设备名。
  // (better-auth 的 addPasskey({ name }) 同时喂了这两处,传设备名进去两个账号就长得一样了。)
  //
  // 实测下发的是**邮箱**(better-auth 那边取的不是我们在注册表单里填的昵称),这对目的来说更好 ——
  // 邮箱天然唯一,两个账号并排列出来一眼能分。
  test("注册选项里的 userName 标识账号,不是设备", async ({ page, addAuth }) => {
    await addAuth();
    const user = await signUpAndLogin(page);
    await dismissPasskeyPrompt(page);
    await page.goto("/settings");

    const optionsPromise = page.waitForResponse((r) =>
      r.url().includes("/passkey/generate-register-options"),
    );
    await page.getByRole("button", { name: /add passkey/i }).click();
    const body = await (await optionsPromise).json();

    expect(body.user?.name).toBe(user.email);
    expect(body.user?.name).not.toMatch(/chrome|safari|macos|windows|android/i);
    // 设备名仍要落在列表上(供人辨认是哪台机器加的),只是走事后改名那条路。
    await expect(page.getByText(/passkey added/i)).toBeVisible();
    await expect(page.getByText(/chrome|chromium/i).first()).toBeVisible();
  });
});

// 删除走二次确认。列表行的删除图标和弹层里的确认按钮**同名**(都是 Remove),所以确认按钮靠
// destructive 变体定位 —— 弹层里只有它是这个样式。
async function confirmRemoval(page: import("@playwright/test").Page) {
  await expect(page.getByText(/remove passkey\?/i)).toBeVisible();
  await page.locator("button.bg-destructive").click();
  await expect(page.getByText(/passkey removed/i)).toBeVisible();
}

/**
 * 造出「两行 passkey,其中一条是本机的」。
 *
 * **需要两个认证器**:同一个认证器上一个账户只能有一条凭据(better-auth 注册带 excludeCredentials,
 * 浏览器直接拒),所以在一个认证器上点两次加号只会得到一条。真实世界里也是这样 —— 同一个 iCloud
 * 钥匙串就是一个认证器,「列表里有多条」意味着多台设备 / 多个钥匙串。
 *
 * 顺序也讲究:先用平台认证器开锁(这条带 badge),再插 USB 钥匙走加号(平台那条已被 exclude,
 * 所以只有 USB 收得下这次注册)。
 */
async function addTwoRows(page: import("@playwright/test").Page, addAuth: AddAuth) {
  await addAuth();
  await gotoHydrated(page, "/settings");

  await page.getByRole("switch", { name: autoLockToggle }).click();
  await expect(page.getByRole("switch", { name: autoLockToggle })).toHaveAttribute(
    "aria-checked",
    "true",
  );

  await addAuth({ transport: "usb", hasResidentKey: false });
  await page.getByRole("button", { name: /add passkey/i }).click();
  await expect(page.getByText(/passkey added/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /^remove$/i })).toHaveCount(2);
}

// 「一行」不按 DOM 层级去数 —— SharedLayoutBg 会额外包一层 z-10 div,数层级一改布局就断。改成按
// 「同时含删除按钮 + 含/不含 badge」收窄,再取最深的那个,布局怎么包都还认得出来。
function rowWithBadge(page: import("@playwright/test").Page) {
  return page
    .locator("div")
    .filter({ has: page.getByRole("button", { name: /^remove$/i }) })
    .filter({ has: page.getByText(/^this device$/i) })
    .last();
}

function rowWithoutBadge(page: import("@playwright/test").Page) {
  return page
    .locator("div")
    .filter({ has: page.getByRole("button", { name: /^remove$/i }) })
    .filter({ hasNotText: /this device/i })
    .last();
}

async function removeRowWithBadge(page: import("@playwright/test").Page) {
  await rowWithBadge(page)
    .getByRole("button", { name: /^remove$/i })
    .click();
  await confirmRemoval(page);
}

async function removeRowWithoutBadge(page: import("@playwright/test").Page) {
  await rowWithoutBadge(page)
    .getByRole("button", { name: /^remove$/i })
    .click();
  await confirmRemoval(page);
}
