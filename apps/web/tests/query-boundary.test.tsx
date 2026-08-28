import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryBoundary } from "@/components/query-boundary";
import { RETRY } from "@/lib/queries/constants";

// `QueryBoundary` 的钉子。它是首页自定义 Tab 那两格的兜底,而**兜底自己出问题是最难发现的一类**:
// 画面上就是一句「拉取失败」,看不出到底是这次真的拉失败了,还是上一次失败之后再也没复位过。

function Boom(): never {
  throw new Error("boom");
}

// class 边界捕获时 React 会往 console.error 打一大段;这里只是不想让它淹没测试输出。
let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => errorSpy.mockRestore());

describe("QueryBoundary", () => {
  it("子树抛错 → 显示失败态,而不是整块塌掉", () => {
    render(
      <QueryBoundary resetKey="a" pending="…" failed={<p>拉取失败</p>}>
        <Boom />
      </QueryBoundary>,
    );

    expect(screen.getByText("拉取失败")).toBeTruthy();
  });

  // 这条是这次修复的核心。原先复位只能靠 `key` 重新挂载,而调用方给的 `key` 是自定义 Tab 的 id ——
  // **改 Tab 目标时那个 id 不变**。于是一次偶发失败之后改指到别的目标,画面还是「拉取失败」,
  // 而且那条查询已经没有观察者了,后续任何 invalidate 都救不回来。
  it("resetKey 变了(比如改了 Tab 目标)→ 失败态复位,重新去拉", () => {
    const { rerender } = render(
      <QueryBoundary resetKey="tag:t1" pending="…" failed={<p>拉取失败</p>}>
        <Boom />
      </QueryBoundary>,
    );
    expect(screen.getByText("拉取失败")).toBeTruthy();

    rerender(
      <QueryBoundary resetKey="tag:t2" pending="…" failed={<p>拉取失败</p>}>
        <p>新目标的内容</p>
      </QueryBoundary>,
    );

    expect(screen.getByText("新目标的内容")).toBeTruthy();
    expect(screen.queryByText("拉取失败")).toBeNull();
  });

  it("resetKey 没变 → 失败态先保持(自愈计时器到点前不动)", () => {
    const { rerender } = render(
      <QueryBoundary resetKey="tag:t1" pending="…" failed={<p>拉取失败</p>}>
        <Boom />
      </QueryBoundary>,
    );

    rerender(
      <QueryBoundary resetKey="tag:t1" pending="…" failed={<p>拉取失败</p>}>
        <p>不该出现</p>
      </QueryBoundary>,
    );

    expect(screen.getByText("拉取失败")).toBeTruthy();
    expect(screen.queryByText("不该出现")).toBeNull();
  });

  // 自愈:塌了之后不用用户做任何事,隔一段自己重挂一次子树。**首次挂载就失败**的那种也要排期
  // (缓存里已经有失败的查询 → 边界全新挂载 → 子树首渲染当场抛),只挂在 update 上会漏掉它。
  it("首次挂载就失败 → 到点自己重试,子树好了就长回来", async () => {
    vi.useFakeTimers();
    let broken = true;
    function Flaky() {
      if (broken) throw new Error("boom");
      return <p>长回来了</p>;
    }
    try {
      render(
        <QueryBoundary resetKey="tag:t1" pending="…" failed={<p>拉取失败</p>}>
          <Flaky />
        </QueryBoundary>,
      );
      expect(screen.getByText("拉取失败")).toBeTruthy();

      broken = false;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(RETRY.selfHeal);
      });
      expect(screen.getByText("长回来了")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("捕获时留一行日志 —— 渲染异常也会落进这里,不留痕就永远查不出来", () => {
    render(
      <QueryBoundary resetKey="tag:t1" pending="…" failed={<p>拉取失败</p>}>
        <Boom />
      </QueryBoundary>,
    );

    const logged = errorSpy.mock.calls.some(
      (args: unknown[]) =>
        typeof args[0] === "string" && args[0].includes("[query-boundary tag:t1]"),
    );
    expect(logged).toBe(true);
  });
});
