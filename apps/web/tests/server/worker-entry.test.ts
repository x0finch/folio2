import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Enqueued } from "@/lib/server/jobs/queue";
import { db } from "./_kit/db";
import { freshUser } from "./_kit/user";

// Worker 入口(`src/server.ts`)的两条外壳:
//   · fetch:TanStack 回的响应**没声明缓存策略就补 private, no-store**(唯一出口上的安全默认),
//     声明了的原样放行;里面抛了照样上抛。
//   · scheduled:按 cron 表达式分支 —— 每天那条只投逐用户的日活,其余是全量 sweep(投同步活);
//     两条都在投完之后**戳一下运行器**;投活失败要可见(waitUntil 的 promise 拒绝),但照戳;
//     戳失败不盖掉一次成功的投递。
// TanStack 那个 app handler 在这套 harness 里没有(只绑 DB,见 wrangler.test.jsonc),换成一个
// 回什么由用例定的替身 —— 被测的是它外面那层,不是它。运行器 DO 没有绑定,换成收活的假绑定(出口)。

const inner = vi.hoisted(() => ({
  fetch: async (_req: Request): Promise<Response> => new Response("ok"),
}));
vi.mock("@tanstack/react-start/server-entry", () => ({
  default: { fetch: (req: Request) => inner.fetch(req) },
  createServerEntry: (entry: unknown) => entry,
}));

const { default: worker } = await import("@/server");

const DAILY = "0 23 * * *";
const HOURLY = "30 * * * *";
const USER = "worker-entry-user";

let sent: Enqueued[];
let pokes: number;
let sentAtPoke: number;
let failEnqueue: boolean;
let failPoke: boolean;
const runnerEnv = env as unknown as { JOB_RUNNER?: unknown };

beforeEach(async () => {
  sent = [];
  pokes = 0;
  sentAtPoke = -1;
  failEnqueue = false;
  failPoke = false;
  runnerEnv.JOB_RUNNER = {
    idFromName: (name: string) => name,
    get: () => ({
      enqueue: async (batch: Enqueued[]) => {
        if (failEnqueue) throw new Error("runner unreachable");
        sent.push(...batch);
      },
      poke: async () => {
        // 记下戳的那一刻已经投了几条:兜底的意思是「投完了再看一眼」。
        pokes += 1;
        sentAtPoke = sent.length;
        if (failPoke) throw new Error("poke refused");
      },
    }),
  };
  await freshUser(USER);
  await db(USER).accounts.create({
    connectorId: "evm",
    platform: "evm:1",
    label: "Wallet",
    creds: JSON.stringify({ address: "0xabc" }),
  });
});

afterEach(() => {
  delete runnerEnv.JOB_RUNNER;
  inner.fetch = async () => new Response("ok");
});

/** 跑一次 scheduled,回 waitUntil 收到的那个 promise 的下场。 */
const runCron = async (cron: string): Promise<PromiseSettledResult<unknown>> => {
  let pending: Promise<unknown> | undefined;
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      pending = p;
    },
  } as ExecutionContext;
  await worker.scheduled(
    { cron, scheduledTime: Date.now(), noRetry: () => {} } as ScheduledController,
    env,
    ctx,
  );
  if (!pending) throw new Error("scheduled() did not hand work to waitUntil");
  const [settled] = await Promise.allSettled([pending]);
  return settled as PromiseSettledResult<unknown>;
};

const jobsFor = (userId: string) =>
  sent.filter((m) => (m.job as { userId?: string }).userId === userId).map((m) => m.job.kind);

describe("scheduled", () => {
  it("每天那条:给每个用户投 prune-notes + catalogue,不投同步;投完戳一下运行器", async () => {
    const out = await runCron(DAILY);

    expect(out.status).toBe("fulfilled");
    expect(jobsFor(USER).sort()).toEqual(["catalogue", "prune-notes"]);
    expect(pokes).toBe(1);
    expect(sentAtPoke).toBe(sent.length);
  });

  it("其余 cron:全量 sweep —— 账户各一条 sync-account 外加逐用户的价 / 参考层活;再戳一下", async () => {
    const out = await runCron(HOURLY);

    expect(out.status).toBe("fulfilled");
    const kinds = jobsFor(USER);
    expect(kinds.filter((k) => k === "sync-account")).toHaveLength(1);
    expect(kinds).toContain("prices");
    expect(kinds).not.toContain("prune-notes");
    expect(pokes).toBe(1);
  });

  it("投活失败 → waitUntil 的那个 promise 拒绝(可见),但运行器照样被戳", async () => {
    failEnqueue = true;
    const out = await runCron(DAILY);

    expect(out.status).toBe("rejected");
    expect(pokes).toBe(1);
  });

  it("戳失败 → 不盖掉已经成功的投递,这一趟仍算成功", async () => {
    failPoke = true;
    const out = await runCron(DAILY);

    expect(out.status).toBe("fulfilled");
    expect(jobsFor(USER).sort()).toEqual(["catalogue", "prune-notes"]);
  });
});

describe("fetch", () => {
  const call = (req: Request) =>
    (worker as unknown as { fetch: (r: Request) => Promise<Response> }).fetch(req);

  it("没声明缓存策略的响应 → 补 private, no-store 与 Vary: cookie,body 与状态原样", async () => {
    inner.fetch = async () => new Response("page", { status: 201 });
    const res = await call(new Request("http://localhost/x"));

    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("vary")).toContain("cookie");
    expect(await res.text()).toBe("page");
  });

  it("自己声明了缓存策略 → 原样放行", async () => {
    inner.fetch = async () =>
      new Response("logo", { headers: { "cache-control": "public, max-age=60" } });
    const res = await call(new Request("http://localhost/logo"));
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
  });

  it("里面抛了 → 原样上抛,不吞成一个 200", async () => {
    inner.fetch = async () => {
      throw new Error("ssr blew up");
    };
    await expect(call(new Request("http://localhost/boom?secret=1"))).rejects.toThrow(
      "ssr blew up",
    );
  });
});
