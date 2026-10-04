import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 运行中发新版的提示流(ADR 0051):比线上 sw.js 的版本号与本次加载的版本 → 有新版亮常驻 toast
// (同一版本只弹一次,换更新的版本再弹;设置页手动弹过的,自动那路不再补);点「更新」先亮
// 「更新中」再让 waiting 新版接管或直接刷新;定时 / 回到前台各探一次;拿不到线上版本时静默。
// 替换的只有边界:fetch、navigator.serviceWorker、location.reload、toast 出口与文案。

const { toastMessage } = vi.hoisted(() => ({ toastMessage: vi.fn() }));
vi.mock("@folio/ui", async (orig) => ({
  ...(await orig<typeof import("@folio/ui")>()),
  toast: { message: toastMessage },
}));
vi.mock("use-intl", () => ({ useTranslations: () => (k: string) => k }));

type SW = typeof import("@/lib/pwa/service-worker");

const swSource = (ver: string) => `// @sw-build ${ver}\nself.addEventListener("fetch", () => {});`;
const fetchMock = vi.fn();

function deploy(ver: string | null) {
  fetchMock.mockImplementation(async () =>
    ver == null ? new Response("nope", { status: 503 }) : new Response(swSource(ver)),
  );
}

// 模块里存着「已探到 / 已提示过哪个版本」—— 每个用例从新加载开始。
async function load(running: string | null = "v1.0.0-3-gabc123"): Promise<SW> {
  vi.resetModules();
  vi.stubGlobal("__APP_VERSION__", running ?? undefined);
  const sw = await import("@/lib/pwa/service-worker");
  // 注册留下的 document / SW 监听会跨用例存活,统一在 afterEach 里拆掉。
  const register = sw.registerServiceWorker;
  return {
    ...sw,
    registerServiceWorker: () => {
      const cleanup = register();
      cleanups.push(cleanup);
      return cleanup;
    },
  };
}

const cleanups: (() => void)[] = [];

let reload: ReturnType<typeof vi.fn>;

beforeEach(() => {
  toastMessage.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  reload = vi.fn();
  vi.stubGlobal("location", { reload });
});

afterEach(() => {
  for (const c of cleanups.splice(0)) c();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  Reflect.deleteProperty(navigator, "serviceWorker");
});

describe("checkForUpdate", () => {
  it("线上版本与当前在跑的不同 → 有新版", async () => {
    const sw = await load();
    deploy("v1.1.0-0-gdef456");
    expect(await sw.checkForUpdate()).toBe(true);
  });

  it("同版本 → 没有", async () => {
    const sw = await load("v1.0.0-3-gabc123");
    deploy("v1.0.0-3-gabc123");
    expect(await sw.checkForUpdate()).toBe(false);
  });

  it("每次带唯一参数绕过边缘缓存,并且不吃浏览器缓存", async () => {
    const sw = await load();
    deploy("v1.0.0-3-gabc123");
    await sw.checkForUpdate();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/^\/sw\.js\?_=\d+$/);
    expect(init).toEqual({ cache: "no-store" });
  });

  it("拿不到线上版本(非 2xx / 断网)→ 静默当作没有,不抛", async () => {
    const sw = await load();
    deploy(null);
    expect(await sw.checkForUpdate()).toBe(false);
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await sw.checkForUpdate()).toBe(false);
  });

  it("dev / 未注入版本时永不报新版", async () => {
    const sw = await load(null);
    deploy("v9.9.9");
    expect(await sw.checkForUpdate()).toBe(false);
  });
});

describe("showUpdateToast", () => {
  it("常驻、固定 id,描述行是去掉 hash 的新版本号", async () => {
    const sw = await load();
    deploy("v1.1.0-2-gdef456");
    await sw.checkForUpdate();
    sw.showUpdateToast({ available: "有新版本", update: "更新" });
    expect(toastMessage).toHaveBeenCalledWith(
      "有新版本",
      expect.objectContaining({
        id: sw.UPDATE_TOAST_ID,
        duration: 0,
        description: "v1.1.0-2",
        action: expect.objectContaining({ label: "更新" }),
      }),
    );
  });

  it("没探到具体版本时省略描述", async () => {
    const sw = await load();
    sw.showUpdateToast({ available: "a", update: "u" });
    expect(toastMessage.mock.calls[0][1].description).toBeUndefined();
  });
});

function mountToastHook(sw: SW) {
  function Probe() {
    sw.useUpdateToast();
    return null;
  }
  return render(<Probe />);
}

