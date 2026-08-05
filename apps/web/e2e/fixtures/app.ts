import { expect, type Page } from "@playwright/test";

// 闲置锁的全部状态都在这几个 localStorage 键上(单一源见 src/lib/idle-lock.ts 与
// hooks/use-idle-lock.ts)。测试直接读写它们,而不是每条都先从 UI 把开关点一遍 —— 「怎么开起来的」
// 本身是另外几条测试的主题,混进来只会让失败原因变糊。
export const KEYS = {
  timeout: "folio_lock_timeout",
  enabled: "folio_lock_enabled",
  deviceCredential: "folio_lock_device_passkey",
  lastActive: "folio_lock_last_active",
  locked: "folio_lock_locked",
  promptDismissed: "folio_passkey_prompt_dismissed",
} as const;

export interface TestUser {
  email: string;
  password: string;
  name: string;
}

/**
 * 导航到某页,并等到客户端**真的活了**再返回。
 *
 * 为什么需要:CI 跑的是构建产物,页面画得极快 —— `goto` 返回时 DOM 已经在了,但 React 可能还没挂上
 * handler。这时候的点击会被**静静吞掉**(不报错、不生效),测试要到几行之后的断言才炸,报错位置离
 * 真正的原因隔着好几步。CI 上实测偶发,约 1/40,两条不同的测试都中过。
 *
 * 等法是「等该出现的东西」而不是等一段时长:每页都有一个**只可能由客户端发出**的请求,收到它就证明
 * 那棵树已经在跑了。登录页是 passkey 的 conditional-UI autofill(见 login.tsx),设置页是 passkeys
 * 列表。不用 `networkidle`:那要额外等 500ms 静默,乘上几十次导航,纯亏。
 */
const HYDRATION_PROBE = {
  "/login": "passkey/generate-authenticate-options",
  "/settings": "passkey/list-user-passkeys",
} as const;

export async function gotoHydrated(page: Page, path: keyof typeof HYDRATION_PROBE) {
  const probe = page.waitForResponse((r) => r.url().includes(HYDRATION_PROBE[path]));
  await page.goto(path);
  await probe;
}

/**
 * 造一个测试用户并登录(better-auth 配了 autoSignIn,注册即拿到会话 cookie)。
 *
 * 走 HTTP 而不是 UI:登录表单本身有自己的测试,这里只是要一个「已登录」的起点。email 每次随机,
 * 所以同一个本地 D1 上反复跑不会撞唯一约束。
 */
export async function signUpAndLogin(page: Page, overrides: Partial<TestUser> = {}) {
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const user: TestUser = {
    email: overrides.email ?? `e2e-${suffix}@folio.test`,
    password: overrides.password ?? "e2e-password-1234",
    name: overrides.name ?? `E2E ${suffix}`,
  };

  // 得先落在同源页面上,fetch 才带对 Origin(better-auth 有 CSRF 校验)。
  await page.goto("/login");
  const status = await page.evaluate(async (u) => {
    const res = await fetch("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: u.email, password: u.password, name: u.name }),
    });
    return { ok: res.ok, status: res.status, body: res.ok ? "" : await res.text() };
  }, user);
  expect(status.ok, `sign-up failed: ${status.status} ${status.body}`).toBe(true);

  return user;
}

/** 直接写锁状态,省掉「先把开关点开」的前戏。 */
export async function setLockState(
  page: Page,
  state: { enabled?: boolean; timeoutMinutes?: number; deviceCredential?: string | null },
) {
  await page.evaluate(
    ({ keys, state }) => {
      if (state.enabled === true) localStorage.setItem(keys.enabled, "1");
      if (state.enabled === false) localStorage.removeItem(keys.enabled);
      if (state.timeoutMinutes != null)
        localStorage.setItem(keys.timeout, String(state.timeoutMinutes));
      if (state.deviceCredential === null) localStorage.removeItem(keys.deviceCredential);
      else if (state.deviceCredential != null)
        localStorage.setItem(keys.deviceCredential, state.deviceCredential);
    },
    { keys: KEYS, state },
  );
}

export async function readLockState(page: Page) {
  return page.evaluate(
    (keys) => ({
      enabled: localStorage.getItem(keys.enabled),
      timeout: localStorage.getItem(keys.timeout),
      deviceCredential: localStorage.getItem(keys.deviceCredential),
      locked: localStorage.getItem(keys.locked),
    }),
    KEYS,
  );
}

/**
 * 把「最后活跃」推到过去,让下一次闲置检查立刻判超时。
 *
 * 比真等 60 秒可靠得多,而且判据本身(shouldLock)是纯函数、已有单测 —— 这里要验的是「时间到了
 * 遮罩会不会真的盖上来」,不是算术。
 */
export async function travelPastIdle(page: Page, minutes: number) {
  await page.evaluate(
    ({ keys, ms }) => {
      localStorage.setItem(keys.lastActive, String(Date.now() - ms));
    },
    { keys: KEYS, ms: minutes * 60_000 + 5_000 },
  );
}

/** 关掉登录后那个「加个 passkey 吧」的引导,免得它挡住后续断言。 */
export async function dismissPasskeyPrompt(page: Page) {
  await page.evaluate((keys) => localStorage.setItem(keys.promptDismissed, "1"), KEYS);
}

/**
 * 从零到「锁已开启」:建用户 → 关掉引导 → 拨开开关跑完真 ceremony。
 *
 * 调用方得先自己 addAuth() —— 认证器是什么类型(平台 / USB / 无生物识别)常常就是测试的题目本身,
 * 不能塞进来替它决定。
 */
export async function enableLock(page: Page) {
  await signUpAndLogin(page);
  await dismissPasskeyPrompt(page);
  // 这里必须等 hydration:下一行的点击要是被吞掉,整条测试从起点就是假的(见 gotoHydrated)。
  await gotoHydrated(page, "/settings");
  const toggle = page.getByRole("switch", { name: /auto-lock/i });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
}

/** 把页面推进锁屏态(改「最后活跃」+ 重载触发比对),并等锁屏真的出现。 */
export async function lockNow(page: Page, timeoutMinutes = 15) {
  await travelPastIdle(page, timeoutMinutes);
  await page.reload();
  await expect(page.getByRole("button", { name: /unlock with passkey/i })).toBeVisible();
}
