import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { IntlProvider } from "use-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { messages } from "../src/lib/i18n/messages";

// 闲置锁与 passkey 的联动(#353)。这里覆盖**不需要真 WebAuthn** 的那一半:调用参数对不对、
// 成功/失败各写了什么、删对了才关锁。真 ceremony 能不能过、userVerification: "required" 是否
// 真被强制,得靠 CDP 虚拟认证器的 E2E —— 那条单独立项(#354)。
//
// 路由模块在**模块加载期**就跑 createFileRoute + import server fn(`cloudflare:workers` 在
// jsdom 下解析不了),故先 mock 掉 server 那层,再 import 组件。
const { addPasskey, deletePasskey, listUserPasskeys, updatePasskey, signInPasskey, toastError } =
  vi.hoisted(() => ({
    addPasskey: vi.fn(),
    deletePasskey: vi.fn(),
    listUserPasskeys: vi.fn(),
    updatePasskey: vi.fn(),
    signInPasskey: vi.fn(),
    toastError: vi.fn(),
  }));

vi.mock("../src/lib/server/settings", () => ({
  getDataStats: vi.fn(),
  getProviderKeyStatus: vi.fn(),
  getValuationSettings: vi.fn(),
  updateValuationSettings: vi.fn(),
}));
vi.mock("../src/lib/import-data", () => ({ importData: vi.fn() }));
vi.mock("../src/lib/auth-client", () => ({
  authClient: { passkey: { addPasskey, deletePasskey, listUserPasskeys, updatePasskey } },
  signOut: vi.fn(),
  signIn: { passkey: signInPasskey, email: vi.fn() },
}));
// 只替换 toast(要断言错误文案),其余 @folio/ui 组件保持真实渲染。
vi.mock("@folio/ui", async (orig) => ({
  ...(await orig<object>()),
  toast: { error: toastError, success: vi.fn() },
}));

const { AutoLockCard, PasskeysCard } = await import("../src/routes/_authed/settings");

const DEVICE_KEY = "folio_lock_device_passkey";
const TIMEOUT_KEY = "folio_lock_timeout";
const ENABLED_KEY = "folio_lock_enabled";

// 行主键与 credentialID **刻意不同**:删除接口收的是主键,本机标记存的是 credentialID,
// 两者混用的话下面几条断言就会互相掩盖。
const row = (cred: string, name: string) => ({
  id: `dbrow_${cred}`,
  credentialID: cred,
  name,
  createdAt: new Date(0).toISOString(),
  aaguid: null,
  backedUp: true,
  transports: "internal",
});

function mount(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages.en} timeZone="UTC" now={new Date(0)}>
        {node}
      </IntlProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  listUserPasskeys.mockResolvedValue({ data: [] });
  // registerPasskey 注册成功后会补写设备名 → 不给它一个 thenable 就会在 .catch 上炸。
  updatePasskey.mockResolvedValue({ data: {} });
  // PasskeysCard 用 usePasskeySupport() 决定露不露入口,而 jsdom 没有 PublicKeyCredential →
  // 不 stub 的话列表整个不渲染,测的就成了「不支持」那条分支。
  vi.stubGlobal("PublicKeyCredential", class {});
});

// 拨开关即走 ceremony —— 不再有二次确认弹窗(系统自己的指纹弹窗已经把「要验一下」说清楚了)。
const toggle = (utils: ReturnType<typeof mount>) =>
  fireEvent.click(utils.getByRole("switch", { name: /auto-lock/i }));

