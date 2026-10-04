import { AsyncLocalStorage } from "node:async_hooks";
import { configure, type LogRecord, reset } from "@logtape/logtape";
import { Effect } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runEffect } from "@/lib/server/runtime";
import { requireAuth } from "@/lib/server/session/require-auth";
import { signUp } from "./_kit/session";

// server fn 的守卫中间件 `requireAuth`(安全边界本身,每个碰私有数据的 server fn 都挂它):
//   · 没会话 → 401,**下游 handler 一行都不跑**;
//   · 有会话 → 下游拿到的 context 只有那个人的 userId(来自真 better-auth 会话,不来自入参);
//   · 下游抛了 → 原样上抛,并在这里留一条带 userId 的 error;Effect 的失败打出带 span 名的
//     Cause(不只最外那一句 message)。
// 这套 harness 没有 TanStack Start 的请求上下文(workers 池里 import 它的 server 入口就报错),所以只把
// 「读这次请求的 headers」那一个口子换成用例给的 headers;会话本身是真的。

const req = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock("@tanstack/react-start/server", () => ({ getRequestHeaders: () => req.headers }));

type Next = (opts: { context: { userId: string } }) => Promise<unknown>;
const guard = (
  requireAuth as unknown as {
    options: { server: (opts: { next: Next }) => Promise<unknown> };
  }
).options.server;

const records: LogRecord[] = [];
beforeAll(async () => {
  await configure({
    sinks: { mem: (r) => void records.push(r) },
    loggers: [{ category: ["folio"], sinks: ["mem"], lowestLevel: "debug" }],
    contextLocalStorage: new AsyncLocalStorage(),
    reset: true,
  });
});
afterAll(async () => {
  await reset();
});
beforeEach(() => {
  records.length = 0;
  req.headers = new Headers();
});

const errorLogs = () => records.filter((r) => r.level === "error");

describe("requireAuth", () => {
  it("没会话 → 抛 401 Response,下游不跑", async () => {
    const next = vi.fn<Next>();
    const caught = await guard({ next }).catch((e: unknown) => e);

    expect(caught).toBeInstanceOf(Response);
    expect((caught as Response).status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("有会话 → 下游拿到这个人的 userId,回下游的结果", async () => {
    const me = await signUp("require-auth-me@example.test");
    req.headers = new Headers({ cookie: me.cookie });

    const seen: unknown[] = [];
    const out = await guard({
      next: async (opts) => {
        seen.push(opts.context);
        return "handler result";
      },
    });

    expect(out).toBe("handler result");
    expect(seen).toEqual([{ userId: me.userId }]);
    expect(errorLogs()).toEqual([]);
  });

  it("下游抛了 → 原样上抛,留一条带 userId 的 error", async () => {
    const me = await signUp("require-auth-throw@example.test");
    req.headers = new Headers({ cookie: me.cookie });
    const boom = Object.assign(new Error("kaput"), { code: "E_KAPUT" });

    const caught = await guard({
      next: async () => {
        throw boom;
      },
    }).catch((e: unknown) => e);

    expect(caught).toBe(boom);
    const [log] = errorLogs();
    expect(log?.properties).toMatchObject({ userId: me.userId, error: "kaput", code: "E_KAPUT" });
  });

  it("下游是 Effect 的失败 → 日志里有 handler 的 span 名,不只最外那句", async () => {
    const me = await signUp("require-auth-effect@example.test");
    req.headers = new Headers({ cookie: me.cookie });
    const failing = Effect.fn("someNamedHandler")(function* (_: undefined) {
      return yield* Effect.die(new Error("inner"));
    });

    await guard({
      next: (opts) => runEffect(failing)({ data: undefined, context: opts.context }),
    }).catch(() => undefined);

    const [log] = errorLogs().filter((r) => r.rawMessage === "server fn threw");
    expect(String(log?.properties.error)).toContain("someNamedHandler");
  });
});
