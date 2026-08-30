import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 价格 SWR 的客户端半边(`useStalePriceRefresh`):loader 已用**旧价**渲染,这里在 settle 后踢一次
// 批量刷价,确有刷新 → 定向失效余额读路径 → **二次展示新价**。这条「先旧后新」是 FOL-44 里唯一
// 没法用 e2e 验的验收项(没有 HTTP 路径能把库里价格行改旧来触发 stale),所以压在这层 hook 测。
//
// 两个 import 都得 mock:`refreshStalePrices` 是 server fn(import 链通到 cloudflare:workers,
// vitest 不剥离);`invalidateFor` 只想断言「有没有、带什么参数被调」,不想真跑失效。
vi.mock("@/lib/server/prices", () => ({ refreshStalePrices: vi.fn() }));
vi.mock("@/lib/queries/refresh", () => ({ invalidateFor: vi.fn() }));

const { refreshStalePrices } = await import("@/lib/server/prices");
const { invalidateFor } = await import("@/lib/queries/refresh");
const { useStalePriceRefresh } = await import("@/lib/hooks/use-stale-price-refresh");

const refresh = vi.mocked(refreshStalePrices);
const invalidate = vi.mocked(invalidateFor);

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("useStalePriceRefresh", () => {
  beforeEach(() => {
    refresh.mockReset();
    invalidate.mockReset();
  });
  afterEach(() => vi.clearAllMocks());

  it("价过期且已 settle → 踢一次刷价", async () => {
    refresh.mockResolvedValue({ refreshed: 3 });
    renderHook(() => useStalePriceRefresh(true, true), { wrapper });
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it("确有刷新(refreshed>0)→ 定向失效余额读路径(二次展示新价)", async () => {
    refresh.mockResolvedValue({ refreshed: 2 });
    renderHook(() => useStalePriceRefresh(true, true), { wrapper });
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith(expect.anything(), "prices.refreshed"),
    );
  });

  it("一个都没刷到(refreshed=0)→ 不失效(避免无谓重取)", async () => {
    refresh.mockResolvedValue({ refreshed: 0 });
    renderHook(() => useStalePriceRefresh(true, true), { wrapper });
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("价不过期 → 根本不踢(旧价即当前,继续用)", async () => {
    renderHook(() => useStalePriceRefresh(false, true), { wrapper });
    // 给微任务一拍机会,证明确实没被异步调起。
    await Promise.resolve();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("还没 settle(ready=false)→ 不踢(别夹在两次读中间刷,第二次会拿到半新半旧)", async () => {
    renderHook(() => useStalePriceRefresh(true, false), { wrapper });
    await Promise.resolve();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("单飞:重渲染仍为过期态也只踢一次", async () => {
    refresh.mockResolvedValue({ refreshed: 1 });
    const { rerender } = renderHook(({ stale }) => useStalePriceRefresh(stale, true), {
      wrapper,
      initialProps: { stale: true },
    });
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    rerender({ stale: true });
    rerender({ stale: true });
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("刷价失败 → 静默,不失效、不抛(旧价仍在,下次进页再试)", async () => {
    refresh.mockRejectedValue(new Error("rate limited"));
    renderHook(() => useStalePriceRefresh(true, true), { wrapper });
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(invalidate).not.toHaveBeenCalled();
  });
});
