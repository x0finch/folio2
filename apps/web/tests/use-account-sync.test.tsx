import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// —— 替身 ——
// toast:记账,并把 id 回给调用方,这样能断言「同一条 toast 被就地改写」而不是叠了好几条。
const toasts: { level: string; text: string; id?: string }[] = [];
let nextToastId = 0;
const toast = {
  loading: (text: string, o?: { id?: string }) => {
    const id = o?.id ?? `t${++nextToastId}`;
    toasts.push({ level: "loading", text, id });
    return id;
  },
  success: (text: string, o?: { id?: string }) => {
    toasts.push({ level: "success", text, id: o?.id });
    return o?.id ?? "";
  },
  error: (text: string, o?: { id?: string }) => {
    toasts.push({ level: "error", text, id: o?.id });
    return o?.id ?? "";
  },
};
vi.mock("@folio/ui", () => ({ toast }));

// 只要 key + 参数能看出来就够,不引真的 i18n。
vi.mock("use-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    `${key}(${JSON.stringify(params ?? {})})`,
}));

const { useAccountSync } = await import("../src/lib/hooks/use-account-sync");
const { syncKeys } = await import("../src/lib/queries/keys");

// NDJSON 响应体:每个对象一行。分片位置故意不落在行边界上 —— 解析器该自己攒 buffer。
function ndjsonResponse(lines: unknown[], { ok = true }: { ok?: boolean } = {}): Response {
  const text = lines.map((l) => `${JSON.stringify(l)}\n`).join("");
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const mid = Math.floor(bytes.length / 2);
      controller.enqueue(bytes.slice(0, mid));
      controller.enqueue(bytes.slice(mid));
      controller.close();
    },
  });
  return new Response(body, { status: ok ? 200 : 500 });
}

// 每个用例一个新的 client。**提到模块级**是为了让用例能回头看缓存里发生了什么
//(定向刷新有没有刷到同步状态)—— 藏在 wrapper 闭包里就够不着了。
let client: QueryClient;

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);

const ACCOUNTS = [
  { id: "a1", label: "Binance" },
  { id: "a2", label: "Ledger" },
];

const setup = (accounts = ACCOUNTS) => renderHook(() => useAccountSync(accounts), { wrapper });

// 数「刷了几次」而不是「invalidateQueries 被调了几次」:一次刷新会按映射表里的前缀数发好几条,
// 只认同步域那一条就等于一次刷新。
let refreshes: number;
const countRefreshes = () => {
  const original = client.invalidateQueries.bind(client);
  vi.spyOn(client, "invalidateQueries").mockImplementation((filters, options) => {
    if (Array.isArray(filters?.queryKey) && filters.queryKey[0] === "sync") refreshes += 1;
    return original(filters, options);
  });
};