describe("AutoLockCard 开关与启用前置", () => {
  it("关着 → 时长行灰化且不可点", () => {
    const { container } = mount(<AutoLockCard />);
    const gate = container.querySelector('[aria-disabled="true"]');
    expect(gate).not.toBeNull();
    expect(gate?.className).toContain("pointer-events-none");
  });

  // 这条是整套方案的安全关键:不限定 platform,系统就会给「用其他设备」的二维码,别人扫一下
  // 就能让注册通过,而新凭据落在**他的**钥匙串里 —— 这台设备照样解不开锁。
  it("首次拨开 → 直接注册,且必须限定本机认证器(authenticatorAttachment: platform)", async () => {
    addPasskey.mockResolvedValue({ data: row("cred_new", "这台") });
    const utils = mount(<AutoLockCard />);
    toggle(utils);
    await waitFor(() => expect(addPasskey).toHaveBeenCalled());
    expect(addPasskey.mock.calls[0]?.[0]).toMatchObject({ authenticatorAttachment: "platform" });
  });

  // better-auth 的 addPasskey({ name }) 把这个 name 同时当成 WebAuthn 的 userName,而那是系统钥匙串
  // 里显示的**账户名**。传设备名进去,一个人的两个 folio 账号在同一台机器上加了 passkey 后,登录页
  // 点「用 passkey 登录」时系统列出的两条就都叫「Chrome on macOS」,分不清谁是谁。所以注册时不传,
  // 事后单独改名。
  it("注册时不传 name(否则系统钥匙串会把设备名当账户名),事后补写设备名", async () => {
    addPasskey.mockResolvedValue({ data: row("cred_new", "这台") });
    const utils = mount(<AutoLockCard />);
    toggle(utils);
    await waitFor(() => expect(updatePasskey).toHaveBeenCalled());
    expect(addPasskey.mock.calls[0]?.[0]).not.toHaveProperty("name");
    // 改名收的是行主键,而且名字得是设备标签(jsdom 的 UA 里带 Mozilla/5.0 → 至少不为空)。
    const arg = updatePasskey.mock.calls[0]?.[0];
    expect(arg?.id).toBe("dbrow_cred_new");
    expect(typeof arg?.name).toBe("string");
    expect(arg?.name.length).toBeGreaterThan(0);
  });

  it("改名失败不算注册失败 —— 凭据已经建好了", async () => {
    addPasskey.mockResolvedValue({ data: row("cred_new", "这台") });
    updatePasskey.mockRejectedValue(new Error("network"));
    const utils = mount(<AutoLockCard />);
    toggle(utils);
    await waitFor(() => expect(localStorage.getItem(DEVICE_KEY)).toBe("cred_new"));
    expect(localStorage.getItem(ENABLED_KEY)).not.toBeNull();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("启用成功 → 存的是 credentialID(不是行主键、也不是布尔),开关置开", async () => {
    addPasskey.mockResolvedValue({ data: row("cred_new", "这台") });
    const utils = mount(<AutoLockCard />);
    toggle(utils);
    await waitFor(() => expect(localStorage.getItem(DEVICE_KEY)).toBe("cred_new"));
    expect(localStorage.getItem(ENABLED_KEY)).not.toBeNull();
  });

  it("启用失败(用户取消 ceremony / 本机没有生物识别)→ 不写标记,开关维持关闭", async () => {
    addPasskey.mockResolvedValue({ error: { message: "cancelled" } });
    const utils = mount(<AutoLockCard />);
    toggle(utils);
    await waitFor(() => expect(addPasskey).toHaveBeenCalled());
    expect(localStorage.getItem(DEVICE_KEY)).toBeNull();
    expect(localStorage.getItem(ENABLED_KEY)).toBeNull();
    expect(signInPasskey).not.toHaveBeenCalled(); // 不是「已存在」就别去验证
  });

  // 本机钥匙串里已有这个账户的凭据 → excludeCredentials 让重复注册被浏览器拒。同一个 iCloud 下
  // Mac 与 iPhone 共享钥匙串,所以这是换设备打开开关的**常规**路径,不是边角情况。
  // 拒绝本身就是证词「本机有一条可用凭据」,而 assertion 回的 id 就是这台设备实际用掉的那条。
  const PREVIOUSLY = {
    error: { code: "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED", message: "already" },
  };

  it("撞上「已注册过」→ 转验证一次,记下实际用掉的那条凭据", async () => {
    addPasskey.mockResolvedValue(PREVIOUSLY);
    signInPasskey.mockResolvedValue({
      data: {},
      webauthn: { response: { id: "cred_used" } },
    });
    const utils = mount(<AutoLockCard />);
    toggle(utils);
    await waitFor(() => expect(localStorage.getItem(DEVICE_KEY)).toBe("cred_used"));
    expect(localStorage.getItem(ENABLED_KEY)).not.toBeNull();
    expect(toastError).not.toHaveBeenCalled();
    // returnWebAuthnResponse 是唯一能拿到 credentialID 的口子 —— 少了它 usedId 永远是 undefined。
    expect(signInPasskey.mock.calls[0]?.[0]).toMatchObject({ returnWebAuthnResponse: true });
  });

  it("验证也被取消 → 不写标记,开关维持关闭", async () => {
    addPasskey.mockResolvedValue(PREVIOUSLY);
    signInPasskey.mockResolvedValue({ data: null, error: { message: "cancelled" } });
    const utils = mount(<AutoLockCard />);
    toggle(utils);
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(localStorage.getItem(DEVICE_KEY)).toBeNull();
    expect(localStorage.getItem(ENABLED_KEY)).toBeNull();
  });

  // 登录满一天后注册一律 403(better-auth freshAge 默认 1 天,而我们的 session 活 7 天)——
  // 注册连 ceremony 都没跑到就被拒,所以走验证:既刷新了 session,又拿到了本机那条的 id。
  it("session 过了新鲜期 → 同样转验证一次,不把用户堵在报错上", async () => {
    addPasskey.mockResolvedValue({
      error: { code: "SESSION_NOT_FRESH", message: "Session is not fresh" },
    });
    signInPasskey.mockResolvedValue({ data: {}, webauthn: { response: { id: "cred_used" } } });
    const utils = mount(<AutoLockCard />);
    toggle(utils);
    await waitFor(() => expect(localStorage.getItem(DEVICE_KEY)).toBe("cred_used"));
    expect(localStorage.getItem(ENABLED_KEY)).not.toBeNull();
    expect(toastError).not.toHaveBeenCalled();
  });

  // 关掉再打开不该重新验证 —— 凭据还在这台设备的钥匙串里,没有理由再按一次指纹。
  it("已有本机凭据时拨开 → 直接开,不碰任何 ceremony", async () => {
    localStorage.setItem(DEVICE_KEY, "cred_local");
    listUserPasskeys.mockResolvedValue({ data: [row("cred_local", "这台")] });
    const utils = mount(<AutoLockCard />);
    await waitFor(() => expect(listUserPasskeys).toHaveBeenCalled());
    toggle(utils);
    await waitFor(() => expect(localStorage.getItem(ENABLED_KEY)).not.toBeNull());
    expect(addPasskey).not.toHaveBeenCalled();
    expect(signInPasskey).not.toHaveBeenCalled();
  });

  it("关掉 → 只清开关,本机凭据与时长都留着", async () => {
    localStorage.setItem(DEVICE_KEY, "cred_local");
    localStorage.setItem(ENABLED_KEY, "1");
    localStorage.setItem(TIMEOUT_KEY, "5");
    listUserPasskeys.mockResolvedValue({ data: [row("cred_local", "这台")] });
    const utils = mount(<AutoLockCard />);
    await waitFor(() => expect(listUserPasskeys).toHaveBeenCalled());
    toggle(utils);
    await waitFor(() => expect(localStorage.getItem(ENABLED_KEY)).toBeNull());
    expect(localStorage.getItem(DEVICE_KEY)).toBe("cred_local");
    expect(localStorage.getItem(TIMEOUT_KEY)).toBe("5");
    expect(deletePasskey).not.toHaveBeenCalled(); // 关开关不删凭据
  });

  // 本机那条可能在**别的设备**上被删掉 —— 那边的删除动作管不到这里的 localStorage。
  // 于是标记还在、锁还开着,却已经没有凭据可解。进设置页时比对一次即自纠。
  it("存的凭据已不在账户列表里 → 清标记并关掉开关", async () => {
    localStorage.setItem(DEVICE_KEY, "cred_gone");
    localStorage.setItem(ENABLED_KEY, "1");
    listUserPasskeys.mockResolvedValue({ data: [row("cred_other", "别的设备")] });
    mount(<AutoLockCard />);
    await waitFor(() => expect(localStorage.getItem(DEVICE_KEY)).toBeNull());
    expect(localStorage.getItem(ENABLED_KEY)).toBeNull();
  });

  it("存的凭据还在列表里 → 保持就绪,不误清", async () => {
    localStorage.setItem(DEVICE_KEY, "cred_local");
    localStorage.setItem(ENABLED_KEY, "1");
    localStorage.setItem(TIMEOUT_KEY, "15");
    listUserPasskeys.mockResolvedValue({ data: [row("cred_local", "这台")] });
    mount(<AutoLockCard />);
    await waitFor(() => expect(listUserPasskeys).toHaveBeenCalled());
    expect(localStorage.getItem(DEVICE_KEY)).toBe("cred_local");
    expect(localStorage.getItem(ENABLED_KEY)).not.toBeNull();
    expect(localStorage.getItem(TIMEOUT_KEY)).toBe("15");
  });
});

describe("PasskeysCard 添加入口", () => {
  const clickAdd = (utils: ReturnType<typeof mount>) =>
    fireEvent.click(utils.getByRole("button", { name: /add passkey/i }));

  // 与自动锁定那条**刻意不同**:这里不限 authenticatorAttachment,硬件安全钥匙和扫码都允许 ——
  // 只要能登录就有用。这是安全钥匙在整个应用里唯一的添加入口。
  it("加号添加不限认证器类型(不传 authenticatorAttachment)", async () => {
    addPasskey.mockResolvedValue({ data: row("cred_key", "安全钥匙") });
    const utils = mount(<PasskeysCard />);
    clickAdd(utils);
    await waitFor(() => expect(addPasskey).toHaveBeenCalled());
    expect(addPasskey.mock.calls[0]?.[0]).not.toHaveProperty("authenticatorAttachment");
  });

  // 也正因为凭据不一定在本机,这条路**不能**写本机标记 —— 那个标记的含义是「这台设备能解锁」。
  it("加号添加不写本机标记、不打开闲置锁", async () => {
    addPasskey.mockResolvedValue({ data: row("cred_key", "安全钥匙") });
    const utils = mount(<PasskeysCard />);
    clickAdd(utils);
    await waitFor(() => expect(addPasskey).toHaveBeenCalled());
    expect(localStorage.getItem(DEVICE_KEY)).toBeNull();
    expect(localStorage.getItem(ENABLED_KEY)).toBeNull();
  });

  it("加号添加失败 → 报错文案", async () => {
    addPasskey.mockResolvedValue({ error: { message: "cancelled" } });
    const utils = mount(<PasskeysCard />);
    clickAdd(utils);
    await waitFor(() => expect(toastError).toHaveBeenCalled());
  });

  const NOT_FRESH = { error: { code: "SESSION_NOT_FRESH", message: "Session is not fresh" } };

  // 这条路要的是真注册(可能是安全钥匙),所以不能拿验证的结果顶替 —— 验证只用来刷新 session,
  // 之后必须把注册重跑一遍。
  it("session 过了新鲜期 → 先验证刷新,再重试注册", async () => {
    addPasskey.mockResolvedValueOnce(NOT_FRESH).mockResolvedValueOnce({
      data: row("cred_key", "安全钥匙"),
    });
    signInPasskey.mockResolvedValue({ data: {} });
    const utils = mount(<PasskeysCard />);
    clickAdd(utils);
    await waitFor(() => expect(addPasskey).toHaveBeenCalledTimes(2));
    expect(signInPasskey).toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    expect(localStorage.getItem(DEVICE_KEY)).toBeNull(); // 这条路照旧不写本机标记
  });

  it("session 过期且验证也不成(账户没有任何 passkey)→ 让用户重新登录", async () => {
    addPasskey.mockResolvedValue(NOT_FRESH);
    signInPasskey.mockResolvedValue({ data: null, error: { message: "no credentials" } });
    const utils = mount(<PasskeysCard />);
    clickAdd(utils);
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(toastError.mock.calls[0]?.[0]).toMatch(/sign in again/i);
    expect(addPasskey).toHaveBeenCalledTimes(1); // 验证没过就别白跑第二次注册
  });
});

describe("PasskeysCard 与闲置锁的联动", () => {
  // 删除走二次确认:先点行尾的删除图标,再点弹层里的确认按钮。
  // 两者的可访问名都是「Remove」(图标用 aria-label,确认按钮用同一条文案),故确认按钮靠
  // variant=destructive 的样式定位 —— 弹层里只有它是这个变体。
  async function removeFirstRow(utils: ReturnType<typeof mount>) {
    const trash = utils.getAllByRole("button", { name: /remove/i })[0];
    if (!trash) throw new Error("no remove button");
    fireEvent.click(trash);
    await utils.findByText(/remove passkey\?/i); // 弹层已挂
    const confirm = [...utils.container.ownerDocument.querySelectorAll("button")].find((b) =>
      b.className.includes("bg-destructive"),
    );
    if (!confirm) throw new Error("no confirm button");
    fireEvent.click(confirm);
  }

  it("「这台设备」badge 只出现在 credentialID 匹配的那条上", async () => {
    localStorage.setItem(DEVICE_KEY, "cred_local");
    listUserPasskeys.mockResolvedValue({
      data: [row("cred_local", "这台"), row("cred_other", "别的")],
    });
    const { findAllByText, getAllByText } = mount(<PasskeysCard />);
    await findAllByText("这台");
    expect(getAllByText(/this device/i)).toHaveLength(1);
  });

  it("删掉的正是本机那条 → 清标记 + 关掉开关(时长不动)", async () => {
    localStorage.setItem(DEVICE_KEY, "cred_local");
    localStorage.setItem(ENABLED_KEY, "1");
    localStorage.setItem(TIMEOUT_KEY, "15");
    listUserPasskeys.mockResolvedValue({ data: [row("cred_local", "这台")] });
    deletePasskey.mockResolvedValue({ data: {} });
    const utils = mount(<PasskeysCard />);
    await utils.findByText("这台");
    await removeFirstRow(utils);
    // 删除接口收的是行主键,不是 credentialID。
    await waitFor(() => expect(deletePasskey).toHaveBeenCalledWith({ id: "dbrow_cred_local" }));
    await waitFor(() => expect(localStorage.getItem(DEVICE_KEY)).toBeNull());
    expect(localStorage.getItem(ENABLED_KEY)).toBeNull();
    expect(localStorage.getItem(TIMEOUT_KEY)).toBe("15"); // 时长是偏好,不该被清
  });

  // 反面同样重要:删条无关的凭据不该把锁关掉。早先用布尔标记时做不到这种区分,只能退而用
  // 「删光了才关」;而「删任何一条都清」会让人白验一次(重复注册被拒 → 又要走验证)。
  it("删掉的是别的凭据 → 标记与开关都不动", async () => {
    localStorage.setItem(DEVICE_KEY, "cred_local");
    localStorage.setItem(ENABLED_KEY, "1");
    listUserPasskeys.mockResolvedValue({ data: [row("cred_other", "别的")] });
    deletePasskey.mockResolvedValue({ data: {} });
    const utils = mount(<PasskeysCard />);
    await utils.findByText("别的");
    await removeFirstRow(utils);
    await waitFor(() => expect(deletePasskey).toHaveBeenCalledWith({ id: "dbrow_cred_other" }));
    expect(localStorage.getItem(DEVICE_KEY)).toBe("cred_local");
    expect(localStorage.getItem(ENABLED_KEY)).not.toBeNull();
  });
});
