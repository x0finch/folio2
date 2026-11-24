import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Enqueued } from "@/lib/server/jobs/queue";
import { db } from "./_kit/db";
import { freshUser } from "./_kit/user";

// Worker entry shells (`src/server.ts`): fetch adds `private, no-store` when the response declares no cache policy and rethrows errors;
// scheduled branches on the cron expression (daily: per-user jobs only; otherwise a full sweep), pokes the runner after enqueueing,
// surfaces enqueue failures via the waitUntil rejection but still pokes, and a poke failure never masks a successful enqueue.
// The TanStack handler and the runner DO are replaced by test doubles.

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
        // Record how many were enqueued at poke time: the poke is a final check after enqueueing.
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

/** Runs one scheduled event and returns how the waitUntil promise settled. */
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
  it("daily cron: enqueues prune-notes + catalogue per user, no sync; pokes the runner after", async () => {
    const out = await runCron(DAILY);

    expect(out.status).toBe("fulfilled");
    expect(jobsFor(USER).sort()).toEqual(["catalogue", "prune-notes"]);
    expect(pokes).toBe(1);
    expect(sentAtPoke).toBe(sent.length);
  });

  it("other crons: full sweep -- one sync-account per account plus per-user price / reference jobs; pokes again", async () => {
    const out = await runCron(HOURLY);

    expect(out.status).toBe("fulfilled");
    const kinds = jobsFor(USER);
    expect(kinds.filter((k) => k === "sync-account")).toHaveLength(1);
    expect(kinds).toContain("prices");
    expect(kinds).not.toContain("prune-notes");
    expect(pokes).toBe(1);
  });

  it("enqueue failure -> the waitUntil promise rejects (visible) but the runner is still poked", async () => {
    failEnqueue = true;
    const out = await runCron(DAILY);

    expect(out.status).toBe("rejected");
    expect(pokes).toBe(1);
  });

  it("poke failure -> does not mask a successful enqueue, the run still counts as success", async () => {
    failPoke = true;
    const out = await runCron(DAILY);

    expect(out.status).toBe("fulfilled");
    expect(jobsFor(USER).sort()).toEqual(["catalogue", "prune-notes"]);
  });
});

describe("fetch", () => {
  const call = (req: Request) =>
    (worker as unknown as { fetch: (r: Request) => Promise<Response> }).fetch(req);

  it("response without a cache policy -> adds private, no-store and Vary: cookie, body and status untouched", async () => {
    inner.fetch = async () => new Response("page", { status: 201 });
    const res = await call(new Request("http://localhost/x"));

    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("vary")).toContain("cookie");
    expect(await res.text()).toBe("page");
  });

  it("declares its own cache policy -> passed through as is", async () => {
    inner.fetch = async () =>
      new Response("logo", { headers: { "cache-control": "public, max-age=60" } });
    const res = await call(new Request("http://localhost/logo"));
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
  });

  it("inner throws -> rethrown as is, never swallowed into a 200", async () => {
    inner.fetch = async () => {
      throw new Error("ssr blew up");
    };
    await expect(call(new Request("http://localhost/boom?secret=1"))).rejects.toThrow(
      "ssr blew up",
    );
  });
});
