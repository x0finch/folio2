import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// 全量同步的进度**不再走 toast**(FOL-32 裁定 1),它是一份可订阅的 state,由同步面板渲染。
// 所以这个文件断言的是 `round`:分子怎么涨、失败什么时候进清单、整轮挂了那句话留不留得住。
// (toast 只剩账户详情里的单账户同步在用,那一处不经这个 hook。)

const { useAccountSync } = await import("@/lib/hooks/use-account-sync");
const { syncKeys } = await import("@/lib/queries/keys");

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

// 每个用例一个新的组合 id:round 住在**模块级** store 里(轮中切页不丢那条修法),跨用例不会自己
// 清空 —— 复用同一个 id 的话,上一条用例的失败清单会漂进下一条的初始断言里。
let n = 0;
let PORTFOLIO: string;

const setup = (accounts = ACCOUNTS, portfolioId?: string) =>
  renderHook(({ accounts: a, pf }) => useAccountSync(a, pf), {
    wrapper,
    initialProps: { accounts, pf: portfolioId ?? PORTFOLIO },
  });

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
    // retry: false —— mutation 失败就是失败,别让默认重试把「失败该进 round.error」这条测糊了。
    client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    refreshes = 0;
    PORTFOLIO = `pf-${++n}`;
    vi.unstubAllGlobals();
  });

  it("没在跑 → round 是空的", () => {
    const { result } = setup();
    expect(result.current.busy).toBe(false);
    expect(result.current.round).toEqual({
      done: 0,
      total: 0,
      skipped: 0,
      current: null,
      failures: [],
      error: null,
    });
  });

  it("全部成功 → done 走到 total,current 是展示名(服务端只回 accountId)", async () => {
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

    result.current.sync();
    await waitFor(() => expect(result.current.busy).toBe(false));

    expect(result.current.round.done).toBe(2);
    expect(result.current.round.total).toBe(2);
    expect(result.current.round.current).toBe("Ledger");
    expect(result.current.round.failures).toEqual([]);
    expect(result.current.round.error).toBeNull();
  });

  it("开跑那一刻分母就位、分子归零(上一轮的失败一并清掉)", async () => {
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

    const { result } = setup();
    result.current.sync();

    // 一条结果都还没到:分母已经是这一轮的条数,分子还是 0 —— 面板据此显示「打底 / 全部来源」。
    await waitFor(() => expect(result.current.busy).toBe(true));
    expect(result.current.round.total).toBe(2);
    expect(result.current.round.done).toBe(0);

    push?.({ accountId: "a1", ok: true });
    // 每完成一个就推进一次,不是收工才一次性报。
    await waitFor(() => expect(result.current.round.done).toBe(1));
    expect(result.current.round.current).toBe("Binance");

    push?.({ accountId: "a2", ok: true });
    close?.();
    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(result.current.round.done).toBe(2);
  });

  it("失败逐条进清单,带展示名;缺凭据(skipped)不算失败", async () => {
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

    expect(result.current.round.failures).toEqual([
      { accountId: "a1", label: "Binance", error: "bad key" },
    ]);
    // 两个账户都处理完了 —— skipped 也算处理完,只是不算失败。
    expect(result.current.round.done).toBe(2);
    // 但要单独计数:面板的合成分子得把它刨掉(它没产出快照,summary.ok 不计它)。
    expect(result.current.round.skipped).toBe(1);
  });

  it("用户级失败({ fatal })→ 进 round.error,且照样刷新(服务端可能还在跑)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ndjsonResponse([{ fatal: "listAccounts blew up" }])),
    );
    client.setQueryData([...syncKeys.status(PORTFOLIO)], { total: 1 });
    const { result } = setup();
    result.current.sync();
    await waitFor(() => expect(result.current.busy).toBe(false));

    expect(result.current.round.error).toContain("listAccounts blew up");
    // 关键:失败路径也要刷新 —— 部分账户的快照可能已经落库了。
    await waitFor(() =>
      expect(client.getQueryState([...syncKeys.status(PORTFOLIO)])?.isInvalidated).toBe(true),
    );
  });

  it("请求本身挂了 → 那句话留在 round.error 上(busy 落回后它还在)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const { result } = setup();
    result.current.sync();
    await waitFor(() => expect(result.current.busy).toBe(false));

    expect(result.current.round.error).toContain("network down");
  });

  it("下一轮开跑会把上一轮的失败清掉", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ndjsonResponse([{ accountId: "a1", ok: false, error: "bad key" }])),
    );
    const { result } = setup();
    result.current.sync();
    await waitFor(() => expect(result.current.round.failures).toHaveLength(1));
    // 等上一轮真的收工再点:sync() 对在飞的一轮是早退的,不等的话第二下会被自己的防重拦掉。
    await waitFor(() => expect(result.current.busy).toBe(false));

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ndjsonResponse([{ accountId: "a1", ok: true }])),
    );
    result.current.sync();
    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(result.current.round.failures).toEqual([]);
    expect(result.current.round.error).toBeNull();
  });

  it("切组合 → 上一轮的 round 不跟过去;切回来它还在", async () => {
    // A 组合那轮的失败挂在 B 组合的面板上是在说谎:琥珀 pill 对着 B 说 A 的事,
    // 点失败行还会去 focus 一个不在 B 里的账户。
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ndjsonResponse([{ accountId: "a1", ok: false, error: "bad key" }])),
    );
    const { result, rerender } = setup();
    result.current.sync();
    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(result.current.round.failures).toHaveLength(1);

    rerender({ accounts: ACCOUNTS, pf: `${PORTFOLIO}-other` });
    expect(result.current.round).toEqual({
      done: 0,
      total: 0,
      skipped: 0,
      current: null,
      failures: [],
      error: null,
    });

    // 「跨轮保留」保留的是**那个组合自己的**上一轮 —— 切回来失败清单还在。
    rerender({ accounts: ACCOUNTS, pf: PORTFOLIO });
    expect(result.current.round.failures).toHaveLength(1);
  });

  it("两个组合各飞一轮,交错推进 → 各自的 round 互不踩(store 每组合一格)", async () => {
    // busy 的防重按组合 key 拦,只拦**同组合**:A 轮中切到 B 再点同步是允许的,两条 mutation 并飞。
    // store 全局单格时它们会互相整格覆盖 —— B 的面板闪 A 的数、后收工者占格,另一组合的失败清单
    // 静默消失。这条钉住:每组合一格,交错写互不相闻,切到谁读到的都是谁自己的。
    const pfA = `${PORTFOLIO}-a`;
    const pfB = `${PORTFOLIO}-b`;
    const encoder = new TextEncoder();
    const feeds = new Map<string, { push: (line: unknown) => void; close: () => void }>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const { portfolioId } = JSON.parse(String(init.body)) as { portfolioId: string };
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            feeds.set(portfolioId, {
              push: (line) => controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`)),
              close: () => controller.close(),
            });
          },
        });
        return new Response(body, { status: 200 });
      }),
    );

    const { result, rerender } = setup(ACCOUNTS, pfA);
    result.current.sync();
    await waitFor(() => expect(feeds.has(pfA)).toBe(true));
    feeds.get(pfA)?.push({ accountId: "a1", ok: true });
    await waitFor(() => expect(result.current.round.done).toBe(1));

    // A 还在飞,切到 B 开第二轮。
    rerender({ accounts: ACCOUNTS, pf: pfB });
    expect(result.current.round.done).toBe(0); // B 这格还是空的,不是 A 的 1
    result.current.sync();
    await waitFor(() => expect(feeds.has(pfB)).toBe(true));

    // 交错推进:B 先失败一条,A 再完成一条 —— A 的写入不能把 B 的失败抹掉。
    feeds.get(pfB)?.push({ accountId: "a1", ok: false, error: "b boom" });
    await waitFor(() => expect(result.current.round.failures).toHaveLength(1));
    feeds.get(pfA)?.push({ accountId: "a2", ok: true });

    // 看 B:还是 B 自己的(1 done、1 失败),没被 A 的第 2 条冲成 2。
    await waitFor(() => expect(result.current.round.done).toBe(1));
    expect(result.current.round.failures).toEqual([
      { accountId: "a1", label: "Binance", error: "b boom" },
    ]);

    // 切回 A:A 的累计也没被 B 踩 —— 2 条都在,没有失败。
    rerender({ accounts: ACCOUNTS, pf: pfA });
    await waitFor(() => expect(result.current.round.done).toBe(2));
    expect(result.current.round.failures).toEqual([]);

    // 各自收口,互不影响。
    feeds.get(pfB)?.push({ accountId: "a2", ok: true });
    feeds.get(pfA)?.close();
    feeds.get(pfB)?.close();
    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(result.current.round.done).toBe(2);
    rerender({ accounts: ACCOUNTS, pf: pfB });
    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(result.current.round.done).toBe(2);
    expect(result.current.round.failures).toHaveLength(1); // B 的失败清单还在,没被 A 的收工覆盖
  });

  it("轮中换页(卸载 → 新实例)进度不丢,busy 也还亮着", async () => {
    // 老 toast 是全局的,切页进度条还在;round 若住组件 state,这里就是回归。
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

    const first = setup();
    first.result.current.sync();
    await waitFor(() => expect(first.result.current.busy).toBe(true));
    push?.({ accountId: "a1", ok: true });
    await waitFor(() => expect(first.result.current.round.done).toBe(1));

    // 换页:这个实例卸载,新页面挂一个新实例(同一个 QueryClient —— 应用里它是全局的)。
    first.unmount();
    const second = setup();
    // mutation 由 mutationCache 持有,不随组件走;进度从模块级 store 读回来。
    expect(second.result.current.busy).toBe(true);
    expect(second.result.current.round.done).toBe(1);
    expect(second.result.current.round.current).toBe("Binance");

    // 卸载后到达的结果照样写得进去,新实例看得到。
    push?.({ accountId: "a2", ok: false, error: "bad key" });
    await waitFor(() => expect(second.result.current.round.done).toBe(2));
    expect(second.result.current.round.failures).toEqual([
      { accountId: "a2", label: "Ledger", error: "bad key" },
    ]);

    close?.();
    await waitFor(() => expect(second.result.current.busy).toBe(false));
  });

  it("请求体只带当前组合,不带账户名单(作用域在服务端定)", async () => {
    const fetchMock = vi.fn(async () => ndjsonResponse([{ accountId: "a1", ok: true }]));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = setup();

    result.current.sync();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/sync");
    // 这一轮跑哪些账户由服务端按这个组合算 —— 客户端递名单那条路已经没有了(ADR 0047)。
    expect(JSON.parse(String(init.body))).toEqual({ portfolioId: PORTFOLIO });
  });

  it("没有账户 → disabled,点了也不发请求", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { result } = setup([]);
    expect(result.current.disabled).toBe(true);
    result.current.sync();
    await waitFor(() => expect(fetchMock).not.toHaveBeenCalled());
    expect(result.current.round.total).toBe(0);
  });

  it("一轮结束后同步状态被定向刷新", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ndjsonResponse([{ accountId: "a1", ok: true }])),
    );
    // 缓存里先有一份「已经拿到过」的同步状态,才谈得上它有没有被标记为旧。
    client.setQueryData([...syncKeys.status(PORTFOLIO)], { total: 1 });
    const { result } = setup();

    result.current.sync();
    await waitFor(() => expect(result.current.busy).toBe(false));

    await waitFor(() =>
      expect(client.getQueryState([...syncKeys.status(PORTFOLIO)])?.isInvalidated).toBe(true),
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

    client.setQueryData([...syncKeys.status(PORTFOLIO)], { total: 3 });

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
      expect(client.getQueryState([...syncKeys.status(PORTFOLIO)])?.isInvalidated).toBe(true),
    );
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