describe("useAccountSync", () => {
  beforeEach(() => {
    toasts.length = 0;
    nextToastId = 0;
    // retry: false —— mutation 失败就是失败,别让默认重试把「失败该弹 error」这条测糊了。
    client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    refreshes = 0;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("全部成功 → success,进度 toast 一路复用同一个 id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ndjsonResponse([
          { accountId: "a1", ok: true },
          { accountId: "a2", ok: true },
        ]),
      ),
    );
    const { result } = setup();
    expect(result.current.busy).toBe(false);

    result.current.sync();
    await waitFor(() => expect(result.current.busy).toBe(false));

    const ids = new Set(toasts.map((t) => t.id));
    expect(ids.size).toBe(1); // 一条 toast 被反复改写,不是叠了四条
    expect(toasts.at(-1)?.level).toBe("success");
    expect(toasts.at(-1)?.text).toContain("synced");
    // 中间至少有一次进度更新带上了刚完成那个账户的展示名(服务端只回 accountId)。
    expect(toasts.some((t) => t.level === "loading" && t.text.includes("Binance"))).toBe(true);
  });

  it("有账户失败 → error,详情里是展示名不是 id;缺凭据(skipped)不算失败", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ndjsonResponse([
          { accountId: "a1", ok: false, error: "bad key" },
          { accountId: "a2", ok: false, skipped: true },
        ]),
      ),
    );
    const { result } = setup();
    result.current.sync();
    await waitFor(() => expect(result.current.busy).toBe(false));

    const last = toasts.at(-1);
    expect(last?.level).toBe("error");
    expect(last?.text).toContain("Binance: bad key");
    expect(last?.text).not.toContain("Ledger"); // skipped 不进失败清单
    expect(last?.text).toContain('"count":1'); // 1 个失败,不是 2
  });

  it("用户级失败({ fatal })→ error,且照样刷新(服务端可能还在跑)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ndjsonResponse([{ fatal: "listAccounts blew up" }])),
    );
    client.setQueryData([...syncKeys.status()], { total: 1 });
    const { result } = setup();
    result.current.sync();
    await waitFor(() => expect(result.current.busy).toBe(false));

    expect(toasts.at(-1)?.level).toBe("error");
    expect(toasts.at(-1)?.text).toContain("listAccounts blew up");
    // 关键:失败路径也要刷新 —— 部分账户的快照可能已经落库了。
    await waitFor(() =>
      expect(client.getQueryState([...syncKeys.status()])?.isInvalidated).toBe(true),
    );
  });

  it("请求本身挂了 → error 就地改写那条 loading,不另起一条", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const { result } = setup();
    result.current.sync();
    await waitFor(() => expect(result.current.busy).toBe(false));

    expect(new Set(toasts.map((t) => t.id)).size).toBe(1);
    expect(toasts.at(-1)?.level).toBe("error");
    expect(toasts.at(-1)?.text).toContain("network down");
  });

  it("没有账户 → disabled,点了也不发请求", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { result } = setup([]);
    expect(result.current.disabled).toBe(true);
    result.current.sync();
    await waitFor(() => expect(fetchMock).not.toHaveBeenCalled());
    expect(toasts).toHaveLength(0);
  });

  it("一轮结束后同步状态被定向刷新", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ndjsonResponse([{ accountId: "a1", ok: true }])),
    );
    // 缓存里先有一份「已经拿到过」的同步状态,才谈得上它有没有被标记为旧。
    client.setQueryData([...syncKeys.status()], { total: 1 });
    const { result } = setup();

    result.current.sync();
    await waitFor(() => expect(result.current.busy).toBe(false));

    await waitFor(() =>
      expect(client.getQueryState([...syncKeys.status()])?.isInvalidated).toBe(true),
    );
  });

  it("第一个账户到达就刷过一次 —— 不等整轮跑完", async () => {
    // 这里只钉「先完成的先出现」这一句:第一个账户的结果一到,leading 就同步触发了一次刷新。
    //
    // **另一句承诺(扎堆到达不许变成刷新风暴)不在这里测。** 它的正确性取决于 400ms 窗口,
    // 而这个文件跑的是真实时钟:一旦 CI 负载让下面几个 push 之间隔了 400ms 以上,
    // 后面的账户就各自变成新的 leading,断言随机变红 —— 那是在测机器有多快,不是在测代码。
    // 窗口行为已经在 refresh-throttle.test.ts 里用假时钟逐条钉死(连发合并、跨窗口分批、
    // flush 不重复补),这里再断言一次次数只会引入不确定性。CODING.md:别断言墙钟。
    countRefreshes();
    let push: ((line: unknown) => void) | undefined;
    let close: (() => void) | undefined;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (line) => controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
        close = () => controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 200 })),
    );

    client.setQueryData([...syncKeys.status()], { total: 3 });

    const { result } = setup([
      { id: "a1", label: "Binance" },
      { id: "a2", label: "Ledger" },
      { id: "a3", label: "OKX" },
    ]);
    result.current.sync();

    await waitFor(() => expect(push).toBeDefined());
    push?.({ accountId: "a1", ok: true });
    // 关键:**还没等整轮跑完**就已经刷过一次了。以前这里是 0。
    await waitFor(() => expect(refreshes).toBeGreaterThanOrEqual(1));

    push?.({ accountId: "a2", ok: true });
    push?.({ accountId: "a3", ok: true });
    close?.();
    await waitFor(() => expect(result.current.busy).toBe(false));

    // 最后一个账户的结果一定落地:收工那一下要么是尾随、要么已经由 leading 覆盖。
    await waitFor(() =>
      expect(client.getQueryState([...syncKeys.status()])?.isInvalidated).toBe(true),
    );
  });

  // 下拉刷新那个组件会 `await onRefresh()` 再决定什么时候收回指示器(片10)。
  // 拿即发即忘的 `sync` 喂给它,回调会**立刻** resolve —— 指示器先收回、下一帧因为 refreshing
  // 变真又弹出来,表现成可见的抖一下。所以那条路必须用「等这一轮真结束」的变体。
  it("syncAsync 等这一轮真的结束才 resolve(下拉刷新的指示器靠它才不抖)", async () => {
    let releaseFetch: (() => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await new Promise<void>((resolve) => {
          releaseFetch = resolve;
        });
        return ndjsonResponse([{ accountId: "a1" }, { accountId: "a2" }, { done: true }]);
      }),
    );
    const { result } = setup();

    let settled = false;
    const pending = result.current.syncAsync().then(() => {
      settled = true;
    });

    // 请求还挂着 → 一定还没 resolve。
    await waitFor(() => expect(result.current.busy).toBe(true));
    expect(settled).toBe(false);

    releaseFetch?.();
    await pending;
    expect(settled).toBe(true);
    // 这时候「在飞」已经落下去了 —— 指示器可以放心收回。
    await waitFor(() => expect(result.current.busy).toBe(false));
  });

  it("syncAsync 在失败时也 resolve(错误已经由 toast 报过,别让调用方再 catch 一遍)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );
    const { result } = setup();
    await expect(result.current.syncAsync()).resolves.toBeUndefined();
    expect(toasts.some((t) => t.level === "error")).toBe(true);
  });

  it("没有账户 → syncAsync 直接 resolve、不发请求", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { result } = setup([]);
    await result.current.syncAsync();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("在飞期间 busy 为 true,且重复点不会再发一次", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const fetchMock = vi.fn(async () => {
      await gate;
      return ndjsonResponse([{ accountId: "a1", ok: true }]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = setup();
    result.current.sync();
    await waitFor(() => expect(result.current.busy).toBe(true));

    result.current.sync(); // 在飞时再点
    expect(fetchMock).toHaveBeenCalledTimes(1);

    release?.();
    await waitFor(() => expect(result.current.busy).toBe(false));
  });
});
