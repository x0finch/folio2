import { expect, type Page } from "@playwright/test";

// 闲置锁的全部状态都在这几个 localStorage 键上(单一源见 src/lib/idle-lock.ts 与
// hooks/use-idle-lock.ts)。测试直接读写它们,而不是每条都先从 UI 把开关点一遍 —— 「怎么开起来的」
// 本身是另外几条测试的主题,混进来只会让失败原因变糊。
const KEYS = {
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
