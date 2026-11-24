import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Enqueued } from "@/lib/server/jobs/queue";
import { Route as ExportRoute } from "@/routes/api/export";
import { Route as ImportRoute } from "@/routes/api/import";
import { Route as SyncRoute } from "@/routes/api/sync";
import { db } from "./_kit/db";
import { appRequest, type SignedIn, signUp } from "./_kit/session";

// HTTP contract of the `/api/export`, `/api/import`, `/api/sync` route handlers (not server fns): no login -> 401 and nothing happens;
// identity comes only from the session cookie (real better-auth session, see `_kit/session.ts`) and data is isolated per user;
// import outcomes map to 200 / 400 / 500 and an exported file imports into another user's empty DB;
// sync opens a round, hands jobs to the runner and returns the round's current state, with repeat POSTs not stacking a second round.
// The runner Durable Object has no binding in the test Worker, so a fake binding collects the jobs (this Worker's egress, like the fake fetch).

type Handler = (ctx: { request: Request }) => Promise<Response>;
const handler = (route: unknown, method: "GET" | "POST"): Handler =>
  (route as { options: { server: { handlers: Record<string, Handler> } } }).options.server.handlers[
    method
  ] as Handler;

const exportGet = handler(ExportRoute, "GET");
const importPost = handler(ImportRoute, "POST");
const syncPost = handler(SyncRoute, "POST");

// -- fake runner binding --
let sent: Enqueued[] = [];
const runnerEnv = env as unknown as { JOB_RUNNER?: unknown };
beforeEach(() => {
  sent = [];
  runnerEnv.JOB_RUNNER = {
    idFromName: (name: string) => name,
    get: () => ({
      enqueue: async (batch: Enqueued[]) => void sent.push(...batch),
      poke: async () => {},
    }),
  };
});
afterEach(() => {
  delete runnerEnv.JOB_RUNNER;
});

const ndjson = (records: unknown[]) => records.map((r) => `${JSON.stringify(r)}\n`).join("");

/** Splits text into small chunks for the stream: lines span chunks and the last line has no newline, as in real uploads. */
const chunkedBody = (text: string, size = 7): ReadableStream<Uint8Array> => {
  const bytes = new TextEncoder().encode(text);
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(at, at + size));
      at += size;
    },
  });
};

const exportOf = async (who: SignedIn): Promise<string> => {
  const res = await exportGet({ request: appRequest("/api/export", {}, who) });
  return new TextDecoder().decode(await res.arrayBuffer());
};

let alice: SignedIn;
let bob: SignedIn;
beforeEach(async () => {
  alice = await signUp("api-routes-alice@example.test");
  bob = await signUp("api-routes-bob@example.test");
});

describe("not logged in", () => {
  it("all three endpoints return 401 and touch nobody's data", async () => {
    await db(alice.userId).accounts.create({ connectorId: "manual", label: "A", creds: null });
    const body = ndjson([{ type: "meta", version: 3 }]);

    const res = await Promise.all([
      exportGet({ request: appRequest("/api/export") }),
      importPost({ request: appRequest("/api/import", { method: "POST", body }) }),
      syncPost({ request: appRequest("/api/sync", { method: "POST", body: "{}" }) }),
    ]);

    expect(res.map((r) => r.status)).toEqual([401, 401, 401]);
    expect(sent).toEqual([]);
  });

  it("a forged cookie doesn't count as logged in", async () => {
    const forged = { userId: alice.userId, cookie: "better-auth.session_token=forged.sig" };
    const res = await exportGet({ request: appRequest("/api/export", {}, forged) });
    expect(res.status).toBe(401);
  });
});

describe("GET /api/export", () => {
  it("returns an NDJSON attachment containing only the caller's accounts", async () => {
    await db(alice.userId).accounts.create({
      connectorId: "manual",
      label: "Alice Cash",
      creds: null,
    });
    await db(bob.userId).accounts.create({ connectorId: "manual", label: "Bob Cash", creds: null });

    const res = await exportGet({ request: appRequest("/api/export", {}, alice) });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    const lines = new TextDecoder()
      .decode(await res.arrayBuffer())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { type: string; label?: string });
    expect(lines[0]?.type).toBe("meta");
    expect(lines.filter((l) => l.type === "account").map((l) => l.label)).toEqual(["Alice Cash"]);
  });
});

