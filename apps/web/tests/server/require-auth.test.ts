import { AsyncLocalStorage } from "node:async_hooks";
import { configure, type LogRecord, reset } from "@logtape/logtape";
import { Effect } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runEffect } from "@/lib/server/runtime";
import { requireAuth } from "@/lib/server/session/require-auth";
import { signUp } from "./_kit/session";

// Guard middleware for every server fn touching private data: no session -> 401 and the handler never runs;
// with a session, downstream sees only that user's id (from the real better-auth session, never from input);
// downstream throws propagate, with an error log carrying the userId and the span-named Cause.
// The harness has no TanStack Start request context, so only the "read this request's headers" hook is replaced.

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
  it("no session -> throws a 401 Response, downstream does not run", async () => {
    const next = vi.fn<Next>();
    const caught = await guard({ next }).catch((e: unknown) => e);

    expect(caught).toBeInstanceOf(Response);
    expect((caught as Response).status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("session -> downstream gets this user's userId and its result is returned", async () => {
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

  it("downstream throws -> rethrown as is, with an error log carrying the userId", async () => {
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

  it("downstream Effect failure -> log has the handler span name, not just the outer message", async () => {
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
