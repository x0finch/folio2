import { InvalidInput } from "@folio/db";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { readJson } from "@/lib/core/json-response";
import { runEffectJson } from "@/lib/server/runtime";

// 读接口的「原样 JSON」出口(FOL-92):结果写成一个 JSON `Response`(不经 seroval),
// 浏览器 `readJson` 解回同一个值;失败那条路与 `runEffect` 相同 —— 抛,不造 Response。
describe("runEffectJson", () => {
  const ctx = { data: { n: 2 }, context: { userId: "user-json" } };

  it("成功:JSON Response,解回来的就是 handler 的返回值", async () => {
    const handler = Effect.fn("jsonOk")(function* (data: { n: number }) {
      return yield* Effect.succeed({
        rows: [["a", data.n, null]],
        sampled: true,
        nested: { x: 1.5 },
      });
    });

    const res = await runEffectJson(handler)(ctx);

    expect(res).toBeInstanceOf(Response);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await readJson(res)).toEqual({
      rows: [["a", 2, null]],
      sampled: true,
      nested: { x: 1.5 },
    });
  });

  it("失败:照旧抛(由 Start 序列化成错误),不会造出一个 200", async () => {
    const handler = Effect.fn("jsonFail")(function* (_: { n: number }) {
      return yield* Effect.fail(new InvalidInput({ what: "test", why: "nope" }));
    });

    await expect(runEffectJson(handler)(ctx)).rejects.toThrow();
  });
});