describe("POST /api/import", () => {
  it("a file exported by someone else imports into my empty DB: counts returned, rows land under me, the original owner is unaffected", async () => {
    await db(alice.userId).accounts.create({ connectorId: "manual", label: "Cash", creds: null });
    await db(alice.userId).accounts.create({
      connectorId: "evm",
      platform: "evm:1",
      label: "Wallet",
      creds: JSON.stringify({ address: "0xabc" }),
    });
    const file = await exportOf(alice);

    const res = await importPost({
      request: appRequest(
        "/api/import",
        // Strip the trailing newline: the last line is only picked up by the parse after the stream ends.
        { method: "POST", body: chunkedBody(file.trimEnd()) },
        bob,
      ),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      imported: { tokens: 0, accounts: 2, snapshots: 0, activities: 0 },
    });
    const mine = await db(bob.userId).accounts.list();
    expect(mine.map((a) => a.label).sort()).toEqual(["Cash", "Wallet"]);
    // Public fields (address) carry over per the real field spec, so an imported wallet syncs without re-entry.
    const wallet = mine.find((a) => a.label === "Wallet");
    expect(
      JSON.parse((await db(bob.userId).accounts.getRawCreds(wallet?.id ?? "")) ?? "{}"),
    ).toEqual({ address: "0xabc" });
    expect((await db(alice.userId).accounts.list()).map((a) => a.label).sort()).toEqual([
      "Cash",
      "Wallet",
    ]);
  });

  it("bad file header -> 400 with the reason, nothing written", async () => {
    const body = ndjson([{ type: "account", id: "a1", connectorId: "manual", label: "X" }]);
    const res = await importPost({
      request: appRequest("/api/import", { method: "POST", body }, bob),
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("missing meta header");
    expect(await db(bob.userId).accounts.list()).toEqual([]);
  });

  it("bad version -> 400", async () => {
    const res = await importPost({
      request: appRequest(
        "/api/import",
        { method: "POST", body: ndjson([{ type: "meta", version: 999 }]) },
        bob,
      ),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("unsupported export version");
  });

  it("the DB write step blows up (bad snapshot) -> 500, internal error not returned to the client", async () => {
    const file = await exportOf(alice);
    const meta = file.split("\n")[0];
    const body = [
      meta,
      JSON.stringify({ type: "account", id: "a1", connectorId: "manual", label: "M" }),
      JSON.stringify({
        type: "snapshot",
        accountId: "a1",
        takenAt: "not-a-time",
        totalUsd: 1,
        balances: [],
      }),
    ].join("\n");

    const res = await importPost({
      request: appRequest("/api/import", { method: "POST", body }, bob),
    });

    expect(res.status).toBe(500);
    expect(await res.text()).toBe("import failed");
  });

  it("no request body -> 400", async () => {
    const res = await importPost({
      request: appRequest("/api/import", { method: "POST" }, bob),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/sync", () => {
  const seedWallet = (who: SignedIn) =>
    db(who.userId).accounts.create({
      connectorId: "evm",
      platform: "evm:1",
      label: "Wallet",
      creds: JSON.stringify({ address: "0xabc" }),
    });

  it("opens a round: returns the round's current state (uncacheable), one sync job per own account", async () => {
    const wallet = await seedWallet(alice);
    await seedWallet(bob);

    // A bad JSON body falls back to the default (default portfolio, manual full), not a 400.
    const res = await syncPost({
      request: appRequest("/api/sync", { method: "POST", body: "{not json" }, alice),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const view = (await res.json()) as {
      state: string;
      total: number;
      statuses: Record<string, string>;
    };
    expect(view.state).toBe("running");
    expect(view.statuses).toEqual({ [wallet.id]: "pending" });
    const syncJobs = sent.filter((m) => m.job.kind === "sync-account");
    expect(syncJobs).toHaveLength(1);
    expect(syncJobs[0]?.job).toMatchObject({ userId: alice.userId, accountId: wallet.id });
  });

  it("clicking again while the round is still running -> returns that round as is, no second batch of jobs", async () => {
    await seedWallet(alice);
    const first = await syncPost({
      request: appRequest("/api/sync", { method: "POST", body: "{}" }, alice),
    });
    const before = sent.length;

    const second = await syncPost({
      request: appRequest("/api/sync", { method: "POST", body: "{}" }, alice),
    });

    expect(second.status).toBe(200);
    const [a, b] = (await Promise.all([first.json(), second.json()])) as { roundId: string }[];
    expect(b?.roundId).toBe(a?.roundId);
    expect(sent.length).toBe(before);
  });
});