describe("useUpdateToast", () => {
  it("运行中探到新版 → 弹一次;同版本再探到不重复弹;更新的版本再弹", async () => {
    const sw = await load();
    mountToastHook(sw);
    expect(toastMessage).not.toHaveBeenCalled();
    deploy("v1.1.0");
    await act(() => sw.checkForUpdate());
    expect(toastMessage).toHaveBeenCalledTimes(1);
    expect(toastMessage.mock.calls[0][0]).toBe("available");
    await act(() => sw.checkForUpdate());
    expect(toastMessage).toHaveBeenCalledTimes(1);
    deploy("v1.2.0");
    await act(() => sw.checkForUpdate());
    expect(toastMessage).toHaveBeenCalledTimes(2);
  });

  it("挂上之前就已探到新版 → 挂上时补弹", async () => {
    const sw = await load();
    deploy("v1.1.0");
    await sw.checkForUpdate();
    mountToastHook(sw);
    expect(toastMessage).toHaveBeenCalledTimes(1);
  });

  it("设置页已经手动弹过这个版本 → 自动那路不再补一发", async () => {
    const sw = await load();
    deploy("v1.1.0");
    await sw.checkForUpdate();
    sw.showUpdateToast({ available: "a", update: "u" });
    mountToastHook(sw);
    expect(toastMessage).toHaveBeenCalledTimes(1);
  });

  it("卸载后不再弹", async () => {
    const sw = await load();
    const view = mountToastHook(sw);
    view.unmount();
    deploy("v1.1.0");
    await sw.checkForUpdate();
    expect(toastMessage).not.toHaveBeenCalled();
  });
});

// 假的 SW 容器:记录事件监听,register 回一个可配置的 registration。
function fakeServiceWorker(registration: Partial<ServiceWorkerRegistration> | Error) {
  const listeners = new Map<string, Set<() => void>>();
  const container = {
    register: vi.fn(async () => {
      if (registration instanceof Error) throw registration;
      return registration;
    }),
    addEventListener: (t: string, l: () => void) => {
      if (!listeners.has(t)) listeners.set(t, new Set());
      listeners.get(t)?.add(l);
    },
    removeEventListener: (t: string, l: () => void) => listeners.get(t)?.delete(l),
    emit: (t: string) => {
      for (const l of listeners.get(t) ?? []) l();
    },
    count: (t: string) => listeners.get(t)?.size ?? 0,
  };
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: container });
  return container;
}

function clickUpdate() {
  const opts = toastMessage.mock.calls.at(-1)?.[1];
  opts.action.onClick();
}

describe("点「更新」", () => {
  it("先亮「更新中」,600ms 后让 waiting 新版接管;接管后刷新一次", async () => {
    vi.stubEnv("PROD", true);
    vi.useFakeTimers();
    const waiting = { postMessage: vi.fn() };
    const update = vi.fn(async () => undefined);
    const container = fakeServiceWorker({ waiting, update } as never);
    const sw = await load();
    sw.registerServiceWorker();
    await vi.advanceTimersByTimeAsync(0);

    const seen: boolean[] = [];
    function Splash() {
      seen.push(sw.useSplashUpdating());
      return null;
    }
    render(<Splash />);
    expect(seen.at(-1)).toBe(false);

    deploy("v1.1.0");
    expect(await sw.checkForUpdate()).toBe(true);
    expect(update).toHaveBeenCalled(); // 顺手让新版在后台装成 waiting
    sw.showUpdateToast({ available: "a", update: "u" });
    act(() => clickUpdate());
    expect(seen.at(-1)).toBe(true);
    // 「更新中」至少露 600ms 再切,免得文案一闪看不到。
    await act(() => vi.advanceTimersByTimeAsync(599));
    expect(waiting.postMessage).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" });
    expect(reload).not.toHaveBeenCalled();

    container.emit("controllerchange");
    container.emit("controllerchange");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("没有 waiting 的新版 → 直接刷新(联网 network-first 一样拿到最新),重复点只刷一次", async () => {
    vi.useFakeTimers();
    const sw = await load();
    sw.showUpdateToast({ available: "a", update: "u" });
    clickUpdate();
    await vi.advanceTimersByTimeAsync(600);
    expect(reload).toHaveBeenCalledTimes(1);
    clickUpdate();
    await vi.advanceTimersByTimeAsync(600);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("registerServiceWorker", () => {
  it("非生产构建什么都不做", async () => {
    const container = fakeServiceWorker({});
    const sw = await load();
    sw.registerServiceWorker()();
    expect(container.register).not.toHaveBeenCalled();
  });

  it("浏览器不支持 SW → 什么都不做,不抛", async () => {
    vi.stubEnv("PROD", true);
    const sw = await load();
    expect(() => sw.registerServiceWorker()()).not.toThrow();
  });

  it("注册 /sw.js(module、不吃 HTTP 缓存);注册失败静默", async () => {
    vi.stubEnv("PROD", true);
    const container = fakeServiceWorker(new Error("denied"));
    const sw = await load();
    sw.registerServiceWorker();
    await Promise.resolve();
    expect(container.register).toHaveBeenCalledWith("/sw.js", {
      type: "module",
      updateViaCache: "none",
    });
  });

  it("每 30 分钟探一次,回到前台也探一次;清理后都停", async () => {
    vi.stubEnv("PROD", true);
    vi.useFakeTimers();
    fakeServiceWorker({});
    deploy("v1.0.0-3-gabc123");
    const sw = await load();
    const cleanup = sw.registerServiceWorker();

    await vi.advanceTimersByTimeAsync(30 * 60 * 1000 - 1);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    cleanup();
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    Reflect.deleteProperty(document, "visibilityState");
  });

  it("清理后 controllerchange 不再触发刷新", async () => {
    vi.stubEnv("PROD", true);
    const container = fakeServiceWorker({});
    const sw = await load();
    const cleanup = sw.registerServiceWorker();
    expect(container.count("controllerchange")).toBe(1);
    cleanup();
    container.emit("controllerchange");
    expect(reload).not.toHaveBeenCalled();
  });
});
