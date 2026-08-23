import { UpstreamAuthError, UpstreamRateLimitError } from "@folio/client-core";
import { InvalidInput, NotFound } from "@folio/db";
import { Cause, Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import { toError } from "@/lib/server/errors";

// 「一次请求失败了,前端会看到哪句话」—— 全仓只有 `toError` 回答这个问题(#504 T6)。
// 纯函数:不碰 TanStack、不碰 D1,所以这份用例跑在 logic project 里而不是 workers pool。

describe("toError", () => {
  it("上游失败 → 一句带上游名/类别/路径的话,原错误挂 cause", () => {
    const mapped = toError(
      new UpstreamAuthError({ upstream: "binance", where: "/api/v3/account", status: 401 }),
    );
    expect(mapped.message).toBe("binance UpstreamAuthError on /api/v3/account (401)");
    expect(mapped.cause).toBeInstanceOf(UpstreamAuthError);
  });

  it("没有状态码就不硬编一个", () => {
    const mapped = toError(new UpstreamRateLimitError({ upstream: "coingecko", where: "/simple" }));
    expect(mapped.message).toBe("coingecko UpstreamRateLimitError on /simple");
  });

  // 原则 #5 的红线在这一层的样子:`where` 只有 pathname,凭据与 query 一个字都不进这句话。
  it("消息里不带 query、不带 cause 摘要", () => {
    const mapped = toError(
      new UpstreamAuthError({
        upstream: "okx",
        where: "/api/v5/account/balance",
        cause: "signature mismatch for key ABC123",
      }),
    );
    expect(mapped.message).not.toContain("ABC123");
    expect(mapped.message).toBe("okx UpstreamAuthError on /api/v5/account/balance");
  });

  it("NotFound / InvalidInput 原样透传 —— 同一个对象,不重新包一层", () => {
    const notFound = new NotFound({ entity: "account", id: "a1" });
    expect(toError(notFound)).toBe(notFound);
    expect(toError(notFound).message).toBe("account not found: a1");

    const invalid = new InvalidInput({ what: "tag", why: "already pinned" });
    expect(toError(invalid)).toBe(invalid);
    expect(toError(invalid).message).toBe("tag: already pinned");
  });

  it("普通 Error 原样透传", () => {
    const err = new Error("plain");
    expect(toError(err)).toBe(err);
  });
});

// **这条钉的是上面那个「原样透传」的理由,不是它的写法。**
// Effect 把 span 记在**错误对象自己**身上,所以 `mapError` 里新建一个 Error 会把
// `Effect.fn("…")` 那个名字从 `Cause` 里抹掉 —— 而兜底日志(`session/require-auth.ts`)
// 打的正是 `Cause.pretty`。谁哪天「顺手统一成 new Error」,这条会红。
describe("Cause 里留得住 handler 名", () => {
  const failing = Effect.fn("someHandler")(function* () {
    return yield* Effect.fail(new NotFound({ entity: "account", id: "a1" }));
  });

  it("经过 toError 之后仍看得到是哪个 handler", async () => {
    const exit = await Effect.runPromiseExit(failing().pipe(Effect.mapError(toError)));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("someHandler");
  });
});
