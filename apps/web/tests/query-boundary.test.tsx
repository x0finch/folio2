import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryBoundary } from "@/components/query-boundary";
import { RETRY } from "@/lib/queries/constants";

function Boom(): never {
  throw new Error("boom");
}

let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => errorSpy.mockRestore());

describe("QueryBoundary", () => {
  it("subtree throws: shows the failed state instead of collapsing the whole block", () => {
    render(
      <QueryBoundary resetKey="a" pending="…" failed={<p>拉取失败</p>}>
        <Boom />
      </QueryBoundary>,
    );

    expect(screen.getByText("拉取失败")).toBeTruthy();
  });

  it("resetKey changed (e.g. a Tab target changed): failed state resets, fetches again", () => {
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

  it("resetKey unchanged: failed state is kept (until the self-heal timer fires)", () => {
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

  it("fails on first mount: retries by itself when due, subtree grows back once healthy", async () => {
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

  it("logs one line on catch: render exceptions also land here, without a trace they could never be investigated", () => {
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
