import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

async function load(running: string | null = "v1.0.0-3-gabc123"): Promise<SW> {
  vi.resetModules();
  vi.stubGlobal("__APP_VERSION__", running ?? undefined);
  const sw = await import("@/lib/pwa/service-worker");
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
  it("live version differs from the running one: new version available", async () => {
    const sw = await load();
    deploy("v1.1.0-0-gdef456");
    expect(await sw.checkForUpdate()).toBe(true);
  });

  it("same version: none", async () => {
    const sw = await load("v1.0.0-3-gabc123");
    deploy("v1.0.0-3-gabc123");
    expect(await sw.checkForUpdate()).toBe(false);
  });

  it("each probe carries a unique param to bypass the edge cache and skips the browser cache", async () => {
    const sw = await load();
    deploy("v1.0.0-3-gabc123");
    await sw.checkForUpdate();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/^\/sw\.js\?_=\d+$/);
    expect(init).toEqual({ cache: "no-store" });
  });

  it("live version unreachable (non-2xx / offline): silently treated as none, no throw", async () => {
    const sw = await load();
    deploy(null);
    expect(await sw.checkForUpdate()).toBe(false);
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await sw.checkForUpdate()).toBe(false);
  });

  it("dev / no injected version: never reports a new version", async () => {
    const sw = await load(null);
    deploy("v9.9.9");
    expect(await sw.checkForUpdate()).toBe(false);
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
  it("new version found while running: prompts once; same version again does not repeat; a newer one prompts again", async () => {
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

  it("new version found before mounting: prompts on mount", async () => {
    const sw = await load();
    deploy("v1.1.0");
    await sw.checkForUpdate();
    mountToastHook(sw);
    expect(toastMessage).toHaveBeenCalledTimes(1);
  });

  it("settings page already prompted for this version: the automatic path does not prompt again", async () => {
    const sw = await load();
    deploy("v1.1.0");
    await sw.checkForUpdate();
    sw.showUpdateToast({ available: "a", update: "u" });
    mountToastHook(sw);
    expect(toastMessage).toHaveBeenCalledTimes(1);
  });

  it("no prompt after unmount", async () => {
    const sw = await load();
    const view = mountToastHook(sw);
    view.unmount();
    deploy("v1.1.0");
    await sw.checkForUpdate();
    expect(toastMessage).not.toHaveBeenCalled();
  });
});

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

describe('clicking "Update"', () => {
  it("shows the updating state, lets the waiting worker take over, then reloads once", async () => {
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
    expect(update).toHaveBeenCalled();
    sw.showUpdateToast({ available: "a", update: "u" });
    act(() => clickUpdate());
    expect(seen.at(-1)).toBe(true);
    await act(() =>
      vi.waitFor(() => expect(waiting.postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" })),
    );
    expect(reload).not.toHaveBeenCalled();

    container.emit("controllerchange");
    container.emit("controllerchange");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("no waiting worker: reloads directly (network-first fetches the latest), repeated clicks reload once", async () => {
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
  it("non-production build does nothing", async () => {
    const container = fakeServiceWorker({});
    const sw = await load();
    sw.registerServiceWorker()();
    expect(container.register).not.toHaveBeenCalled();
  });

  it("browser without SW support: does nothing, no throw", async () => {
    vi.stubEnv("PROD", true);
    const sw = await load();
    expect(() => sw.registerServiceWorker()()).not.toThrow();
  });

  it("registers /sw.js (module, bypasses the HTTP cache); registration failure is silent", async () => {
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

  it("probes every 30 minutes and on return to foreground; stops after cleanup", async () => {
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

  it("controllerchange no longer triggers a reload after cleanup", async () => {
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
